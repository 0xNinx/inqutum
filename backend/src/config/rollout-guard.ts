/**
 * Feature-flag rollout guard with automatic rollback verification (#256).
 *
 * A flag in `FEATURE_FLAGS` is either on or off for the whole process. The
 * guard adds a scoped, monitored rollout on top of that without changing what
 * `isFeatureEnabled` returns when no rollout is active:
 *
 *  - Scope: a rollout enables the flag for an explicit seller allow-list plus a
 *    deterministic percentage bucket (sha256 of flag + subject). Callers with
 *    no subject always get the baseline value.
 *  - Monitor: callers report outcomes for cohort traffic (`recordOutcome`).
 *    When the failure rate over the last `windowSize` outcomes exceeds
 *    `maxFailureRate` (after `minSamples`), the guard rolls back on its own.
 *  - Roll back: the rollout scope is removed, so every subject is served the
 *    baseline captured when the rollout started.
 *  - Verify: right after rollback the guard checks that no subject is still
 *    served the rolled-out value, the effective process value equals the
 *    pre-rollout baseline, and the rollback evidence was written. A failed
 *    check leaves the rollout in `rollback_unverified` with the reasons.
 *
 * Invariants:
 *  - Evidence first: the CONFIG_CHANGED audit event is written before a start
 *    or rollback is applied. If it cannot be written, nothing changes.
 *  - A rollout can only start from a baseline of `false`: rolling out a flag
 *    that is already on everywhere is meaningless and would make rollback lie.
 *  - The global kill switch wins: a runtime override of `false` (admin config)
 *    disables the flag for every subject, cohort included.
 *  - State is process-local, like admin-config overrides. A restart drops any
 *    rollout and the environment value applies again, which is the rollback.
 *
 * See docs/FEATURE_FLAG_ROLLOUT_GUARD.md.
 */
import { createHash } from 'node:crypto';
import { auditStore, type AuditEvent } from '../audit/audit-service';
import {
  FEATURE_FLAGS,
  environmentFeatureValue,
  featureFlagOverrides,
  type FeatureFlag,
} from './feature-flags';

type RecordAudit = (event: Omit<AuditEvent, 'id' | 'timestamp'>) => AuditEvent;
type RuntimeEnvironment = Record<string, string | undefined>;

export interface RolloutScope {
  /** 0-100. Share of subjects (by deterministic hash bucket) that get the flag. */
  percentage: number;
  /** Subjects (seller public keys) that always get the flag while the rollout is active. */
  allowList?: string[];
}

export interface RolloutGuardrail {
  /** Outcomes required before the failure rate is trusted. */
  minSamples: number;
  /** 0-1. Failure rate above this triggers automatic rollback. */
  maxFailureRate: number;
  /** Size of the sliding window of recent outcomes. */
  windowSize: number;
}

export type RolloutStatus = 'active' | 'rolled_back' | 'rollback_unverified' | 'completed';
export type RollbackTrigger = 'automatic' | 'manual';

export interface RollbackCheck {
  name: 'no_active_scope' | 'subjects_on_baseline' | 'effective_value_is_baseline' | 'rollback_evidence_recorded';
  ok: boolean;
  detail: string;
}

export interface RollbackVerification {
  consistent: boolean;
  verifiedAt: string;
  checks: RollbackCheck[];
}

export interface RolloutRecord {
  flag: FeatureFlag;
  status: RolloutStatus;
  scope: { percentage: number; allowList: string[] };
  guardrail: RolloutGuardrail;
  baseline: boolean;
  reason: string;
  startedBy: string;
  startedAt: string;
  window: { total: number; failed: number; failureRate: number };
  rollback: null | {
    trigger: RollbackTrigger;
    reason: string;
    at: string;
    by: string;
    auditEventId: string;
    verification: RollbackVerification;
  };
}

export type RolloutGuardErrorCode =
  | 'UNKNOWN_FEATURE_FLAG'
  | 'INVALID_ROLLOUT'
  | 'ROLLOUT_ALREADY_ACTIVE'
  | 'ROLLOUT_BASELINE_ENABLED'
  | 'ROLLOUT_NOT_ACTIVE'
  | 'ROLLOUT_AUDIT_UNAVAILABLE';

const HTTP_STATUS: Record<RolloutGuardErrorCode, number> = {
  UNKNOWN_FEATURE_FLAG: 404,
  INVALID_ROLLOUT: 400,
  ROLLOUT_ALREADY_ACTIVE: 409,
  ROLLOUT_BASELINE_ENABLED: 409,
  ROLLOUT_NOT_ACTIVE: 409,
  ROLLOUT_AUDIT_UNAVAILABLE: 503,
};

export class RolloutGuardError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: RolloutGuardErrorCode, message: string) {
    super(message);
    this.name = 'RolloutGuardError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export const DEFAULT_GUARDRAIL: RolloutGuardrail = { minSamples: 20, maxFailureRate: 0.05, windowSize: 100 };

const MIN_REASON_LENGTH = 10;
const MAX_ALLOW_LIST = 500;

const isFlag = (flag: string): flag is FeatureFlag => Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, flag);

/** Deterministic 0-99.99 bucket for a subject; the same subject always lands in the same bucket per flag. */
export function rolloutBucket(flag: string, subject: string): number {
  const digest = createHash('sha256').update(`${flag}:${subject}`).digest();
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

interface ActiveRollout {
  record: RolloutRecord;
  allow: Set<string>;
  outcomes: boolean[];
}

export interface RolloutGuardOptions {
  recordAudit?: RecordAudit;
  overrides?: typeof featureFlagOverrides;
  env?: RuntimeEnvironment;
  now?: () => Date;
}

export interface StartRolloutRequest {
  flag: string;
  scope: unknown;
  guardrail?: unknown;
  reason: unknown;
  actorId: string;
  correlationId?: string;
}

export class RolloutGuard {
  private readonly rollouts = new Map<FeatureFlag, ActiveRollout>();
  private readonly recordAudit: RecordAudit;
  private readonly overrides: typeof featureFlagOverrides;
  private readonly now: () => Date;

  constructor(private readonly options: RolloutGuardOptions = {}) {
    this.recordAudit = options.recordAudit ?? ((event) => auditStore.recordEvent(event));
    this.overrides = options.overrides ?? featureFlagOverrides;
    this.now = options.now ?? (() => new Date());
  }

  private env(): RuntimeEnvironment {
    return this.options.env ?? process.env;
  }

  /** Process-wide value ignoring any rollout: runtime override, else environment. */
  baselineValue(flag: FeatureFlag): boolean {
    return this.overrides.get(flag) ?? environmentFeatureValue(flag, this.env());
  }

  /**
   * The value a given subject is served. Identical to `isFeatureEnabled` when
   * no rollout is active for the flag. O(1) plus one hash.
   */
  isEnabledFor(flag: FeatureFlag, subject?: string): boolean {
    const active = this.rollouts.get(flag);
    if (!active || active.record.status !== 'active') return this.baselineValue(flag);
    // Kill switch: an explicit runtime `false` disables the cohort too.
    if (this.overrides.get(flag) === false) return false;
    if (!subject) return active.record.baseline;
    if (active.allow.has(subject)) return true;
    return rolloutBucket(flag, subject) < active.record.scope.percentage;
  }

  start(request: StartRolloutRequest): RolloutRecord {
    if (!isFlag(request.flag)) {
      throw new RolloutGuardError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${request.flag}"`);
    }
    const flag = request.flag;
    const scope = parseScope(request.scope);
    const guardrail = parseGuardrail(request.guardrail);
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      throw new RolloutGuardError('INVALID_ROLLOUT', `reason must explain the rollout (at least ${MIN_REASON_LENGTH} characters)`);
    }
    if (this.rollouts.get(flag)?.record.status === 'active') {
      throw new RolloutGuardError('ROLLOUT_ALREADY_ACTIVE', `A rollout of "${flag}" is already active; roll it back or complete it first`);
    }
    const baseline = this.baselineValue(flag);
    if (baseline) {
      throw new RolloutGuardError('ROLLOUT_BASELINE_ENABLED', `"${flag}" is already on for every subject; there is nothing to roll out`);
    }

    const startedAt = this.now().toISOString();
    try {
      this.recordAudit({
        action: 'CONFIG_CHANGED',
        actor: { type: 'maintainer', id: request.actorId },
        scope: { entityType: 'config', entityId: `rollouts.${flag}` },
        reason,
        beforeState: { rollout: null, baseline },
        afterState: { rollout: 'active', percentage: scope.percentage, allowListSize: scope.allowList.length, guardrail },
        metadata: { configKey: `rollouts.${flag}`, change: 'rollout_started' },
        correlationId: request.correlationId,
      });
    } catch {
      throw new RolloutGuardError('ROLLOUT_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the rollout was not started; retry');
    }

    const record: RolloutRecord = {
      flag,
      status: 'active',
      scope,
      guardrail,
      baseline,
      reason,
      startedBy: request.actorId,
      startedAt,
      window: { total: 0, failed: 0, failureRate: 0 },
      rollback: null,
    };
    this.rollouts.set(flag, { record, allow: new Set(scope.allowList), outcomes: [] });
    return this.get(flag)!;
  }

  /**
   * Reports one outcome of cohort traffic. Returns the rollout after the
   * guardrail is evaluated; it may now be rolled back. Outcomes for a flag with
   * no active rollout are ignored. O(windowSize).
   */
  recordOutcome(flag: FeatureFlag, ok: boolean, correlationId?: string): RolloutRecord | null {
    const active = this.rollouts.get(flag);
    if (!active || active.record.status !== 'active') return active ? this.get(flag) : null;

    active.outcomes.push(ok);
    if (active.outcomes.length > active.record.guardrail.windowSize) active.outcomes.shift();
    this.refreshWindow(active);

    const { total, failureRate } = active.record.window;
    const { minSamples, maxFailureRate } = active.record.guardrail;
    if (total >= minSamples && failureRate > maxFailureRate) {
      try {
        this.rollback(flag, {
          trigger: 'automatic',
          reason: `Failure rate ${(failureRate * 100).toFixed(1)}% over ${total} outcomes exceeded ${(maxFailureRate * 100).toFixed(1)}%`,
          actorId: 'rollout-guard',
          correlationId,
        });
      } catch {
        // Evidence could not be written: the rollout stays active and the next
        // outcome retries the rollback. The kill switch is the manual fallback.
      }
    }
    return this.get(flag);
  }

  rollback(
    flag: string,
    request: { trigger?: RollbackTrigger; reason: unknown; actorId: string; correlationId?: string }
  ): RolloutRecord {
    if (!isFlag(flag)) {
      throw new RolloutGuardError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${flag}"`);
    }
    const active = this.rollouts.get(flag);
    if (!active || active.record.status !== 'active') {
      throw new RolloutGuardError('ROLLOUT_NOT_ACTIVE', `No active rollout of "${flag}"`);
    }
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH) {
      throw new RolloutGuardError('INVALID_ROLLOUT', `reason must explain the rollback (at least ${MIN_REASON_LENGTH} characters)`);
    }
    const trigger = request.trigger ?? 'manual';

    let evidence: AuditEvent;
    try {
      evidence = this.recordAudit({
        action: 'CONFIG_CHANGED',
        actor: { type: trigger === 'automatic' ? 'system' : 'maintainer', id: request.actorId },
        scope: { entityType: 'config', entityId: `rollouts.${flag}` },
        reason,
        beforeState: { rollout: 'active', percentage: active.record.scope.percentage, window: active.record.window },
        afterState: { rollout: 'rolled_back', baseline: active.record.baseline },
        metadata: { configKey: `rollouts.${flag}`, change: 'rollout_rolled_back', trigger },
        correlationId: request.correlationId,
      });
    } catch {
      throw new RolloutGuardError('ROLLOUT_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the rollback was not applied; use the kill switch and retry');
    }

    // Apply: drop the scope. From here on every subject gets the baseline.
    active.record.status = 'rolled_back';
    active.allow.clear();
    const verification = this.verifyRollback(flag, [...active.record.scope.allowList], evidence.id);
    active.record.status = verification.consistent ? 'rolled_back' : 'rollback_unverified';
    active.record.rollback = {
      trigger,
      reason,
      at: this.now().toISOString(),
      by: request.actorId,
      auditEventId: evidence.id,
      verification,
    };
    return this.get(flag)!;
  }

  /**
   * Checks that nothing is left serving the rolled-out value. `probeSubjects`
   * should include the allow-list; a fixed synthetic sample covers the
   * percentage buckets. Safe to call repeatedly (re-verification after a fix).
   */
  verifyRollback(flag: FeatureFlag, probeSubjects: string[] = [], auditEventId?: string): RollbackVerification {
    const active = this.rollouts.get(flag);
    const baseline = active?.record.baseline ?? false;
    const subjects = [...new Set([...probeSubjects, ...syntheticSubjects(64)])];
    const leaking = subjects.filter((s) => this.isEnabledFor(flag, s) !== baseline);
    const effective = this.baselineValue(flag);
    const evidenceId = auditEventId ?? active?.record.rollback?.auditEventId;

    const checks: RollbackCheck[] = [
      {
        name: 'no_active_scope',
        ok: !active || active.record.status !== 'active',
        detail: active?.record.status === 'active' ? 'Rollout scope is still active' : 'No rollout scope is active',
      },
      {
        name: 'subjects_on_baseline',
        ok: leaking.length === 0,
        detail: leaking.length === 0
          ? `All ${subjects.length} probed subjects are served the baseline (${baseline})`
          : `${leaking.length} of ${subjects.length} probed subjects are still served ${!baseline}`,
      },
      {
        name: 'effective_value_is_baseline',
        ok: effective === baseline,
        detail: effective === baseline
          ? `Process value is the pre-rollout baseline (${baseline})`
          : `Process value is ${effective} but the pre-rollout baseline was ${baseline}; check ${FEATURE_FLAGS[flag].env} and runtime overrides`,
      },
      {
        name: 'rollback_evidence_recorded',
        ok: Boolean(evidenceId),
        detail: evidenceId ? `Audit event ${evidenceId}` : 'No rollback audit event recorded',
      },
    ];
    const consistent = checks.every((c) => c.ok);
    if (active && active.record.status !== 'active') {
      active.record.status = consistent ? 'rolled_back' : 'rollback_unverified';
      if (active.record.rollback) active.record.rollback.verification = { consistent, verifiedAt: this.now().toISOString(), checks };
    }
    return { consistent, verifiedAt: this.now().toISOString(), checks };
  }

  /** Marks a healthy rollout done; the flag should now be promoted through the environment. */
  complete(flag: string, actorId: string, correlationId?: string): RolloutRecord {
    if (!isFlag(flag)) throw new RolloutGuardError('UNKNOWN_FEATURE_FLAG', `Unknown feature flag "${flag}"`);
    const active = this.rollouts.get(flag);
    if (!active || active.record.status !== 'active') {
      throw new RolloutGuardError('ROLLOUT_NOT_ACTIVE', `No active rollout of "${flag}"`);
    }
    try {
      this.recordAudit({
        action: 'CONFIG_CHANGED',
        actor: { type: 'maintainer', id: actorId },
        scope: { entityType: 'config', entityId: `rollouts.${flag}` },
        reason: 'Rollout completed; promote through the environment variable',
        beforeState: { rollout: 'active' },
        afterState: { rollout: 'completed' },
        metadata: { configKey: `rollouts.${flag}`, change: 'rollout_completed' },
        correlationId,
      });
    } catch {
      throw new RolloutGuardError('ROLLOUT_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the rollout was not completed; retry');
    }
    active.record.status = 'completed';
    active.allow.clear();
    return this.get(flag)!;
  }

  get(flag: FeatureFlag): RolloutRecord | null {
    const active = this.rollouts.get(flag);
    if (!active) return null;
    return structuredClone(active.record);
  }

  list(): RolloutRecord[] {
    return [...this.rollouts.keys()].map((flag) => this.get(flag)!);
  }

  private refreshWindow(active: ActiveRollout): void {
    const total = active.outcomes.length;
    const failed = active.outcomes.filter((ok) => !ok).length;
    active.record.window = { total, failed, failureRate: total === 0 ? 0 : failed / total };
  }
}

function parseScope(input: unknown): { percentage: number; allowList: string[] } {
  if (!input || typeof input !== 'object') {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'scope must be an object with percentage and optional allowList');
  }
  const { percentage, allowList } = input as Record<string, unknown>;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'scope.percentage must be a number from 0 to 100');
  }
  const list = allowList === undefined ? [] : allowList;
  if (!Array.isArray(list) || list.length > MAX_ALLOW_LIST || list.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new RolloutGuardError('INVALID_ROLLOUT', `scope.allowList must be an array of up to ${MAX_ALLOW_LIST} non-empty strings`);
  }
  if (percentage === 0 && list.length === 0) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'scope must reach at least one subject (percentage > 0 or a non-empty allowList)');
  }
  return { percentage, allowList: [...new Set(list.map((s: string) => s.trim()))] };
}

function parseGuardrail(input: unknown): RolloutGuardrail {
  if (input === undefined) return { ...DEFAULT_GUARDRAIL };
  if (!input || typeof input !== 'object') {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'guardrail must be an object');
  }
  const merged = { ...DEFAULT_GUARDRAIL, ...(input as Partial<RolloutGuardrail>) };
  if (!Number.isSafeInteger(merged.windowSize) || merged.windowSize < 1 || merged.windowSize > 10_000) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'guardrail.windowSize must be an integer from 1 to 10000');
  }
  if (!Number.isSafeInteger(merged.minSamples) || merged.minSamples < 1 || merged.minSamples > merged.windowSize) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'guardrail.minSamples must be an integer from 1 to windowSize');
  }
  if (typeof merged.maxFailureRate !== 'number' || !(merged.maxFailureRate >= 0 && merged.maxFailureRate < 1)) {
    throw new RolloutGuardError('INVALID_ROLLOUT', 'guardrail.maxFailureRate must be a number from 0 (inclusive) to 1 (exclusive)');
  }
  return { minSamples: merged.minSamples, maxFailureRate: merged.maxFailureRate, windowSize: merged.windowSize };
}

/** Fixed, deterministic probe subjects spread across hash buckets. */
function syntheticSubjects(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `rollout-probe-${i}`);
}

export const rolloutGuard = new RolloutGuard();
