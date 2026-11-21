/**
 * Feature rollout guardrails with emergency disablement (#309).
 *
 * Runtime overrides (admin-config.ts) switch a flag fully on or off. This
 * controller adds a staged, percentage-based rollout around that, with
 * guardrails that make an unsafe ramp hard and an emergency stop easy:
 *
 *  - Staged ramp. A rollout moves by at most `maxStepPercent` per change, and
 *    an increase waits `minSoakMs` after the previous change, so each stage is
 *    observed before the next. Decreases (rollbacks) are never limited.
 *  - Health guardrail. Callers report outcomes for flagged code paths with
 *    `recordOutcome`. When the error rate over the recent window exceeds the
 *    threshold (with enough samples to mean something), the kill switch trips
 *    automatically and increases are refused.
 *  - Kill switch. `emergencyDisable` forces the flag to its safe default ahead
 *    of every other source (override, rollout, environment). It needs no
 *    expected version and no capability, so a conflict or a slow approval can
 *    never delay it, and it is idempotent.
 *  - Re-enabling is deliberate. Clearing the kill switch needs the current
 *    version and a reason, and resets the rollout to 0%, so the feature comes
 *    back only through the staged ramp again.
 *
 * Evidence: ramps and kill-switch clears write a CONFIG_CHANGED audit event
 * (mirrored into the tamper-evident ledger) *before* applying; if it cannot be
 * written the change is refused (503, retryable). An emergency disable is the
 * one exception: safety wins, the disable applies, and evidence that could not
 * be written is queued and retried by `flushPendingEvidence()`.
 *
 * Retries: changes carry an optional `requestId`. Repeating a request with the
 * same id returns the original result without applying it twice; reusing the id
 * for a different change is refused.
 *
 * State is process-local, like runtime overrides. See docs/FEATURE_ROLLOUT.md.
 */
import { auditStore, type AuditEvent } from '../audit/audit-service';
import {
  FEATURE_FLAGS,
  environmentFeatureValue,
  featureFlagKillSwitches,
  featureFlagRollouts,
  type FeatureFlag,
} from './feature-flags';

type RecordAudit = (event: Omit<AuditEvent, 'id' | 'timestamp'>) => AuditEvent;

/**
 * `maintainer` may ramp and re-enable; `operator` (on call) may only stop;
 * `system` is the automatic guardrail; `viewer` may read.
 */
export type RolloutRole = 'maintainer' | 'operator' | 'system' | 'viewer';

export interface RolloutActor {
  id: string;
  role: RolloutRole;
  capabilityId?: string;
  ip?: string;
  userAgent?: string;
}

export interface RolloutGuardrails {
  /** Largest single increase in percentage points. */
  maxStepPercent: number;
  /** Minimum time between a change and the next increase. */
  minSoakMs: number;
  /** Error rate (0-1) over the window that trips the kill switch. */
  maxErrorRate: number;
  /** Outcomes needed before the error rate is trusted. */
  minSamples: number;
  /** Most recent outcomes considered. */
  windowSize: number;
}

export const DEFAULT_GUARDRAILS: RolloutGuardrails = {
  maxStepPercent: 25,
  minSoakMs: 15 * 60_000,
  maxErrorRate: 0.05,
  minSamples: 50,
  windowSize: 500,
};

export interface KillSwitchState {
  engagedAt: string;
  engagedBy: string;
  reason: string;
  automatic: boolean;
}

export interface RolloutState {
  flag: FeatureFlag;
  /** null: no rollout configured; the environment/override decides. */
  percentage: number | null;
  version: number;
  lastChangedAt: string | null;
  killSwitch: KillSwitchState | null;
  health: { samples: number; errors: number; errorRate: number | null; healthy: boolean };
}

export interface RolloutChangeResult {
  changed: boolean;
  /** True when this is a repeated request answered from the idempotency record. */
  replayed: boolean;
  state: RolloutState;
  auditEventId: string | null;
  /** False only for an emergency disable whose evidence is queued for retry. */
  evidenceRecorded: boolean;
}

export type RolloutErrorCode =
  | 'UNKNOWN_FEATURE_FLAG'
  | 'ROLLOUT_FORBIDDEN'
  | 'INVALID_ROLLOUT_CHANGE'
  | 'ROLLOUT_VERSION_CONFLICT'
  | 'ROLLOUT_KILLED'
  | 'ROLLOUT_STEP_TOO_LARGE'
  | 'ROLLOUT_SOAK_INCOMPLETE'
  | 'ROLLOUT_GUARDRAIL_BREACHED'
  | 'ROLLOUT_NOT_KILLED'
  | 'ROLLOUT_REQUEST_REUSED'
  | 'ROLLOUT_AUDIT_UNAVAILABLE';

const HTTP_STATUS: Record<RolloutErrorCode, number> = {
  UNKNOWN_FEATURE_FLAG: 404,
  ROLLOUT_FORBIDDEN: 403,
  INVALID_ROLLOUT_CHANGE: 400,
  ROLLOUT_VERSION_CONFLICT: 409,
  ROLLOUT_KILLED: 409,
  ROLLOUT_STEP_TOO_LARGE: 422,
  ROLLOUT_SOAK_INCOMPLETE: 409,
  ROLLOUT_GUARDRAIL_BREACHED: 409,
  ROLLOUT_NOT_KILLED: 409,
  ROLLOUT_REQUEST_REUSED: 409,
  ROLLOUT_AUDIT_UNAVAILABLE: 503,
};

export class RolloutError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: RolloutErrorCode, message: string) {
    super(message);
    this.name = 'RolloutError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

const PERMISSIONS: Record<'advance' | 'disable' | 'clear', ReadonlySet<RolloutRole>> = {
  advance: new Set(['maintainer']),
  disable: new Set(['maintainer', 'operator', 'system']),
  clear: new Set(['maintainer']),
};

const MIN_REASON = 10;
const MAX_REASON = 500;
const MAX_REQUEST_IDS = 1_000;
const MAX_PENDING_EVIDENCE = 1_000;

interface FlagRecord {
  version: number;
  lastChangedAtMs: number | null;
  killSwitch: KillSwitchState | null;
  outcomes: boolean[];
}

export interface FeatureRolloutOptions {
  guardrails?: Partial<RolloutGuardrails>;
  now?: () => Date;
  recordAudit?: RecordAudit;
  killSwitches?: typeof featureFlagKillSwitches;
  rollouts?: typeof featureFlagRollouts;
  env?: Record<string, string | undefined>;
}

const isFlag = (flag: string): flag is FeatureFlag => Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, flag);

export class FeatureRolloutController {
  readonly guardrails: RolloutGuardrails;
  private readonly now: () => Date;
  private readonly recordAudit: RecordAudit;
  private readonly killSwitches: typeof featureFlagKillSwitches;
  private readonly rollouts: typeof featureFlagRollouts;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly records = new Map<FeatureFlag, FlagRecord>();
  /** requestId -> fingerprint and result, oldest first, bounded. */
  private readonly requests = new Map<string, { fingerprint: string; result: RolloutChangeResult }>();
  private pendingEvidence: Array<Omit<AuditEvent, 'id' | 'timestamp'>> = [];

  constructor(options: FeatureRolloutOptions = {}) {
    this.guardrails = { ...DEFAULT_GUARDRAILS, ...options.guardrails };
    this.now = options.now ?? (() => new Date());
    this.recordAudit = options.recordAudit ?? ((event) => auditStore.recordEvent(event));
    this.killSwitches = options.killSwitches ?? featureFlagKillSwitches;
    this.rollouts = options.rollouts ?? featureFlagRollouts;
    this.env = options.env;
  }

  state(flagName: string): RolloutState {
    const flag = this.flag(flagName);
    const record = this.record(flag);
    const errors = record.outcomes.filter((ok) => !ok).length;
    const samples = record.outcomes.length;
    const errorRate = samples === 0 ? null : errors / samples;
    return {
      flag,
      percentage: this.rollouts.get(flag) ?? null,
      version: record.version,
      lastChangedAt: record.lastChangedAtMs === null ? null : new Date(record.lastChangedAtMs).toISOString(),
      killSwitch: record.killSwitch ? { ...record.killSwitch } : null,
      health: { samples, errors, errorRate, healthy: !this.breached(record) },
    };
  }

  snapshot(): { flags: RolloutState[]; guardrails: RolloutGuardrails; pendingEvidence: number } {
    return {
      flags: (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map((flag) => this.state(flag)),
      guardrails: { ...this.guardrails },
      pendingEvidence: this.pendingEvidence.length,
    };
  }

  /**
   * Move the rollout to `percentage`, or end it with `null` so the environment
   * decides again (allowed only when the rollout already equals the
   * environment value, 0% or 100%, so ending it changes nobody's behaviour).
   * Synchronous, so no other change interleaves.
   */
  advance(request: {
    flag: string;
    percentage: unknown;
    expectedVersion: unknown;
    reason: unknown;
    actor: RolloutActor;
    requestId?: string;
    correlationId?: string;
  }): RolloutChangeResult {
    const flag = this.flag(request.flag);
    this.authorize('advance', request.actor);
    const percentage = request.percentage;
    if (percentage !== null && (!Number.isSafeInteger(percentage) || (percentage as number) < 0 || (percentage as number) > 100)) {
      throw new RolloutError('INVALID_ROLLOUT_CHANGE', 'percentage must be an integer from 0 to 100, or null to end the rollout');
    }
    const reason = this.reason(request.reason);
    const fingerprint = JSON.stringify(['advance', flag, percentage, request.expectedVersion, reason]);
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;

    const record = this.record(flag);
    this.checkVersion(record, request.expectedVersion);
    const configured = this.rollouts.get(flag);
    if (percentage === null) return this.finish(flag, record, configured, reason, request, fingerprint);
    const target = percentage as number;
    const current = configured ?? 0;
    if (record.killSwitch && target > 0) {
      throw new RolloutError('ROLLOUT_KILLED', `${flag} is disabled by its kill switch; clear it before ramping`);
    }
    if (target === (this.rollouts.get(flag) ?? null)) {
      return this.remember(request.requestId, fingerprint, { changed: false, replayed: false, state: this.state(flag), auditEventId: null, evidenceRecorded: true });
    }
    if (target > current) {
      if (target - current > this.guardrails.maxStepPercent) {
        throw new RolloutError('ROLLOUT_STEP_TOO_LARGE', `Increase by at most ${this.guardrails.maxStepPercent} points per step (${current}% -> ${target}% requested)`);
      }
      const sinceMs = record.lastChangedAtMs === null ? Infinity : this.now().getTime() - record.lastChangedAtMs;
      if (sinceMs < this.guardrails.minSoakMs) {
        throw new RolloutError(
          'ROLLOUT_SOAK_INCOMPLETE',
          `The current stage needs ${Math.ceil((this.guardrails.minSoakMs - sinceMs) / 1000)}s more soak time before increasing`
        );
      }
      if (this.breached(record)) {
        throw new RolloutError('ROLLOUT_GUARDRAIL_BREACHED', `${flag} error rate is above ${this.guardrails.maxErrorRate}; roll back or investigate before increasing`);
      }
    }

    const before = this.state(flag);
    const evidence = this.evidenceFirst(request.actor, flag, reason, request.correlationId, {
      change: 'rollout_advanced',
      before: { percentage: before.percentage, version: before.version },
      after: { percentage: target, version: record.version + 1 },
    });
    this.rollouts.set(flag, target);
    this.bump(record);
    return this.remember(request.requestId, fingerprint, {
      changed: true,
      replayed: false,
      state: this.state(flag),
      auditEventId: evidence.id,
      evidenceRecorded: true,
    });
  }

  private finish(
    flag: FeatureFlag,
    record: FlagRecord,
    configured: number | undefined,
    reason: string,
    request: { actor: RolloutActor; requestId?: string; correlationId?: string },
    fingerprint: string
  ): RolloutChangeResult {
    if (configured === undefined) {
      return this.remember(request.requestId, fingerprint, { changed: false, replayed: false, state: this.state(flag), auditEventId: null, evidenceRecorded: true });
    }
    if (record.killSwitch) throw new RolloutError('ROLLOUT_KILLED', `${flag} is disabled by its kill switch; clear it before ending the rollout`);
    const environment = environmentFeatureValue(flag, this.env ?? process.env) ? 100 : 0;
    if (configured !== environment) {
      throw new RolloutError(
        'INVALID_ROLLOUT_CHANGE',
        `Ending the rollout at ${configured}% would switch to the environment value (${environment}%); ramp to ${environment}% first`
      );
    }
    const evidence = this.evidenceFirst(request.actor, flag, reason, request.correlationId, {
      change: 'rollout_completed',
      before: { percentage: configured, version: record.version },
      after: { percentage: null, version: record.version + 1, source: 'environment' },
    });
    this.rollouts.set(flag, null);
    this.bump(record);
    return this.remember(request.requestId, fingerprint, { changed: true, replayed: false, state: this.state(flag), auditEventId: evidence.id, evidenceRecorded: true });
  }

  /** Force the flag to its safe default. Idempotent; never blocked by versions or audit outages. */
  emergencyDisable(request: { flag: string; reason: unknown; actor: RolloutActor; correlationId?: string; automatic?: boolean }): RolloutChangeResult {
    const flag = this.flag(request.flag);
    this.authorize('disable', request.actor);
    const reason = this.reason(request.reason);
    const record = this.record(flag);
    if (record.killSwitch) {
      return { changed: false, replayed: false, state: this.state(flag), auditEventId: null, evidenceRecorded: true };
    }

    const before = this.state(flag);
    record.killSwitch = {
      engagedAt: this.now().toISOString(),
      engagedBy: request.actor.id,
      reason,
      automatic: request.automatic ?? false,
    };
    this.killSwitches.set(flag, true);
    this.bump(record);

    const event = this.event(request.actor, flag, reason, request.correlationId, {
      change: 'kill_switch_engaged',
      before: { percentage: before.percentage, version: before.version, killed: false },
      after: { percentage: before.percentage, version: record.version, killed: true, automatic: record.killSwitch.automatic },
    });
    let auditEventId: string | null = null;
    try {
      auditEventId = this.recordAudit(event).id;
    } catch {
      if (this.pendingEvidence.length < MAX_PENDING_EVIDENCE) this.pendingEvidence.push(event);
    }
    return { changed: true, replayed: false, state: this.state(flag), auditEventId, evidenceRecorded: auditEventId !== null };
  }

  /** Re-enable after an incident. The rollout restarts at 0% and must be ramped again. */
  clearKillSwitch(request: { flag: string; expectedVersion: unknown; reason: unknown; actor: RolloutActor; requestId?: string; correlationId?: string }): RolloutChangeResult {
    const flag = this.flag(request.flag);
    this.authorize('clear', request.actor);
    const reason = this.reason(request.reason);
    const fingerprint = JSON.stringify(['clear', flag, request.expectedVersion, reason]);
    const replay = this.replay(request.requestId, fingerprint);
    if (replay) return replay;

    const record = this.record(flag);
    this.checkVersion(record, request.expectedVersion);
    if (!record.killSwitch) throw new RolloutError('ROLLOUT_NOT_KILLED', `${flag} has no engaged kill switch`);
    if (this.pendingEvidence.length > 0) {
      throw new RolloutError('ROLLOUT_AUDIT_UNAVAILABLE', 'Evidence for an earlier emergency disable is still pending; flush it before re-enabling');
    }

    const before = this.state(flag);
    const evidence = this.evidenceFirst(request.actor, flag, reason, request.correlationId, {
      change: 'kill_switch_cleared',
      before: { percentage: before.percentage, version: before.version, killed: true, killSwitch: before.killSwitch },
      after: { percentage: 0, version: record.version + 1, killed: false },
    });
    record.killSwitch = null;
    record.outcomes = [];
    this.rollouts.set(flag, 0);
    this.killSwitches.set(flag, false);
    this.bump(record);
    return this.remember(request.requestId, fingerprint, {
      changed: true,
      replayed: false,
      state: this.state(flag),
      auditEventId: evidence.id,
      evidenceRecorded: true,
    });
  }

  /**
   * Report the outcome of one execution of a flagged code path. Trips the kill
   * switch when the guardrail is breached. O(1) amortized.
   */
  recordOutcome(flagName: string, outcome: { ok: boolean }): { tripped: boolean } {
    const flag = this.flag(flagName);
    const record = this.record(flag);
    record.outcomes.push(outcome.ok);
    if (record.outcomes.length > this.guardrails.windowSize) record.outcomes.shift();
    if (record.killSwitch || !this.breached(record)) return { tripped: false };
    const { errorRate } = this.state(flag).health;
    this.emergencyDisable({
      flag,
      actor: { id: 'rollout-guardrail', role: 'system' },
      reason: `Automatic: error rate ${(errorRate! * 100).toFixed(1)}% exceeded ${(this.guardrails.maxErrorRate * 100).toFixed(1)}%`,
      automatic: true,
    });
    return { tripped: true };
  }

  /** Retry evidence that could not be written during an emergency disable. Stops at the first failure. */
  flushPendingEvidence(): { recorded: number; remaining: number } {
    let recorded = 0;
    while (this.pendingEvidence.length > 0) {
      try {
        this.recordAudit({ ...this.pendingEvidence[0], metadata: { ...this.pendingEvidence[0].metadata, evidenceDelayed: true } });
      } catch {
        break;
      }
      this.pendingEvidence.shift();
      recorded += 1;
    }
    return { recorded, remaining: this.pendingEvidence.length };
  }

  /** Tests only: forget all rollout state and release process flag state this controller owns. */
  reset(): void {
    for (const flag of this.records.keys()) {
      this.killSwitches.set(flag, false);
      this.rollouts.set(flag, null);
    }
    this.records.clear();
    this.requests.clear();
    this.pendingEvidence = [];
  }

  private flag(name: string): FeatureFlag {
    if (!isFlag(name)) throw new RolloutError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${name}"`);
    return name;
  }

  private record(flag: FeatureFlag): FlagRecord {
    let record = this.records.get(flag);
    if (!record) {
      record = { version: 0, lastChangedAtMs: null, killSwitch: null, outcomes: [] };
      this.records.set(flag, record);
    }
    return record;
  }

  private authorize(action: keyof typeof PERMISSIONS, actor: RolloutActor | undefined): void {
    if (!actor || typeof actor.id !== 'string' || actor.id.trim() === '' || !PERMISSIONS[action].has(actor.role)) {
      throw new RolloutError('ROLLOUT_FORBIDDEN', `Role "${actor?.role ?? 'none'}" may not ${action} a rollout`);
    }
  }

  private reason(value: unknown): string {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      throw new RolloutError('INVALID_ROLLOUT_CHANGE', `reason must explain the change (${MIN_REASON}-${MAX_REASON} characters)`);
    }
    return reason;
  }

  private checkVersion(record: FlagRecord, expected: unknown): void {
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
      throw new RolloutError('INVALID_ROLLOUT_CHANGE', 'expectedVersion must be the current rollout version (a non-negative integer)');
    }
    if (expected !== record.version) {
      throw new RolloutError('ROLLOUT_VERSION_CONFLICT', `Rollout is at version ${record.version}, not ${expected}; re-read it and retry`);
    }
  }

  private breached(record: FlagRecord): boolean {
    const samples = record.outcomes.length;
    if (samples < this.guardrails.minSamples) return false;
    const errors = record.outcomes.filter((ok) => !ok).length;
    return errors / samples > this.guardrails.maxErrorRate;
  }

  private bump(record: FlagRecord): void {
    record.version += 1;
    record.lastChangedAtMs = this.now().getTime();
    record.outcomes = [];
  }

  private replay(requestId: string | undefined, fingerprint: string): RolloutChangeResult | null {
    if (requestId === undefined) return null;
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) {
      throw new RolloutError('INVALID_ROLLOUT_CHANGE', 'requestId must be 1-200 characters');
    }
    const seen = this.requests.get(requestId);
    if (!seen) return null;
    if (seen.fingerprint !== fingerprint) {
      throw new RolloutError('ROLLOUT_REQUEST_REUSED', 'requestId was already used for a different change');
    }
    return { ...seen.result, replayed: true };
  }

  private remember(requestId: string | undefined, fingerprint: string, result: RolloutChangeResult): RolloutChangeResult {
    if (requestId !== undefined) {
      this.requests.set(requestId, { fingerprint, result });
      while (this.requests.size > MAX_REQUEST_IDS) this.requests.delete(this.requests.keys().next().value as string);
    }
    return result;
  }

  private event(
    actor: RolloutActor,
    flag: FeatureFlag,
    reason: string,
    correlationId: string | undefined,
    change: { change: string; before: Record<string, unknown>; after: Record<string, unknown> }
  ): Omit<AuditEvent, 'id' | 'timestamp'> {
    return {
      action: 'CONFIG_CHANGED',
      actor: { type: actor.role === 'system' ? 'system' : 'maintainer', id: actor.id, ip: actor.ip, userAgent: actor.userAgent },
      scope: { entityType: 'config', entityId: `rollouts.${flag}` },
      reason,
      beforeState: change.before,
      afterState: change.after,
      metadata: { configKey: `rollouts.${flag}`, change: change.change, role: actor.role, capabilityId: actor.capabilityId ?? null },
      correlationId,
    };
  }

  private evidenceFirst(
    actor: RolloutActor,
    flag: FeatureFlag,
    reason: string,
    correlationId: string | undefined,
    change: { change: string; before: Record<string, unknown>; after: Record<string, unknown> }
  ): AuditEvent {
    try {
      return this.recordAudit(this.event(actor, flag, reason, correlationId, change));
    } catch {
      throw new RolloutError('ROLLOUT_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the change was not applied; retry');
    }
  }
}

export const featureRollout = new FeatureRolloutController();
