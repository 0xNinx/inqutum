import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuditStore } from '../src/audit/audit-service';
import {
  AuthorizationLifecycle,
  AuthorizationLifecycleError,
  createAuthorizationCleanupHandler,
  type LifecycleActor,
} from '../src/domain/authorization-lifecycle';
import { AUTHORIZATION_CLEANUP_JOB, registerJobHandlers } from '../src/jobs/runtime';
import { SEED_IDS, buildSeedDataset } from '../src/sandbox/seed-fixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER: LifecycleActor = { id: SEED_IDS.owner, role: 'OWNER' };
const ADMIN: LifecycleActor = { id: SEED_IDS.admin, role: 'ADMIN' };
const SECOND_ADMIN: LifecycleActor = { id: 'seed-user-admin-2', role: 'ADMIN' };
const COLLAB: LifecycleActor = { id: SEED_IDS.collaborator, role: 'COLLABORATOR' };
const SYSTEM: LifecycleActor = { id: 'system:test', role: 'SYSTEM' };

const rejectsWith = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof AuthorizationLifecycleError && e.code === code);

describe('Authorization lifecycle: expiry, cleanup and renewal (#199)', () => {
  let clock: Date;
  let audit: MemoryAuditStore;
  let lifecycle: AuthorizationLifecycle;
  let n: number;
  const actions = () => audit.listChronological().map((e) => e.action);

  beforeEach(() => {
    const ds = buildSeedDataset();
    clock = new Date(ds.anchor);
    audit = new MemoryAuditStore();
    n = 0;
    lifecycle = new AuthorizationLifecycle({ audit, now: () => clock, idGenerator: () => `gen-${++n}` }).load(ds.authorizations);
  });

  describe('active and expired states', () => {
    it('active grants allow the protected action', () => {
      const d = lifecycle.assertAllowed(SEED_IDS.admin, 'invoice.cancel', { type: 'organization', id: SEED_IDS.orgA });
      assert.deepEqual(d, { allowed: true, reason: 'ACTIVE', grantId: SEED_IDS.authAdminDelegation });
    });

    it('expired grants no longer allow protected actions, even before cleanup runs', () => {
      // Stored status is still "active"; expiry is evaluated at check time.
      assert.equal(lifecycle.get(SEED_IDS.authApiExpired)!.status, 'active');
      const d = lifecycle.check(SEED_IDS.sellerB, 'invoice.read', { type: 'organization', id: SEED_IDS.orgB });
      assert.deepEqual(d, { allowed: false, reason: 'EXPIRED', grantId: SEED_IDS.authApiExpired });
      rejectsWith(() => lifecycle.assertAllowed(SEED_IDS.sellerB, 'invoice.read', { type: 'organization', id: SEED_IDS.orgB }), 'AUTHORIZATION_DENIED');
      assert.deepEqual(actions(), ['AUTHORIZATION_DENIED']);
    });

    it('a grant flips to expired exactly at expiresAt', () => {
      const grant = lifecycle.get(SEED_IDS.authApprovalExpiring)!;
      const scope = { type: 'invoice' as const, id: SEED_IDS.invFailedSettlement };
      clock = new Date(grant.expiresAt.getTime() - 1);
      assert.equal(lifecycle.check(SEED_IDS.admin, 'job.requeue_dead', scope).allowed, true);
      clock = new Date(grant.expiresAt.getTime());
      assert.equal(lifecycle.check(SEED_IDS.admin, 'job.requeue_dead', scope).reason, 'EXPIRED');
    });

    it('unknown subject/action is NO_GRANT and is not audited', () => {
      rejectsWith(() => lifecycle.assertAllowed('nobody', 'invoice.cancel', { type: 'organization', id: SEED_IDS.orgA }), 'AUTHORIZATION_DENIED');
      assert.deepEqual(actions(), []);
    });
  });

  describe('stale report and cleanup', () => {
    it('reports expired grants and renewal candidates without changing anything', () => {
      const before = lifecycle.list();
      const report = lifecycle.findStale();
      assert.deepEqual(report.expired.map((e) => e.grant.id), [SEED_IDS.authApiExpired]);
      assert.equal(report.expired[0].eligibleForCleanup, true);
      assert.deepEqual(report.expiringSoon.map((e) => e.grant.id), [SEED_IDS.authApprovalExpiring]);
      assert.deepEqual(report.counts, { active: 3, expired: 1, eligibleForCleanup: 1, expiringSoon: 1, revoked: 1, cleaned: 1, renewed: 1 });
      assert.deepEqual(lifecycle.list(), before);
      assert.deepEqual(actions(), []);
    });

    it('cleanup is a dry run by default', () => {
      const result = lifecycle.cleanup({ actor: ADMIN });
      assert.equal(result.dryRun, true);
      assert.deepEqual(result.cleaned, [SEED_IDS.authApiExpired]);
      assert.equal(lifecycle.get(SEED_IDS.authApiExpired)!.status, 'active');
      assert.deepEqual(actions(), []);
    });

    it('applied cleanup tombstones expired grants and audits each one', () => {
      const result = lifecycle.cleanup({ actor: SYSTEM, dryRun: false });
      assert.deepEqual(result.cleaned, [SEED_IDS.authApiExpired]);
      const cleaned = lifecycle.get(SEED_IDS.authApiExpired)!;
      assert.equal(cleaned.status, 'cleaned');
      assert.deepEqual(cleaned.cleanedAt, clock);
      assert.deepEqual(actions(), ['AUTHORIZATION_CLEANED']);
      const event = audit.listChronological()[0];
      assert.equal(event.actor.type, 'system');
      assert.equal(event.scope.entityType, 'authorization');
      assert.equal(event.beforeState!.status, 'active');
      assert.equal(event.afterState!.status, 'cleaned');
      assert.equal(audit.verifyChain().valid, true);
      // Cleaned grants still deny, with the more specific reason.
      assert.equal(lifecycle.check(SEED_IDS.sellerB, 'invoice.read', { type: 'organization', id: SEED_IDS.orgB }).reason, 'CLEANED');
      // Idempotent.
      assert.deepEqual(lifecycle.cleanup({ actor: SYSTEM, dryRun: false }).cleaned, []);
    });

    it('leaves grants inside the grace period alone so they can still be renewed', () => {
      clock = new Date(lifecycle.get(SEED_IDS.authApprovalExpiring)!.expiresAt.getTime() + HOUR);
      const result = lifecycle.cleanup({ actor: SYSTEM, dryRun: false });
      assert.ok(result.inGrace.includes(SEED_IDS.authApprovalExpiring));
      assert.ok(!result.cleaned.includes(SEED_IDS.authApprovalExpiring));
    });

    it('cleanup cancels a pending renewal for the cleaned grant', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApiExpired, { actor: { id: SEED_IDS.sellerB, role: 'OWNER' }, reason: 'still integrating' });
      const result = lifecycle.cleanup({ actor: SYSTEM, dryRun: false });
      assert.deepEqual(result.cancelledRenewals, [req.id]);
      assert.equal(lifecycle.getRenewal(req.id)!.status, 'cancelled');
    });

    it('only the system job or an OWNER/ADMIN may run cleanup', () => {
      rejectsWith(() => lifecycle.cleanup({ actor: COLLAB }), 'AUTHORIZATION_FORBIDDEN');
    });

    it('runs as a registered background job that applies unless dryRun is set', async () => {
      const handlers = new Map<string, (payload: any) => Promise<unknown>>();
      const worker = { register: (type: string, h: any) => (handlers.set(type, h), worker) } as any;
      registerJobHandlers(worker, { expirePendingInvoices: async () => 0, cleanupStaleAuthorizations: createAuthorizationCleanupHandler(lifecycle) });
      const job = handlers.get(AUTHORIZATION_CLEANUP_JOB)!;
      const dry = (await job({ version: 1, data: { dryRun: true } })) as any;
      assert.equal(dry.dryRun, true);
      const applied = (await job({ version: 1, data: {} })) as any;
      assert.deepEqual(applied.cleaned, [SEED_IDS.authApiExpired]);
      assert.equal(lifecycle.get(SEED_IDS.authApiExpired)!.status, 'cleaned');
    });
  });

  describe('renewal', () => {
    const scope = { type: 'invoice' as const, id: SEED_IDS.invFailedSettlement };

    it('requires a request and a confirmation by a different OWNER/ADMIN, and is fully audited', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: 'manual review still open', ttlMs: 3 * DAY });
      assert.equal(req.status, 'pending');
      assert.equal(req.confirmationPhrase, `RENEW ${SEED_IDS.authApprovalExpiring}`);

      const renewed = lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase });
      assert.equal(renewed.status, 'active');
      assert.equal(renewed.renewedFromId, SEED_IDS.authApprovalExpiring);
      assert.equal(renewed.grantedBy, OWNER.id);
      assert.equal(renewed.expiresAt.getTime(), clock.getTime() + 3 * DAY);

      const old = lifecycle.get(SEED_IDS.authApprovalExpiring)!;
      assert.equal(old.status, 'renewed');
      assert.equal(old.renewedToId, renewed.id);
      assert.equal(lifecycle.getRenewal(req.id)!.newGrantId, renewed.id);

      assert.deepEqual(actions(), ['AUTHORIZATION_RENEWAL_REQUESTED', 'AUTHORIZATION_RENEWED']);
      const event = audit.listChronological()[1];
      assert.equal(event.actor.id, OWNER.id);
      assert.equal(event.metadata!.requestedBy, ADMIN.id);
      assert.equal(event.metadata!.newGrantId, renewed.id);

      // Access continues past the old expiry through the new grant.
      clock = new Date(old.expiresAt.getTime() + HOUR);
      assert.deepEqual(lifecycle.check(SEED_IDS.admin, 'job.requeue_dead', scope), { allowed: true, reason: 'ACTIVE', grantId: renewed.id });
    });

    it('renews an expired (not yet cleaned) grant', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApiExpired, { actor: { id: SEED_IDS.sellerB, role: 'OWNER' }, reason: 'rotate integration' });
      const renewed = lifecycle.confirmRenewal(req.id, { actor: SECOND_ADMIN, confirmation: req.confirmationPhrase });
      assert.equal(lifecycle.check(SEED_IDS.sellerB, 'invoice.read', { type: 'organization', id: SEED_IDS.orgB }).grantId, renewed.id);
    });

    it('the subject or requester cannot confirm their own renewal', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: OWNER, reason: 'extend' });
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: ADMIN, confirmation: req.confirmationPhrase }), 'RENEWAL_SELF_CONFIRMATION');
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase }), 'RENEWAL_SELF_CONFIRMATION');
      assert.equal(lifecycle.get(SEED_IDS.authApprovalExpiring)!.status, 'active');
    });

    it('requires an OWNER/ADMIN confirmer and the exact confirmation phrase', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: 'extend' });
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: COLLAB, confirmation: req.confirmationPhrase }), 'AUTHORIZATION_FORBIDDEN');
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: 'yes' }), 'RENEWAL_CONFIRMATION_MISMATCH');
      assert.equal(lifecycle.getRenewal(req.id)!.status, 'pending');
    });

    it('an unrelated collaborator cannot request renewal; a reason is mandatory', () => {
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: COLLAB, reason: 'x' }), 'AUTHORIZATION_FORBIDDEN');
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: '  ' }), 'AUTHORIZATION_INVALID_INPUT');
    });

    it('rejects renewals longer than the policy allows', () => {
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: 'x', ttlMs: 365 * DAY }), 'AUTHORIZATION_INVALID_INPUT');
    });

    it('one pending request per grant; confirmed requests cannot be replayed', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: 'extend' });
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: OWNER, reason: 'again' }), 'RENEWAL_ALREADY_PENDING');
      lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase });
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase }), 'RENEWAL_NOT_PENDING');
      // The superseded grant cannot be renewed a second time.
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authApprovalExpiring, { actor: ADMIN, reason: 'again' }), 'AUTHORIZATION_NOT_RENEWABLE');
    });

    it('renewal requests expire if not confirmed in time', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authAdminDelegation, { actor: ADMIN, reason: 'extend' });
      clock = new Date(req.expiresAt.getTime());
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase }), 'RENEWAL_REQUEST_EXPIRED');
      assert.equal(lifecycle.getRenewal(req.id)!.status, 'expired');
    });

    it('rejection is audited and leaves the grant untouched', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authAdminDelegation, { actor: ADMIN, reason: 'extend' });
      lifecycle.rejectRenewal(req.id, { actor: OWNER, reason: 'no longer needed' });
      assert.equal(lifecycle.getRenewal(req.id)!.status, 'rejected');
      assert.equal(lifecycle.get(SEED_IDS.authAdminDelegation)!.status, 'active');
      assert.deepEqual(actions(), ['AUTHORIZATION_RENEWAL_REQUESTED', 'AUTHORIZATION_RENEWAL_REJECTED']);
    });

    it('cleaned and revoked grants are not renewable', () => {
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authHistoricalCleaned, { actor: OWNER, reason: 'x' }), 'AUTHORIZATION_NOT_RENEWABLE');
      rejectsWith(() => lifecycle.requestRenewal(SEED_IDS.authCollabRevoked, { actor: OWNER, reason: 'x' }), 'AUTHORIZATION_NOT_RENEWABLE');
    });
  });

  describe('revocation', () => {
    it('revoked grants deny immediately, are audited and cancel pending renewals', () => {
      const req = lifecycle.requestRenewal(SEED_IDS.authAdminDelegation, { actor: ADMIN, reason: 'extend' });
      const revoked = lifecycle.revoke(SEED_IDS.authAdminDelegation, { actor: OWNER, reason: 'role change' });
      assert.equal(revoked.status, 'revoked');
      assert.equal(revoked.revokedBy, OWNER.id);
      assert.equal(lifecycle.check(SEED_IDS.admin, 'invoice.cancel', { type: 'organization', id: SEED_IDS.orgA }).reason, 'REVOKED');
      assert.equal(lifecycle.getRenewal(req.id)!.status, 'cancelled');
      rejectsWith(() => lifecycle.confirmRenewal(req.id, { actor: OWNER, confirmation: req.confirmationPhrase }), 'RENEWAL_NOT_PENDING');
      assert.deepEqual(actions(), ['AUTHORIZATION_RENEWAL_REQUESTED', 'AUTHORIZATION_REVOKED']);
    });

    it('the seeded revoked grant denies with REVOKED', () => {
      assert.equal(lifecycle.check(SEED_IDS.collaborator, 'invoice.create', { type: 'organization', id: SEED_IDS.orgA }).reason, 'REVOKED');
    });

    it('cannot revoke twice or revoke as an unrelated user', () => {
      rejectsWith(() => lifecycle.revoke(SEED_IDS.authCollabRevoked, { actor: OWNER, reason: 'x' }), 'AUTHORIZATION_INVALID_STATE');
      rejectsWith(() => lifecycle.revoke(SEED_IDS.authAdminDelegation, { actor: COLLAB, reason: 'x' }), 'AUTHORIZATION_FORBIDDEN');
    });
  });

  it('grant issues bounded, audited authorizations', () => {
    const g = lifecycle.grant({ kind: 'approval', subjectId: SEED_IDS.collaborator, scope: { action: 'invoice.cancel', resourceType: 'invoice', resourceId: SEED_IDS.invPending } }, OWNER);
    assert.equal(g.expiresAt.getTime() - g.issuedAt.getTime(), 7 * DAY);
    assert.deepEqual(actions(), ['AUTHORIZATION_GRANTED']);
    rejectsWith(() => lifecycle.grant({ kind: 'approval', subjectId: 'x', scope: g.scope }, COLLAB), 'AUTHORIZATION_FORBIDDEN');
    rejectsWith(() => lifecycle.grant({ kind: 'approval', subjectId: 'x', scope: g.scope, ttlMs: 8 * DAY }, OWNER), 'AUTHORIZATION_INVALID_INPUT');
  });

  it('returned grants are copies; callers cannot mutate lifecycle state', () => {
    const g = lifecycle.get(SEED_IDS.authAdminDelegation)!;
    g.status = 'revoked';
    g.expiresAt.setTime(0);
    assert.equal(lifecycle.get(SEED_IDS.authAdminDelegation)!.status, 'active');
    assert.equal(lifecycle.check(SEED_IDS.admin, 'invoice.cancel', { type: 'organization', id: SEED_IDS.orgA }).allowed, true);
  });
});
