/**
 * Security-event session invalidation (Issue #433).
 *
 * When a security-relevant event is detected — a compromised credential,
 * suspicious activity, forced sign-out, or an external alert — all active
 * sessions and outstanding capability tokens for the affected subject must be
 * torn down immediately so the principal cannot continue to act on stale
 * authority.
 *
 * This module coordinates that invalidation across the two in-process
 * authority surfaces:
 *
 *  1. `ImpersonationService` — open maintainer impersonation sessions.
 *  2. `CapabilityTokenService` — short-lived signed capability tokens.
 *
 * Both are terminated in a single atomic-from-the-caller's-perspective call.
 * The result is written to the audit trail with every session and capability
 * that was invalidated so the event is fully reconstructable after the fact.
 *
 * Design invariants
 * ─────────────────
 * • Idempotent: calling `invalidate` twice for the same subject and reason
 *   produces one audit event per call but causes no errors; the second call
 *   simply finds nothing left to invalidate.
 * • Fail-open on audit: an audit write failure never prevents the underlying
 *   session/capability invalidation. The security guarantee is in the
 *   revocation, not the log.
 * • Fail-closed on revocation: a revocation error (e.g. malformed subject)
 *   propagates to the caller so the HTTP layer can return an appropriate status
 *   rather than silently succeeding.
 * • No external I/O: everything is in-process and synchronous; the caller
 *   is responsible for triggering follow-up notifications (e.g. via the
 *   security.alert notification type declared in domain-events.ts).
 *
 * See docs/SECURITY_EVENT_INVALIDATION.md.
 */

import { ImpersonationService } from '../audit/impersonation';
import { CapabilityTokenService } from './capability-tokens';
import { type MemoryAuditStore } from '../audit/audit-service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The event category that triggered the invalidation.
 * Stored in the audit trail and can be used by downstream consumers
 * (e.g. notification routing) to decide the alert severity.
 */
export type SecurityEventKind =
  | 'credential_compromised'   // A secret or token was leaked or stolen
  | 'suspicious_activity'      // Anomalous behaviour detected for the subject
  | 'forced_signout'           // An admin or owner explicitly signed the subject out
  | 'account_locked'           // The subject's account was locked/disabled
  | 'mfa_bypass_detected'      // Multi-factor was bypassed unexpectedly
  | 'policy_violation'         // The subject violated a security policy
  | 'external_alert';          // An external system (SIEM, WAF, etc.) raised an alert

export interface SecurityEventInvalidationInput {
  /**
   * The principal whose sessions and capabilities should be revoked.
   * For impersonation sessions this is the `maintainerId`; for capability
   * tokens this is the `subject` field in the signed claims.
   */
  subjectId: string;
  kind: SecurityEventKind;
  /**
   * Human-readable justification. Required; must be at least 10 characters
   * so an operator cannot create an audit entry without context.
   */
  reason: string;
  /** The actor (operator/system) that triggered the invalidation. */
  triggeredBy: string;
  /** Optional correlation id from the upstream request. */
  correlationId?: string;
  /** Optional IP address of the triggering actor. */
  ip?: string;
  /** Optional user-agent of the triggering actor. */
  userAgent?: string;
}

export interface InvalidatedSession {
  sessionId: string;
  targetId: string;
  startedAt: string;
  permissions: string[];
}

export interface SecurityEventInvalidationResult {
  invalidatedAt: string;
  subjectId: string;
  kind: SecurityEventKind;
  reason: string;
  triggeredBy: string;
  /** Impersonation sessions that were terminated. */
  invalidatedSessions: InvalidatedSession[];
  /**
   * Whether the capability token subject-revocation was applied.
   * True means all capability tokens issued to `subjectId` at or before
   * the invalidation timestamp are now rejected.
   */
  capabilitiesRevoked: boolean;
  /** Audit event id written to the trail. */
  auditEventId: string;
}

export class SecurityEventInvalidationError extends Error {
  readonly httpStatus = 400;
  readonly code = 'SECURITY_INVALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'SecurityEventInvalidationError';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SecurityEventInvalidatorOptions {
  impersonation: ImpersonationService;
  capabilities: CapabilityTokenService | null;
  audit: MemoryAuditStore;
  now?: () => Date;
}

export class SecurityEventInvalidator {
  private readonly impersonation: ImpersonationService;
  private readonly capabilities: CapabilityTokenService | null;
  private readonly audit: MemoryAuditStore;
  private readonly now: () => Date;

  constructor(options: SecurityEventInvalidatorOptions) {
    this.impersonation = options.impersonation;
    this.capabilities = options.capabilities;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Invalidates all active impersonation sessions and capability tokens for
   * `input.subjectId` as a result of the named security event.
   *
   * @throws {SecurityEventInvalidationError}  when input validation fails
   */
  invalidate(input: SecurityEventInvalidationInput): SecurityEventInvalidationResult {
    // ── Input validation ──────────────────────────────────────────────────
    const subjectId = String(input.subjectId ?? '').trim();
    if (!subjectId) {
      throw new SecurityEventInvalidationError('subjectId is required');
    }
    if (subjectId.length > 256) {
      throw new SecurityEventInvalidationError('subjectId must not exceed 256 characters');
    }
    const triggeredBy = String(input.triggeredBy ?? '').trim();
    if (!triggeredBy) {
      throw new SecurityEventInvalidationError('triggeredBy is required');
    }
    const reason = String(input.reason ?? '').trim();
    if (!reason || reason.length < 10) {
      throw new SecurityEventInvalidationError(
        'reason must be at least 10 characters so the audit trail is meaningful',
      );
    }
    if (!isValidKind(input.kind)) {
      throw new SecurityEventInvalidationError(
        `kind must be one of: ${VALID_KINDS.join(', ')}`,
      );
    }

    const invalidatedAt = this.now().toISOString();

    // ── 1. Terminate active impersonation sessions ────────────────────────
    const allSessions = this.impersonation.listSessions(true);
    const activeSessions = allSessions.filter(
      (s) => s.maintainerId === subjectId && !s.endedAt,
    );

    const invalidatedSessions: InvalidatedSession[] = [];
    for (const session of activeSessions) {
      // Uses the dedicated security-event end path: stamps endReason =
      // 'security_event' and audits as IMPERSONATION_REVOKED.
      this.impersonation.endSessionForSecurityEvent(session.id);
      invalidatedSessions.push({
        sessionId: session.id,
        targetId: session.targetId,
        startedAt: session.startedAt,
        permissions: session.permissions,
      });
    }

    // ── 2. Revoke capability token subject ────────────────────────────────
    let capabilitiesRevoked = false;
    if (this.capabilities !== null) {
      try {
        // revokeSubject returns true when a new cutoff is set, false when one
        // already covers now. Either way the subject is revoked.
        this.capabilities.revokeSubject(subjectId);
        capabilitiesRevoked = true;
      } catch {
        // revokeSubject throws CapabilityError on bad input (empty/too-long
        // subject); re-throw so the caller gets a clear error.
        throw new SecurityEventInvalidationError(
          `Failed to revoke capabilities for subject "${subjectId}": subject identifier rejected by capability service`,
        );
      }
    }

    // ── 3. Write audit event ──────────────────────────────────────────────
    let auditEventId = '';
    try {
      const event = this.audit.recordEvent({
        // 'MAINTAINER_ACTION' is the closest existing AuditAction for
        // admin-initiated security operations. Issue #433 adds
        // 'SECURITY_SESSION_INVALIDATED' as a new AuditAction; until that
        // migration is applied we use MAINTAINER_ACTION with a discriminating
        // metadata key so existing consumers are not broken.
        action: 'MAINTAINER_ACTION',
        actor: {
          type: 'maintainer',
          id: triggeredBy,
          ip: input.ip,
          userAgent: input.userAgent,
        },
        scope: { entityType: 'system', entityId: subjectId },
        reason,
        metadata: {
          securityEvent: true,
          kind: input.kind,
          subjectId,
          invalidatedSessionCount: invalidatedSessions.length,
          invalidatedSessionIds: invalidatedSessions.map((s) => s.sessionId),
          capabilitiesRevoked,
          invalidatedAt,
        },
        correlationId: input.correlationId,
      });
      auditEventId = event.id;
    } catch {
      // Audit failures must never block the security action. Log to stderr and
      // continue — the revocations are already committed.
      console.error(
        `[SecurityEventInvalidator] Audit write failed for subject="${subjectId}" kind="${input.kind}"`,
      );
    }

    return {
      invalidatedAt,
      subjectId,
      kind: input.kind,
      reason,
      triggeredBy,
      invalidatedSessions,
      capabilitiesRevoked,
      auditEventId,
    };
  }

  /**
   * Checks whether a subject currently has any active impersonation sessions
   * or any live capability tokens (capability liveness cannot be queried
   * directly, so we can only report whether a revocation is on record).
   *
   * Useful for pre-flight checks before triggering a full invalidation.
   */
  status(subjectId: string): {
    activeSessions: number;
    capabilityServiceAvailable: boolean;
  } {
    const all = this.impersonation.listSessions(true);
    const active = all.filter((s) => s.maintainerId === subjectId && !s.endedAt).length;
    return {
      activeSessions: active,
      capabilityServiceAvailable: this.capabilities !== null,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KINDS: SecurityEventKind[] = [
  'credential_compromised',
  'suspicious_activity',
  'forced_signout',
  'account_locked',
  'mfa_bypass_detected',
  'policy_violation',
  'external_alert',
];

function isValidKind(value: unknown): value is SecurityEventKind {
  return VALID_KINDS.includes(value as SecurityEventKind);
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

/**
 * Creates a `SecurityEventInvalidator` wired to the process-level singletons.
 * Returns null when neither impersonation sessions nor capability tokens are
 * available (i.e. the caller should disable the route).
 */
export function createSecurityEventInvalidator(
  impersonation: ImpersonationService,
  capabilities: CapabilityTokenService | null,
  audit: MemoryAuditStore,
): SecurityEventInvalidator {
  return new SecurityEventInvalidator({ impersonation, capabilities, audit });
}
