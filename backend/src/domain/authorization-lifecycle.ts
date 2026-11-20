/**
 * Stale authorization cleanup and audited renewal (issue #199).
 *
 * Delegations, approvals and API access grants are time-bounded. This module
 * owns their lifecycle:
 *
 *   active ──(expiresAt passes)──> expired ──(cleanup after grace)──> cleaned
 *     │                               │
 *     │                               └──(renew: request + confirm)──> renewed ─> new active grant
 *     └──(revoke)──> revoked
 *
 * Invariants:
 *  - Expiry is evaluated at check time from `expiresAt`, never from the stored
 *    status. A grant the cleanup job has not reached yet still cannot authorize
 *    anything once it has expired (fail closed).
 *  - Cleanup is a report by default (`dryRun: true`). Applying it marks grants
 *    `cleaned` (a tombstone, never a delete) and writes one audit event each.
 *  - Renewal is two-step. The subject, grantor or an org OWNER/ADMIN requests;
 *    a *different* OWNER/ADMIN confirms by echoing `RENEW <grantId>`. Neither
 *    the subject nor the requester can confirm their own renewal.
 *  - Renewal never extends a grant in place: it supersedes the old grant
 *    (`renewed`) and issues a new one linked by renewedFromId/renewedToId, so
 *    the history of who held what, and when, is preserved.
 *  - Revoked, cleaned and already-renewed grants are not renewable; a fresh
 *    grant is required. Revoking a grant cancels its pending renewal request.
 *  - Every state change emits an audit event through the shared audit store.
 *
 * See docs/AUTHORIZATION_LIFECYCLE.md.
 */
import { randomUUID } from 'crypto';
import type { AuditEvent } from '../audit/audit-service';
import type { CollaborationRole } from './invitation';
import { ROLE_HIERARCHY } from './invitation';

export type AuthorizationKind = 'delegation' | 'approval' | 'api_access';
export type StoredAuthorizationStatus = 'active' | 'revoked' | 'cleaned' | 'renewed';
export type EffectiveAuthorizationState = 'active' | 'expired' | 'revoked' | 'cleaned' | 'renewed';

export interface AuthorizationScope {
  action: string;
  resourceType: 'organization' | 'invoice';
  resourceId: string;
}

export interface AuthorizationGrant {
  id: string;
  kind: AuthorizationKind;
  subjectId: string;
  grantedBy: string;
  scope: AuthorizationScope;
  status: StoredAuthorizationStatus;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
  cleanedAt?: Date;
  renewedFromId?: string;
  renewedToId?: string;
}

export type RenewalRequestStatus = 'pending' | 'confirmed' | 'rejected' | 'expired' | 'cancelled';

export interface RenewalRequest {
  id: string;
  grantId: string;
  requestedBy: string;
  reason: string;
  ttlMs: number;
  confirmationPhrase: string;
  status: RenewalRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  decidedBy?: string;
  decidedAt?: Date;
  decisionReason?: string;
  newGrantId?: string;
}

export interface LifecycleActor {
  id: string;
  /** SYSTEM is the scheduled cleanup job; it may clean but never grant or renew. */
  role: CollaborationRole | 'SYSTEM';
}

export interface AuthorizationLifecyclePolicy {
  /** Longest TTL a grant or renewal of each kind may receive. */
  maxTtlMs: Record<AuthorizationKind, number>;
  /** Grants expiring within this window are reported as renewal candidates. */
  renewalWindowMs: number;
  /** Expired grants are cleaned only after this grace, leaving time to renew. */
  cleanupGraceMs: number;
  /** How long a renewal request waits for confirmation. */
  renewalRequestTtlMs: number;
}

const DAY = 24 * 60 * 60_000;

export const DEFAULT_AUTHORIZATION_POLICY: AuthorizationLifecyclePolicy = {
  maxTtlMs: { delegation: 90 * DAY, approval: 7 * DAY, api_access: 30 * DAY },
  renewalWindowMs: 7 * DAY,
  cleanupGraceMs: 1 * DAY,
  renewalRequestTtlMs: 3 * DAY,
};

/** Structural subset of MemoryAuditStore so the real store plugs in directly. */
export interface AuthorizationAuditSink {
  recordEvent(input: Omit<AuditEvent, 'id' | 'timestamp'> & { timestamp?: string }): unknown;
}

export type AuthorizationErrorCode =
  | 'AUTHORIZATION_NOT_FOUND'
  | 'RENEWAL_REQUEST_NOT_FOUND'
  | 'AUTHORIZATION_FORBIDDEN'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_NOT_RENEWABLE'
  | 'AUTHORIZATION_INVALID_STATE'
  | 'RENEWAL_ALREADY_PENDING'
  | 'RENEWAL_NOT_PENDING'
  | 'RENEWAL_REQUEST_EXPIRED'
  | 'RENEWAL_SELF_CONFIRMATION'
  | 'RENEWAL_CONFIRMATION_MISMATCH'
  | 'AUTHORIZATION_INVALID_INPUT';

const HTTP_STATUS: Record<AuthorizationErrorCode, number> = {
  AUTHORIZATION_NOT_FOUND: 404,
  RENEWAL_REQUEST_NOT_FOUND: 404,
  AUTHORIZATION_FORBIDDEN: 403,
  AUTHORIZATION_DENIED: 403,
  AUTHORIZATION_NOT_RENEWABLE: 409,
  AUTHORIZATION_INVALID_STATE: 409,
  RENEWAL_ALREADY_PENDING: 409,
  RENEWAL_NOT_PENDING: 409,
  RENEWAL_REQUEST_EXPIRED: 410,
  RENEWAL_SELF_CONFIRMATION: 403,
  RENEWAL_CONFIRMATION_MISMATCH: 400,
  AUTHORIZATION_INVALID_INPUT: 400,
};

export class AuthorizationLifecycleError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: AuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'AuthorizationLifecycleError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export type AuthorizationDecisionReason = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CLEANED' | 'RENEWED' | 'NO_GRANT';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationDecisionReason;
  grantId?: string;
}

export interface StaleAuthorizationReport {
  generatedAt: string;
  /** Past expiresAt but still stored as active. */
  expired: Array<{ grant: AuthorizationGrant; expiredForMs: number; eligibleForCleanup: boolean; pendingRenewalId?: string }>;
  /** Still active, expiring inside the renewal window. */
  expiringSoon: Array<{ grant: AuthorizationGrant; expiresInMs: number; pendingRenewalId?: string }>;
  counts: { active: number; expired: number; eligibleForCleanup: number; expiringSoon: number; revoked: number; cleaned: number; renewed: number };
}

export interface CleanupResult {
  dryRun: boolean;
  cleaned: string[];
  /** Expired grants left alone because they are still inside the grace period. */
  inGrace: string[];
  cancelledRenewals: string[];
}

const isManager = (actor: LifecycleActor) => actor.role !== 'SYSTEM' && ROLE_HIERARCHY[actor.role] >= ROLE_HIERARCHY.ADMIN;
const clone = <T extends object>(value: T): T => structuredClone(value);
const DENIAL_PRIORITY: AuthorizationDecisionReason[] = ['EXPIRED', 'RENEWED', 'REVOKED', 'CLEANED'];

export interface AuthorizationLifecycleOptions {
  audit?: AuthorizationAuditSink;
  now?: () => Date;
  policy?: Partial<AuthorizationLifecyclePolicy>;
  idGenerator?: () => string;
}

export class AuthorizationLifecycle {
  private readonly grants = new Map<string, AuthorizationGrant>();
  private readonly renewals = new Map<string, RenewalRequest>();
  private readonly now: () => Date;
  private readonly policy: AuthorizationLifecyclePolicy;
  private readonly newId: () => string;

  constructor(private readonly options: AuthorizationLifecycleOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.policy = { ...DEFAULT_AUTHORIZATION_POLICY, ...options.policy };
    this.newId = options.idGenerator ?? randomUUID;
  }

  /** Hydrates existing grants (from storage or seed fixtures). No audit events. */
  load(grants: AuthorizationGrant[]): this {
    for (const g of grants) this.grants.set(g.id, clone(g));
    return this;
  }

  get(id: string): AuthorizationGrant | undefined {
    const g = this.grants.get(id);
    return g ? clone(g) : undefined;
  }

  getRenewal(id: string): RenewalRequest | undefined {
    const r = this.renewals.get(id);
    return r ? clone(r) : undefined;
  }

  list(): AuthorizationGrant[] {
    return [...this.grants.values()].map(clone);
  }

  effectiveState(grant: AuthorizationGrant, at: Date = this.now()): EffectiveAuthorizationState {
    if (grant.status !== 'active') return grant.status;
    return at.getTime() >= grant.expiresAt.getTime() ? 'expired' : 'active';
  }

  grant(
    input: { kind: AuthorizationKind; subjectId: string; scope: AuthorizationScope; ttlMs?: number },
    actor: LifecycleActor
  ): AuthorizationGrant {
    if (!isManager(actor)) throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Only an OWNER or ADMIN can grant authorizations');
    const ttlMs = this.boundedTtl(input.kind, input.ttlMs);
    if (!input.subjectId || !input.scope?.action || !input.scope?.resourceId) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_INVALID_INPUT', 'subjectId and scope are required');
    }
    const now = this.now();
    const grant: AuthorizationGrant = {
      id: this.newId(),
      kind: input.kind,
      subjectId: input.subjectId,
      grantedBy: actor.id,
      scope: { ...input.scope },
      status: 'active',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    this.grants.set(grant.id, grant);
    this.audit('AUTHORIZATION_GRANTED', actor, grant.id, null, grant);
    return clone(grant);
  }

  /** Read-only authorization decision for a protected action. */
  check(subjectId: string, action: string, resource: { type: AuthorizationScope['resourceType']; id: string }): AuthorizationDecision {
    const now = this.now();
    const matches = [...this.grants.values()].filter(
      (g) => g.subjectId === subjectId && g.scope.action === action && g.scope.resourceType === resource.type && g.scope.resourceId === resource.id
    );
    const active = matches.find((g) => this.effectiveState(g, now) === 'active');
    if (active) return { allowed: true, reason: 'ACTIVE', grantId: active.id };
    for (const reason of DENIAL_PRIORITY) {
      const hit = matches.find((g) => this.effectiveState(g, now).toUpperCase() === reason);
      if (hit) return { allowed: false, reason, grantId: hit.id };
    }
    return { allowed: false, reason: 'NO_GRANT' };
  }

  /**
   * Guard for protected actions. Throws AUTHORIZATION_DENIED; a denial caused by
   * a stale grant (expired/revoked/cleaned/renewed) is audited.
   */
  assertAllowed(subjectId: string, action: string, resource: { type: AuthorizationScope['resourceType']; id: string }): AuthorizationDecision {
    const decision = this.check(subjectId, action, resource);
    if (decision.allowed) return decision;
    if (decision.grantId) {
      this.audit('AUTHORIZATION_DENIED', { id: subjectId, role: 'VIEWER' }, decision.grantId, null, null, {
        action,
        resourceType: resource.type,
        resourceId: resource.id,
        reason: decision.reason,
      });
    }
    throw new AuthorizationLifecycleError('AUTHORIZATION_DENIED', `${action} on ${resource.type}:${resource.id} denied (${decision.reason})`);
  }

  /** Read-only report of grants that need expiry handling or renewal. */
  findStale(options: { renewalWindowMs?: number; graceMs?: number } = {}): StaleAuthorizationReport {
    const now = this.now();
    const window = options.renewalWindowMs ?? this.policy.renewalWindowMs;
    const grace = options.graceMs ?? this.policy.cleanupGraceMs;
    const report: StaleAuthorizationReport = {
      generatedAt: now.toISOString(),
      expired: [],
      expiringSoon: [],
      counts: { active: 0, expired: 0, eligibleForCleanup: 0, expiringSoon: 0, revoked: 0, cleaned: 0, renewed: 0 },
    };
    const sorted = [...this.grants.values()].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || (a.id < b.id ? -1 : 1));
    for (const g of sorted) {
      const state = this.effectiveState(g, now);
      report.counts[state]++;
      const pendingRenewalId = this.pendingRenewalFor(g.id)?.id;
      if (state === 'expired') {
        const expiredForMs = now.getTime() - g.expiresAt.getTime();
        const eligibleForCleanup = expiredForMs >= grace;
        if (eligibleForCleanup) report.counts.eligibleForCleanup++;
        report.expired.push({ grant: clone(g), expiredForMs, eligibleForCleanup, ...(pendingRenewalId ? { pendingRenewalId } : {}) });
      } else if (state === 'active') {
        const expiresInMs = g.expiresAt.getTime() - now.getTime();
        if (expiresInMs <= window) {
          report.counts.expiringSoon++;
          report.expiringSoon.push({ grant: clone(g), expiresInMs, ...(pendingRenewalId ? { pendingRenewalId } : {}) });
        }
      }
    }
    return report;
  }

  /**
   * Marks expired grants past the grace period as `cleaned`. Dry run unless
   * `dryRun: false` is passed explicitly.
   */
  cleanup(options: { actor: LifecycleActor; dryRun?: boolean; graceMs?: number }): CleanupResult {
    const { actor } = options;
    if (actor.role !== 'SYSTEM' && !isManager(actor)) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Cleanup requires the system job or an OWNER/ADMIN');
    }
    const dryRun = options.dryRun !== false;
    const report = this.findStale({ graceMs: options.graceMs });
    const result: CleanupResult = { dryRun, cleaned: [], inGrace: [], cancelledRenewals: [] };
    const now = this.now();

    for (const entry of report.expired) {
      if (!entry.eligibleForCleanup) {
        result.inGrace.push(entry.grant.id);
        continue;
      }
      result.cleaned.push(entry.grant.id);
      if (entry.pendingRenewalId) result.cancelledRenewals.push(entry.pendingRenewalId);
      if (dryRun) continue;

      const grant = this.grants.get(entry.grant.id)!;
      const before = clone(grant);
      grant.status = 'cleaned';
      grant.cleanedAt = now;
      this.audit('AUTHORIZATION_CLEANED', actor, grant.id, before, grant, { expiredForMs: entry.expiredForMs });
      if (entry.pendingRenewalId) this.closeRenewal(entry.pendingRenewalId, 'cancelled', actor, 'grant cleaned');
    }
    return result;
  }

  requestRenewal(grantId: string, input: { actor: LifecycleActor; reason: string; ttlMs?: number }): RenewalRequest {
    const grant = this.mustGetGrant(grantId);
    const { actor } = input;
    if (actor.role === 'SYSTEM' || (actor.id !== grant.subjectId && actor.id !== grant.grantedBy && !isManager(actor))) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Only the subject, the grantor or an OWNER/ADMIN can request renewal');
    }
    if (!input.reason || !input.reason.trim()) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_INVALID_INPUT', 'A renewal reason is required for the audit trail');
    }
    this.assertRenewable(grant);
    if (this.pendingRenewalFor(grantId)) {
      throw new AuthorizationLifecycleError('RENEWAL_ALREADY_PENDING', `Grant ${grantId} already has a pending renewal request`);
    }
    const now = this.now();
    const request: RenewalRequest = {
      id: this.newId(),
      grantId,
      requestedBy: actor.id,
      reason: input.reason.trim(),
      ttlMs: this.boundedTtl(grant.kind, input.ttlMs),
      confirmationPhrase: `RENEW ${grantId}`,
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.policy.renewalRequestTtlMs),
    };
    this.renewals.set(request.id, request);
    this.audit('AUTHORIZATION_RENEWAL_REQUESTED', actor, grantId, null, null, {
      renewalRequestId: request.id,
      reason: request.reason,
      ttlMs: request.ttlMs,
      state: this.effectiveState(grant),
    });
    return clone(request);
  }

  /** Second step: a different OWNER/ADMIN confirms. Returns the new grant. */
  confirmRenewal(requestId: string, input: { actor: LifecycleActor; confirmation: string }): AuthorizationGrant {
    const request = this.mustGetPendingRenewal(requestId, input.actor);
    const grant = this.mustGetGrant(request.grantId);
    const { actor } = input;
    if (!isManager(actor)) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Renewal must be confirmed by an OWNER or ADMIN');
    }
    if (actor.id === grant.subjectId || actor.id === request.requestedBy) {
      throw new AuthorizationLifecycleError('RENEWAL_SELF_CONFIRMATION', 'The subject or requester cannot confirm their own renewal');
    }
    if (input.confirmation !== request.confirmationPhrase) {
      throw new AuthorizationLifecycleError('RENEWAL_CONFIRMATION_MISMATCH', `Type "${request.confirmationPhrase}" to confirm`);
    }
    this.assertRenewable(grant);

    const now = this.now();
    const before = clone(grant);
    const renewed: AuthorizationGrant = {
      id: this.newId(),
      kind: grant.kind,
      subjectId: grant.subjectId,
      grantedBy: actor.id,
      scope: { ...grant.scope },
      status: 'active',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + request.ttlMs),
      renewedFromId: grant.id,
    };
    grant.status = 'renewed';
    grant.renewedToId = renewed.id;
    this.grants.set(renewed.id, renewed);
    request.status = 'confirmed';
    request.decidedBy = actor.id;
    request.decidedAt = now;
    request.newGrantId = renewed.id;

    this.audit('AUTHORIZATION_RENEWED', actor, grant.id, before, clone(grant), {
      renewalRequestId: request.id,
      requestedBy: request.requestedBy,
      newGrantId: renewed.id,
      newExpiresAt: renewed.expiresAt.toISOString(),
    });
    return clone(renewed);
  }

  rejectRenewal(requestId: string, input: { actor: LifecycleActor; reason: string }): RenewalRequest {
    const request = this.mustGetPendingRenewal(requestId, input.actor);
    if (!isManager(input.actor)) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Renewal must be rejected by an OWNER or ADMIN');
    }
    this.closeRenewal(request.id, 'rejected', input.actor, input.reason);
    this.audit('AUTHORIZATION_RENEWAL_REJECTED', input.actor, request.grantId, null, null, { renewalRequestId: request.id, reason: input.reason });
    return clone(request);
  }

  revoke(grantId: string, input: { actor: LifecycleActor; reason: string }): AuthorizationGrant {
    const grant = this.mustGetGrant(grantId);
    const { actor } = input;
    if (actor.role === 'SYSTEM' || (!isManager(actor) && actor.id !== grant.grantedBy)) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_FORBIDDEN', 'Only the grantor or an OWNER/ADMIN can revoke');
    }
    const state = this.effectiveState(grant);
    if (state !== 'active' && state !== 'expired') {
      throw new AuthorizationLifecycleError('AUTHORIZATION_INVALID_STATE', `Grant ${grantId} is already ${state}`);
    }
    const before = clone(grant);
    grant.status = 'revoked';
    grant.revokedAt = this.now();
    grant.revokedBy = actor.id;
    this.audit('AUTHORIZATION_REVOKED', actor, grantId, before, grant, { reason: input.reason });
    const pending = this.pendingRenewalFor(grantId);
    if (pending) this.closeRenewal(pending.id, 'cancelled', actor, 'grant revoked');
    return clone(grant);
  }

  // -------------------------------------------------------------------------

  private boundedTtl(kind: AuthorizationKind, ttlMs?: number): number {
    const max = this.policy.maxTtlMs[kind];
    if (max === undefined) throw new AuthorizationLifecycleError('AUTHORIZATION_INVALID_INPUT', `Unknown authorization kind ${kind}`);
    const ttl = ttlMs ?? max;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > max) {
      throw new AuthorizationLifecycleError('AUTHORIZATION_INVALID_INPUT', `ttlMs for ${kind} must be between 1 and ${max}`);
    }
    return ttl;
  }

  private assertRenewable(grant: AuthorizationGrant): void {
    const state = this.effectiveState(grant);
    if (state !== 'active' && state !== 'expired') {
      throw new AuthorizationLifecycleError('AUTHORIZATION_NOT_RENEWABLE', `Grant ${grant.id} is ${state}; issue a new grant instead`);
    }
  }

  private mustGetGrant(id: string): AuthorizationGrant {
    const g = this.grants.get(id);
    if (!g) throw new AuthorizationLifecycleError('AUTHORIZATION_NOT_FOUND', `Authorization ${id} not found`);
    return g;
  }

  private mustGetPendingRenewal(id: string, actor: LifecycleActor): RenewalRequest {
    const r = this.renewals.get(id);
    if (!r) throw new AuthorizationLifecycleError('RENEWAL_REQUEST_NOT_FOUND', `Renewal request ${id} not found`);
    if (r.status !== 'pending') throw new AuthorizationLifecycleError('RENEWAL_NOT_PENDING', `Renewal request ${id} is ${r.status}`);
    if (this.now().getTime() >= r.expiresAt.getTime()) {
      this.closeRenewal(r.id, 'expired', actor, 'confirmation window elapsed');
      throw new AuthorizationLifecycleError('RENEWAL_REQUEST_EXPIRED', `Renewal request ${id} expired; submit a new request`);
    }
    return r;
  }

  private pendingRenewalFor(grantId: string): RenewalRequest | undefined {
    const now = this.now().getTime();
    for (const r of this.renewals.values()) {
      if (r.grantId === grantId && r.status === 'pending' && now < r.expiresAt.getTime()) return r;
    }
    return undefined;
  }

  private closeRenewal(id: string, status: Exclude<RenewalRequestStatus, 'pending' | 'confirmed'>, actor: LifecycleActor, reason: string): void {
    const r = this.renewals.get(id);
    if (!r || r.status !== 'pending') return;
    r.status = status;
    r.decidedBy = actor.id;
    r.decidedAt = this.now();
    r.decisionReason = reason;
  }

  private audit(
    action: AuditEvent['action'],
    actor: LifecycleActor,
    grantId: string,
    before: AuthorizationGrant | null,
    after: AuthorizationGrant | null,
    metadata?: Record<string, unknown>
  ): void {
    this.options.audit?.recordEvent({
      action,
      actor: { type: actor.role === 'SYSTEM' ? 'system' : isManager(actor) ? 'maintainer' : 'seller', id: actor.id },
      scope: { entityType: 'authorization', entityId: grantId },
      beforeState: before ? JSON.parse(JSON.stringify(before)) : null,
      afterState: after ? JSON.parse(JSON.stringify(after)) : null,
      metadata,
      timestamp: this.now().toISOString(),
    });
  }
}

/** Job payload for AUTHORIZATION_CLEANUP_JOB: `{ dryRun?: boolean, graceMs?: number }`. */
export function createAuthorizationCleanupHandler(lifecycle: AuthorizationLifecycle) {
  return async (payload: { data?: { dryRun?: boolean; graceMs?: number } }) =>
    lifecycle.cleanup({
      actor: { id: 'system:authorization-cleanup', role: 'SYSTEM' },
      dryRun: payload?.data?.dryRun === true,
      graceMs: payload?.data?.graceMs,
    });
}
