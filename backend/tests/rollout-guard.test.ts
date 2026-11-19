import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { RolloutGuard, RolloutGuardError, rolloutBucket } from '../src/config/rollout-guard.ts';
import { FEATURE_FLAGS, featureFlagOverrides, isFeatureEnabled } from '../src/config/feature-flags.ts';
import type { AuditEvent } from '../src/audit/audit-service.ts';
import { createOpsRouter } from '../src/routes/ops.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';

const FLAG = 'paymentAmountTolerance' as const;
const ENV = FEATURE_FLAGS[FLAG].env;
const SELLER_A = `G${'A'.repeat(55)}`;
const SELLER_B = `G${'B'.repeat(55)}`;
const REASON = 'Stage tolerance for pilot sellers';

function makeGuard(env: Record<string, string | undefined> = {}) {
  const events: Array<Omit<AuditEvent, 'id' | 'timestamp'>> = [];
  const overrides = new Map<typeof FLAG, boolean>();
  const guard = new RolloutGuard({
    env,
    overrides: {
      get: (flag) => overrides.get(flag),
      set: (flag, value) => (value === null ? overrides.delete(flag) : overrides.set(flag, value), undefined),
    },
    recordAudit: (event) => {
      events.push(event);
      return { ...event, id: `evt-${events.length}`, timestamp: new Date().toISOString() } as AuditEvent;
    },
  });
  return { guard, events, overrides };
}

const start = (guard: RolloutGuard, scope: unknown = { percentage: 0, allowList: [SELLER_A] }, guardrail?: unknown) =>
  guard.start({ flag: FLAG, scope, guardrail, reason: REASON, actorId: 'maint-1' });

describe('rollout guard: scoping', () => {
  it('without a rollout, isEnabledFor matches the process value for every subject', () => {
    const { guard } = makeGuard({ [ENV]: 'true' });
    assert.equal(guard.isEnabledFor(FLAG, SELLER_A), true);
    const off = makeGuard({}).guard;
    assert.equal(off.isEnabledFor(FLAG, SELLER_A), false);
    assert.equal(off.isEnabledFor(FLAG), false);
  });

  it('enables only the allow-list at 0% and leaves anonymous callers on baseline', () => {
    const { guard } = makeGuard();
    start(guard);
    assert.equal(guard.isEnabledFor(FLAG, SELLER_A), true);
    assert.equal(guard.isEnabledFor(FLAG, SELLER_B), false);
    assert.equal(guard.isEnabledFor(FLAG), false);
  });

  it('percentage buckets are deterministic and roughly proportional', () => {
    const { guard } = makeGuard();
    start(guard, { percentage: 30 });
    const subjects = Array.from({ length: 2000 }, (_, i) => `seller-${i}`);
    const first = subjects.map((s) => guard.isEnabledFor(FLAG, s));
    const second = subjects.map((s) => guard.isEnabledFor(FLAG, s));
    assert.deepEqual(first, second);
    const share = first.filter(Boolean).length / subjects.length;
    assert.ok(share > 0.25 && share < 0.35, `share ${share}`);
    assert.equal(rolloutBucket(FLAG, 'x'), rolloutBucket(FLAG, 'x'));
  });

  it('a runtime kill switch (override false) beats the cohort', () => {
    const { guard, overrides } = makeGuard();
    start(guard);
    overrides.set(FLAG, false);
    assert.equal(guard.isEnabledFor(FLAG, SELLER_A), false);
  });

  it('refuses to start from an enabled baseline, twice, or with a bad scope', () => {
    assert.throws(() => start(makeGuard({ [ENV]: 'on' }).guard), (e: RolloutGuardError) => e.code === 'ROLLOUT_BASELINE_ENABLED');
    const { guard } = makeGuard();
    start(guard);
    assert.throws(() => start(guard), (e: RolloutGuardError) => e.code === 'ROLLOUT_ALREADY_ACTIVE');
    const fresh = makeGuard().guard;
    for (const scope of [null, { percentage: 101 }, { percentage: 0 }, { percentage: 5, allowList: [''] }]) {
      assert.throws(() => start(fresh, scope), (e: RolloutGuardError) => e.code === 'INVALID_ROLLOUT', JSON.stringify(scope));
    }
    assert.throws(() => start(fresh, { percentage: 5 }, { minSamples: 50, windowSize: 10 }), (e: RolloutGuardError) => e.code === 'INVALID_ROLLOUT');
  });

  it('writes evidence before starting and does not start when evidence fails', () => {
    const guard = new RolloutGuard({ env: {}, recordAudit: () => { throw new Error('audit down'); } });
    assert.throws(() => start(guard), (e: RolloutGuardError) => e.code === 'ROLLOUT_AUDIT_UNAVAILABLE');
    assert.equal(guard.get(FLAG), null);
    assert.equal(guard.isEnabledFor(FLAG, SELLER_A), false);
  });
});

describe('rollout guard: monitoring and automatic rollback', () => {
  it('stays active while the failure rate is within the guardrail', () => {
    const { guard } = makeGuard();
    start(guard, { percentage: 0, allowList: [SELLER_A] }, { minSamples: 10, maxFailureRate: 0.2, windowSize: 20 });
    for (let i = 0; i < 18; i++) guard.recordOutcome(FLAG, true);
    for (let i = 0; i < 2; i++) guard.recordOutcome(FLAG, false);
    assert.equal(guard.get(FLAG)!.status, 'active');
    assert.equal(guard.get(FLAG)!.window.failed, 2);
  });

  it('does not act on too few samples', () => {
    const { guard } = makeGuard();
    start(guard, undefined, { minSamples: 10, maxFailureRate: 0.1, windowSize: 20 });
    for (let i = 0; i < 9; i++) guard.recordOutcome(FLAG, false);
    assert.equal(guard.get(FLAG)!.status, 'active');
  });

  it('rolls back automatically on breach and verifies no subject is left on the new value', () => {
    const { guard, events } = makeGuard();
    start(guard, { percentage: 50, allowList: [SELLER_A] }, { minSamples: 5, maxFailureRate: 0.2, windowSize: 10 });
    for (let i = 0; i < 3; i++) guard.recordOutcome(FLAG, true);
    for (let i = 0; i < 2; i++) guard.recordOutcome(FLAG, false);

    const record = guard.get(FLAG)!;
    assert.equal(record.status, 'rolled_back');
    assert.equal(record.rollback!.trigger, 'automatic');
    assert.equal(record.rollback!.verification.consistent, true);
    assert.deepEqual(record.rollback!.verification.checks.map((c) => c.ok), [true, true, true, true]);
    assert.equal(guard.isEnabledFor(FLAG, SELLER_A), false);
    assert.equal(events.at(-1)!.metadata!.change, 'rollout_rolled_back');
    assert.equal(events.at(-1)!.actor.type, 'system');

    // Outcomes after rollback are ignored; nothing re-enables the cohort.
    guard.recordOutcome(FLAG, true);
    assert.equal(guard.get(FLAG)!.status, 'rolled_back');
  });

  it('reports rollback_unverified when the baseline moved during the rollout', () => {
    const env: Record<string, string | undefined> = {};
    const { guard } = makeGuard(env);
    start(guard);
    env[ENV] = 'true'; // someone flipped the env var mid-rollout
    const record = guard.rollback(FLAG, { reason: 'Abort pilot after support tickets', actorId: 'maint-1' });
    assert.equal(record.status, 'rollback_unverified');
    const failed = record.rollback!.verification.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.includes('effective_value_is_baseline'));
    assert.ok(failed.includes('subjects_on_baseline'));

    // Recovery: restore the env value and re-verify.
    delete env[ENV];
    assert.equal(guard.verifyRollback(FLAG, [SELLER_A]).consistent, true);
    assert.equal(guard.get(FLAG)!.status, 'rolled_back');
  });

  it('a failed rollback audit leaves the rollout active so the next outcome retries', () => {
    let failAudit = false;
    const guard = new RolloutGuard({
      env: {},
      overrides: { get: () => undefined, set: () => undefined },
      recordAudit: (event) => {
        if (failAudit) throw new Error('audit down');
        return { ...event, id: 'evt', timestamp: new Date().toISOString() } as AuditEvent;
      },
    });
    start(guard, undefined, { minSamples: 1, maxFailureRate: 0, windowSize: 5 });
    failAudit = true;
    guard.recordOutcome(FLAG, false);
    assert.equal(guard.get(FLAG)!.status, 'active');
    failAudit = false;
    guard.recordOutcome(FLAG, false);
    assert.equal(guard.get(FLAG)!.status, 'rolled_back');
  });

  it('manual rollback needs a reason and an active rollout', () => {
    const { guard } = makeGuard();
    assert.throws(() => guard.rollback(FLAG, { reason: 'nothing to undo here', actorId: 'm' }), (e: RolloutGuardError) => e.code === 'ROLLOUT_NOT_ACTIVE');
    start(guard);
    assert.throws(() => guard.rollback(FLAG, { reason: 'short', actorId: 'm' }), (e: RolloutGuardError) => e.code === 'INVALID_ROLLOUT');
    assert.throws(() => guard.rollback('nope', { reason: 'unknown flag rollback', actorId: 'm' }), (e: RolloutGuardError) => e.code === 'UNKNOWN_FEATURE_FLAG');
  });
});

describe('rollout guard: payment verification path', () => {
  afterEach(() => {
    delete process.env[ENV];
    featureFlagOverrides.set(FLAG, null);
  });

  it('process-wide default guard scopes amount tolerance to the cohort seller only', async () => {
    const { rolloutGuard } = await import('../src/config/rollout-guard.ts');
    const { amountsMatch } = await import('../src/services/payment-verification.ts');
    rolloutGuard.start({ flag: FLAG, scope: { percentage: 0, allowList: [SELLER_A] }, reason: REASON, actorId: 'test' });
    try {
      assert.equal(isFeatureEnabled(FLAG), false, 'global value unchanged by a scoped rollout');
      assert.equal(amountsMatch('100.0000001', 100, SELLER_A), true);
      assert.equal(amountsMatch('100.0000001', 100, SELLER_B), false);
      assert.equal(amountsMatch('100.0000001', 100), false);
    } finally {
      rolloutGuard.rollback(FLAG, { reason: 'test cleanup rollback', actorId: 'test' });
    }
    assert.equal(amountsMatch('100.0000001', 100, SELLER_A), false);
  });
});

describe('rollout guard: ops routes', () => {
  const TOKEN = 'rollout-admin-token';
  let server: ReturnType<express.Express['listen']> | undefined;
  afterEach(() => server?.close());

  it('start, signal, auto-rollback and verify over HTTP', async () => {
    const { guard } = makeGuard();
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), adminToken: TOKEN, approvals: null, capabilities: null, rollouts: guard }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/rollouts`;
    const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });

    assert.equal((await call('POST', `/${FLAG}`, {}, null)).status, 401);
    const started = await call('POST', `/${FLAG}`, { scope: { percentage: 10, allowList: [SELLER_A] }, guardrail: { minSamples: 4, maxFailureRate: 0.25, windowSize: 10 }, reason: REASON });
    assert.equal(started.status, 201);
    assert.equal((await call('POST', `/${FLAG}`, { scope: { percentage: 10 }, reason: REASON })).status, 409);

    const signalled = await call('POST', `/${FLAG}/outcomes`, { ok: 2, failed: 2 });
    assert.equal(signalled.status, 200);
    assert.equal((await signalled.json()).data.status, 'rolled_back');

    const verified = await call('POST', `/${FLAG}/verify`);
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).data.consistent, true);
    assert.equal((await call('POST', `/${FLAG}/outcomes`, { ok: -1 })).status, 400);
  });
});
