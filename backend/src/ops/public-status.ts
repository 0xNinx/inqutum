/**
 * Safe public-status model for degraded, paused, or maintenance states (#254).
 *
 * One status drives three paths so they never disagree:
 *  - API: `requireStatusCapability` refuses gated writes with 503, a stable
 *    code and Retry-After while paused or in maintenance.
 *  - UI: `GET /api/status` returns a public projection the frontend renders.
 *  - Background: `backgroundGate` tells the job worker which job types to hold.
 *
 * States, most severe first: maintenance > paused > degraded > operational.
 *  - maintenance: read-only. Every gated write is refused, every job is held.
 *  - paused: payments paused. Invoice creation and payment verification are
 *    refused and the background expiry sweep is held. Lazy expiry on reads
 *    still applies, so a long pause can expire invoices (see the runbook).
 *    Reads, cancels and exports keep working.
 *  - degraded: informational. Nothing is refused by the status itself; the
 *    dependency matrix (degraded-mode.service) still applies its fallbacks.
 *  - operational: the default. Behaviour is identical to before #254.
 *
 * Secret safety: the public projection is built from an allow-list. Titles and
 * messages come from a fixed catalog; the operator's free-text reason, actor
 * ids, dependency error strings, hosts and runbook links never leave the
 * internal view. See docs/PUBLIC_STATUS.md.
 */
import type { NextFunction, Request, Response } from 'express';
import { auditStore, type AuditEvent } from '../audit/audit-service';
import type { Capability, CapabilityDecision, DependencyState } from './dependency-degradation';
import type { DegradedModeStatus } from './degraded-mode.service';
import { EXPIRE_PENDING_INVOICES_JOB } from '../jobs/runtime';

type RecordAudit = (event: Omit<AuditEvent, 'id' | 'timestamp'>) => AuditEvent;

export type PublicStatusState = 'operational' | 'degraded' | 'paused' | 'maintenance';
export type OperatorStatusState = Exclude<PublicStatusState, 'operational'>;

/** Gated user-facing actions. Names are public; they appear in /api/status. */
export type StatusCapability =
  | 'invoice_creation'
  | 'invoice_viewing'
  | 'invoice_cancellation'
  | 'payment_verification'
  | 'exports'
  | 'email_notifications';

export type CapabilityAvailability = 'available' | 'limited' | 'unavailable';

export const STATUS_CAPABILITIES: readonly StatusCapability[] = [
  'invoice_creation',
  'invoice_viewing',
  'invoice_cancellation',
  'payment_verification',
  'exports',
  'email_notifications',
];

/** Dependency-matrix capability behind each public capability, if any. */
const DEPENDENCY_CAPABILITY: Record<StatusCapability, Capability | null> = {
  invoice_creation: 'invoice.create',
  invoice_viewing: 'invoice.read',
  invoice_cancellation: null,
  payment_verification: 'payment.verify',
  exports: 'export.create',
  email_notifications: 'notification.send',
};

interface StatePolicy {
  title: string;
  message: string;
  /** Code returned to API callers refused by this state. */
  code: string;
  retryAfterSeconds: number;
  blocked: readonly StatusCapability[];
  /** Job types held, or '*' for all. */
  heldJobs: readonly string[] | '*';
}

export const STATE_POLICY: Record<PublicStatusState, StatePolicy> = {
  operational: {
    title: 'All systems operational',
    message: 'Invoices, payments and exports are working normally.',
    code: 'OK',
    retryAfterSeconds: 0,
    blocked: [],
    heldJobs: [],
  },
  degraded: {
    title: 'Degraded performance',
    message: 'Some features may be slower or temporarily limited. Payments already sent on Stellar are safe and will be verified.',
    code: 'SERVICE_DEGRADED',
    retryAfterSeconds: 30,
    blocked: [],
    heldJobs: [],
  },
  paused: {
    title: 'Payments temporarily paused',
    message: 'New invoices and payment verification are paused. Existing invoices stay viewable. Payments already sent on Stellar are safe and can be verified once payments resume.',
    code: 'SERVICE_PAUSED',
    retryAfterSeconds: 120,
    blocked: ['invoice_creation', 'payment_verification'],
    heldJobs: [EXPIRE_PENDING_INVOICES_JOB],
  },
  maintenance: {
    title: 'Scheduled maintenance',
    message: 'Quittance is read-only during maintenance. You can view invoices; other actions resume when maintenance ends.',
    code: 'SERVICE_MAINTENANCE',
    retryAfterSeconds: 300,
    blocked: ['invoice_creation', 'invoice_cancellation', 'payment_verification', 'exports', 'email_notifications'],
    heldJobs: '*',
  },
};

const OPERATOR_STATES: readonly OperatorStatusState[] = ['degraded', 'paused', 'maintenance'];
const SEVERITY: Record<PublicStatusState, number> = { operational: 0, degraded: 1, paused: 2, maintenance: 3 };

export interface OperatorDeclaration {
  state: OperatorStatusState;
  /** Internal only. Never part of the public projection. */
  reason: string;
  declaredBy: string;
  declaredAt: string;
  expectedResolutionAt: string | null;
  auditEventId: string;
}

/** Exactly what /api/status returns. Every field is public-safe by construction. */
export interface PublicStatus {
  state: PublicStatusState;
  title: string;
  message: string;
  since: string | null;
  expectedResolutionAt: string | null;
  retryAfterSeconds: number;
  capabilities: Record<StatusCapability, CapabilityAvailability>;
  updatedAt: string;
}

export interface InternalStatus {
  public: PublicStatus;
  declaration: OperatorDeclaration | null;
  dependencyState: DependencyState | 'unavailable';
  version: number;
}

export interface StatusGateDecision {
  allowed: boolean;
  state: PublicStatusState;
  code: string;
  httpStatus: 200 | 503;
  retryAfterSeconds: number;
  message: string;
}

export type PublicStatusErrorCode = 'INVALID_STATUS_CHANGE' | 'STATUS_VERSION_CONFLICT' | 'STATUS_AUDIT_UNAVAILABLE';

const HTTP_STATUS: Record<PublicStatusErrorCode, number> = {
  INVALID_STATUS_CHANGE: 400,
  STATUS_VERSION_CONFLICT: 409,
  STATUS_AUDIT_UNAVAILABLE: 503,
};

export class PublicStatusError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: PublicStatusErrorCode, message: string) {
    super(message);
    this.name = 'PublicStatusError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface PublicStatusServiceOptions {
  /** Dependency health. Defaults to none (dependency state not consulted). */
  dependencies?: { getStatus(): Promise<DegradedModeStatus> };
  recordAudit?: RecordAudit;
  now?: () => Date;
}

export interface DeclareStatusRequest {
  state: unknown;
  reason: unknown;
  expectedResolutionAt?: unknown;
  expectedVersion: unknown;
  actorId: string;
  correlationId?: string;
}

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

export class PublicStatusService {
  private declaration: OperatorDeclaration | null = null;
  private version = 0;
  private readonly recordAudit: RecordAudit;
  private readonly now: () => Date;

  constructor(private readonly options: PublicStatusServiceOptions = {}) {
    this.recordAudit = options.recordAudit ?? ((event) => auditStore.recordEvent(event));
    this.now = options.now ?? (() => new Date());
  }

  /** Operator-declared state, synchronous so request gates never wait on probes. */
  currentState(): PublicStatusState {
    return this.declaration?.state ?? 'operational';
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Declares degraded, paused or maintenance. Evidence first: if the audit
   * event cannot be written nothing changes. Optimistic concurrency on
   * `expectedVersion` stops two operators silently overwriting each other.
   */
  declare(request: DeclareStatusRequest): InternalStatus['declaration'] {
    const state = request.state;
    if (typeof state !== 'string' || !(OPERATOR_STATES as readonly string[]).includes(state)) {
      throw new PublicStatusError('INVALID_STATUS_CHANGE', `state must be one of ${OPERATOR_STATES.join(', ')}`);
    }
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
      throw new PublicStatusError('INVALID_STATUS_CHANGE', `reason must explain the change (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters)`);
    }
    const expectedResolutionAt = parseResolution(request.expectedResolutionAt, this.now());
    this.checkVersion(request.expectedVersion);

    const before = this.declaration;
    const evidence = this.audit(request.actorId, reason, before, { state, expectedResolutionAt }, 'status_declared', request.correlationId);
    this.declaration = {
      state: state as OperatorStatusState,
      reason,
      declaredBy: request.actorId,
      declaredAt: this.now().toISOString(),
      expectedResolutionAt,
      auditEventId: evidence.id,
    };
    this.version += 1;
    return { ...this.declaration };
  }

  /** Returns to operational. A no-op (no version bump, no event) when nothing is declared. */
  clear(request: { reason: unknown; expectedVersion: unknown; actorId: string; correlationId?: string }): boolean {
    this.checkVersion(request.expectedVersion);
    if (!this.declaration) return false;
    const reason = typeof request.reason === 'string' && request.reason.trim().length >= MIN_REASON_LENGTH
      ? request.reason.trim()
      : `Cleared ${this.declaration.state} status`;
    this.audit(request.actorId, reason, this.declaration, { state: 'operational' }, 'status_cleared', request.correlationId);
    this.declaration = null;
    this.version += 1;
    return true;
  }

  /** Gate for one capability, from the declared state only. O(1). */
  gate(capability: StatusCapability): StatusGateDecision {
    const state = this.currentState();
    const policy = STATE_POLICY[state];
    const blocked = policy.blocked.includes(capability);
    return {
      allowed: !blocked,
      state,
      code: blocked ? policy.code : 'OK',
      httpStatus: blocked ? 503 : 200,
      retryAfterSeconds: blocked ? policy.retryAfterSeconds : 0,
      message: blocked ? policy.message : '',
    };
  }

  /** Whether the worker may claim a job of this type right now. Held jobs stay queued; no attempt is consumed. */
  backgroundGate(jobType: string): { run: boolean; state: PublicStatusState } {
    const state = this.currentState();
    const held = STATE_POLICY[state].heldJobs;
    return { run: !(held === '*' || held.includes(jobType)), state };
  }

  /** Express middleware for a gated route. Pass-through while operational or degraded. */
  requireCapability(capability: StatusCapability) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const decision = this.gate(capability);
      if (decision.allowed) return next();
      res.set('Retry-After', String(decision.retryAfterSeconds));
      res.set('X-Service-Status', decision.state);
      res.status(503).json({
        success: false,
        code: decision.code,
        error: decision.message,
        status: decision.state,
        retryAfter: decision.retryAfterSeconds,
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
    };
  }

  async internalStatus(): Promise<InternalStatus> {
    let dependencies: DegradedModeStatus | null = null;
    let dependencyState: InternalStatus['dependencyState'] = 'unavailable';
    if (this.options.dependencies) {
      try {
        dependencies = await this.options.dependencies.getStatus();
        dependencyState = dependencies.overall;
      } catch {
        // A failed probe run must not take the status page down or invent an
        // outage. The declared state still applies; operators see 'unavailable'.
        dependencies = null;
      }
    }
    return {
      public: this.project(dependencies),
      declaration: this.declaration ? { ...this.declaration } : null,
      dependencyState,
      version: this.version,
    };
  }

  async publicStatus(): Promise<PublicStatus> {
    return (await this.internalStatus()).public;
  }

  /** Builds the public projection. Only allow-listed, catalog-sourced fields. */
  private project(dependencies: DegradedModeStatus | null): PublicStatus {
    const declared = this.currentState();
    const dependencyDegraded = dependencies !== null && (dependencies.overall === 'degraded' || dependencies.overall === 'down');
    const state: PublicStatusState =
      dependencyDegraded && SEVERITY.degraded > SEVERITY[declared] ? 'degraded' : declared;
    const policy = STATE_POLICY[state];

    const capabilities = {} as Record<StatusCapability, CapabilityAvailability>;
    let retryAfterSeconds = policy.retryAfterSeconds;
    for (const capability of STATUS_CAPABILITIES) {
      if (STATE_POLICY[declared].blocked.includes(capability)) {
        capabilities[capability] = 'unavailable';
        continue;
      }
      const dependencyCapability = DEPENDENCY_CAPABILITY[capability];
      const decision: CapabilityDecision | undefined =
        dependencyCapability && dependencies ? dependencies.capabilities[dependencyCapability] : undefined;
      if (!decision?.fallback) {
        capabilities[capability] = 'available';
      } else {
        capabilities[capability] = decision.fallback.mode === 'refuse' ? 'unavailable' : 'limited';
        retryAfterSeconds = Math.max(retryAfterSeconds, decision.fallback.retryAfterSeconds);
      }
    }

    return {
      state,
      title: policy.title,
      message: policy.message,
      since: this.declaration?.declaredAt ?? (state === 'degraded' ? dependencies?.generatedAt ?? null : null),
      expectedResolutionAt: this.declaration?.expectedResolutionAt ?? null,
      retryAfterSeconds,
      capabilities,
      updatedAt: this.now().toISOString(),
    };
  }

  private checkVersion(expected: unknown): void {
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
      throw new PublicStatusError('INVALID_STATUS_CHANGE', 'expectedVersion must be the current status version (a non-negative integer)');
    }
    if (expected !== this.version) {
      throw new PublicStatusError('STATUS_VERSION_CONFLICT', `Status is at version ${this.version}, not ${expected}; re-read it and retry`);
    }
  }

  private audit(
    actorId: string,
    reason: string,
    before: OperatorDeclaration | null,
    after: Record<string, unknown>,
    change: string,
    correlationId?: string
  ): AuditEvent {
    try {
      return this.recordAudit({
        action: 'CONFIG_CHANGED',
        actor: { type: 'maintainer', id: actorId },
        scope: { entityType: 'config', entityId: 'publicStatus' },
        reason,
        beforeState: { state: before?.state ?? 'operational', statusVersion: this.version },
        afterState: { ...after, statusVersion: this.version + 1 },
        metadata: { configKey: 'publicStatus', change },
        correlationId,
      });
    } catch {
      throw new PublicStatusError('STATUS_AUDIT_UNAVAILABLE', 'Audit evidence could not be recorded, so the status was not changed; retry');
    }
  }
}

function parseResolution(value: unknown, now: Date): string | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new PublicStatusError('INVALID_STATUS_CHANGE', 'expectedResolutionAt must be a future ISO-8601 timestamp');
  }
  return parsed.toISOString();
}

/** `GET /api/status`. Public, unauthenticated, `{ success, data }` envelope, never 5xx for a declared state. */
export function publicStatusHandler(service: PublicStatusService) {
  return async (req: Request, res: Response) => {
    let status: PublicStatus;
    try {
      status = await service.publicStatus();
    } catch {
      const state = service.currentState();
      status = {
        state,
        title: STATE_POLICY[state].title,
        message: STATE_POLICY[state].message,
        since: null,
        expectedResolutionAt: null,
        retryAfterSeconds: STATE_POLICY[state].retryAfterSeconds,
        capabilities: Object.fromEntries(
          STATUS_CAPABILITIES.map((c) => [c, service.gate(c).allowed ? 'available' : 'unavailable'])
        ) as PublicStatus['capabilities'],
        updatedAt: new Date().toISOString(),
      };
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: status, ...(req.correlationId ? { correlationId: req.correlationId } : {}) });
  };
}

export const publicStatusService = new PublicStatusService();
