/**
 * Feature rollout guardrails with emergency disablement (#309): normal,
 * failure, retry and authorization paths, plus the flag-evaluation contract.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FeatureRolloutController,
  RolloutError,
  type RolloutActor,
} from '../src/config/feature-rollout';
import {
  featureFlagKillSwitches,
  featureFlagOverrides,
  featureFlagRollouts,
  isFeatureEnabled,
  isFeatureEnabledFor,
  rolloutBucket,
} from '../src/config/feature-flags';
import type { AuditEvent } from '../src/audit/audit-service';

const FLAG = 'paymentAmountTolerance';
const REASON = 'Stage the tolerance rollout for testnet sellers';
const ALICE: RolloutActor = { id: 'maintainer-alice', role: 'maintainer', capabilityId: 'cap-1' };
const ONCALL: RolloutActor = { id: 'oncall-bob', role: 'operator' };
const VIEWER: RolloutActor = { id: 'viewer-carol', role: 'viewer' };
const MIN = 60_000;

function harness(opts: { failAudit?: () => boolean; env?: Record<string, string> } = {}) {
  let ms = Date.parse('2026-05-01T00:00:00.000Z');
  const audit: AuditEvent[] = [];
  const controller = new FeatureRolloutController({
    now: () => new Date(ms),
    env: opts.env ?? {},
    guardrails: { maxStepPercent: 25, minSoakMs: 10 * MIN, maxErrorRate: 0.1, minSamples: 20, windowSize: 100 },
    recordAudit: (event) => {
      if (opts.failAudit?.()) throw new Error('audit store down');
      const full = { ...event, id: `evt-${audit.length + 1}`, timestamp: new Date(ms).toISOString() } as AuditEvent;
      audit.push(full);
      return full;
    },
  });
  const advance = (percentage: unknown, extra: Record<string, unknown> = {}) =>
    controller.advance({ flag: FLAG, percentage, expectedVersion: controller.state(FLAG).version, reason: REASON, actor: ALICE, ...extra });
  return { controller, audit, advance, tick: (by: number) => (ms += by) };
}

function rejects(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RolloutError, String(err));
    assert.equal(err.code, code);
    if (status) assert.equal(err.httpStatus, status);
    return true;
  });
}

const subjects = Array.from({ length: 2000 }, (_, i) => `G-subject-${i}`);
const enabledShare = () => subjects.filter((s) => isFeatureEnabledFor(FLAG, s, {})).length / subjects.length;

describe('feature rollout — normal path (#309)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => (h = harness()));
  afterEach(() => h.controller.reset());

  it('leaves flags untouched until a rollout is configured', () => {
    assert.equal(h.controller.state(FLAG).percentage, null);
    assert.equal(isFeatureEnabled(FLAG, { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' }), true);
    assert.equal(isFeatureEnabledFor(FLAG, 'G1', { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' }), true);
  });

  it('ramps in bounded steps after each soak, enabling a growing, stable share of subjects', () => {
    h.advance(10);
    const firstCohort = subjects.filter((s) => isFeatureEnabledFor(FLAG, s, {}));
    assert.ok(Math.abs(enabledShare() - 0.1) < 0.03, `~10% enabled, got ${enabledShare()}`);
    assert.equal(isFeatureEnabled(FLAG, {}), false, 'subject-less checks need 100%');

    for (const step of [35, 60, 85, 100]) {
      h.tick(10 * MIN);
      h.advance(step);
    }
    assert.equal(h.controller.state(FLAG).percentage, 100);
    assert.equal(h.controller.state(FLAG).version, 5);
    assert.equal(enabledShare(), 1);
    assert.equal(isFeatureEnabled(FLAG, {}), true);
    for (const s of firstCohort) assert.equal(isFeatureEnabledFor(FLAG, s, {}), true, 'early subjects never flip back off');
  });

  it('records CONFIG_CHANGED evidence for every applied step', () => {
    const result = h.advance(20);
    assert.equal(result.changed, true);
    assert.equal(result.auditEventId, 'evt-1');
    const [event] = h.audit;
    assert.equal(event.action, 'CONFIG_CHANGED');
    assert.equal(event.scope.entityId, `rollouts.${FLAG}`);
    assert.deepEqual(event.beforeState, { percentage: null, version: 0 });
    assert.deepEqual(event.afterState, { percentage: 20, version: 1 });
    assert.equal(event.metadata?.capabilityId, 'cap-1');
  });

  it('treats a request for the current percentage as a no-op without evidence', () => {
    h.advance(20);
    const again = h.advance(20);
    assert.equal(again.changed, false);
    assert.equal(h.audit.length, 1);
    assert.equal(h.controller.state(FLAG).version, 1);
  });

  it('allows immediate rollback of any size, without soak', () => {
    h.advance(25);
    h.tick(10 * MIN);
    h.advance(50);
    assert.equal(h.advance(0).state.percentage, 0);
    assert.equal(enabledShare(), 0);
  });

  it('bucketing is deterministic and roughly uniform', () => {
    assert.equal(rolloutBucket(FLAG, 'G1'), rolloutBucket(FLAG, 'G1'));
    const low = subjects.filter((s) => rolloutBucket(FLAG, s) < 5000).length;
    assert.ok(Math.abs(low / subjects.length - 0.5) < 0.05);
  });

  it('ends a rollout only where it already matches the environment', () => {
    h.advance(20);
    rejects(() => h.advance(null), 'INVALID_ROLLOUT_CHANGE', 400);
    h.advance(0);
    const done = h.advance(null);
    assert.equal(done.changed, true);
    assert.equal(done.state.percentage, null);
    assert.equal(featureFlagRollouts.get(FLAG), undefined);
  });
});

describe('feature rollout — guardrails and failure path (#309)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => (h = harness()));
  afterEach(() => h.controller.reset());

  it('refuses increases larger than the step limit', () => {
    rejects(() => h.advance(30), 'ROLLOUT_STEP_TOO_LARGE', 422);
    assert.equal(h.controller.state(FLAG).percentage, null);
    assert.equal(h.audit.length, 0);
  });

  it('refuses an increase before the current stage has soaked', () => {
    h.advance(10);
    h.tick(9 * MIN);
    rejects(() => h.advance(20), 'ROLLOUT_SOAK_INCOMPLETE', 409);
    h.tick(MIN);
    assert.equal(h.advance(20).state.percentage, 20);
  });

  it('rejects malformed changes before touching state', () => {
    for (const p of [-1, 101, 1.5, '10', undefined]) rejects(() => h.advance(p), 'INVALID_ROLLOUT_CHANGE', 400);
    rejects(() => h.advance(10, { reason: 'short' }), 'INVALID_ROLLOUT_CHANGE');
    rejects(() => h.advance(10, { expectedVersion: -1 }), 'INVALID_ROLLOUT_CHANGE');
    rejects(() => h.controller.advance({ flag: 'nope', percentage: 1, expectedVersion: 0, reason: REASON, actor: ALICE }), 'UNKNOWN_FEATURE_FLAG', 404);
    assert.equal(h.controller.state(FLAG).version, 0);
  });

  it('refuses a stale expectedVersion so two maintainers cannot overwrite each other', () => {
    h.advance(10);
    rejects(() => h.advance(5, { expectedVersion: 0 }), 'ROLLOUT_VERSION_CONFLICT', 409);
  });

  it('trips the kill switch automatically when the error rate breaches the guardrail', () => {
    h.advance(25);
    for (let i = 0; i < 17; i++) assert.equal(h.controller.recordOutcome(FLAG, { ok: true }).tripped, false);
    for (let i = 0; i < 2; i++) assert.equal(h.controller.recordOutcome(FLAG, { ok: false }).tripped, false, 'below minSamples');
    assert.equal(h.controller.recordOutcome(FLAG, { ok: false }).tripped, true, '3/20 = 15% > 10%');

    const state = h.controller.state(FLAG);
    assert.equal(state.killSwitch?.automatic, true);
    assert.equal(state.killSwitch?.engagedBy, 'rollout-guardrail');
    assert.equal(enabledShare(), 0);
    assert.equal(h.audit.at(-1)?.metadata?.change, 'kill_switch_engaged');
    assert.equal(h.audit.at(-1)?.actor.type, 'system');
  });

  it('defence in depth: refuses to ramp on breached health even if the kill switch did not trip', () => {
    const c = harness();
    c.advance(10);
    c.tick(10 * MIN);
    // recordOutcome always trips first, so this state is unreachable through the
    // public API; write the window directly to pin the second check.
    for (let i = 0; i < 20; i++) (c.controller as any).records.get(FLAG).outcomes.push(i % 2 === 0);
    rejects(() => c.advance(20), 'ROLLOUT_GUARDRAIL_BREACHED', 409);
    c.controller.reset();
  });

  it('fails closed when audit evidence cannot be written for a ramp', () => {
    let down = true;
    const f = harness({ failAudit: () => down });
    rejects(() => f.advance(10), 'ROLLOUT_AUDIT_UNAVAILABLE', 503);
    assert.equal(f.controller.state(FLAG).percentage, null, 'nothing applied without evidence');
    down = false;
    assert.equal(f.advance(10).state.percentage, 10, 'retry succeeds once audit is back');
    f.controller.reset();
  });
});

describe('feature rollout — emergency disablement and recovery (#309)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => (h = harness()));
  afterEach(() => {
    h.controller.reset();
    featureFlagOverrides.set(FLAG, null);
  });

  it('beats every other source, including a runtime override and the environment', () => {
    featureFlagOverrides.set(FLAG, true);
    const env = { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' };
    assert.equal(isFeatureEnabled(FLAG, env), true);
    h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 51: wrong settlements', actor: ONCALL });
    assert.equal(isFeatureEnabled(FLAG, env), false);
    assert.equal(isFeatureEnabledFor(FLAG, 'G1', env), false);
    assert.equal(featureFlagKillSwitches.isEngaged(FLAG), true);
  });

  it('needs no expected version and is idempotent under repeated presses', () => {
    h.advance(20);
    const first = h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 52: duplicate paid events', actor: ONCALL });
    const second = h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 52: duplicate paid events', actor: ALICE });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(h.audit.filter((e) => e.metadata?.change === 'kill_switch_engaged').length, 1);
    assert.equal(h.controller.state(FLAG).killSwitch?.engagedBy, ONCALL.id);
  });

  it('still disables when the audit store is down, and backfills the evidence later', () => {
    let down = true;
    const f = harness({ failAudit: () => down });
    const result = f.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 53: audit outage too', actor: ONCALL });
    assert.equal(result.changed, true);
    assert.equal(result.evidenceRecorded, false);
    assert.equal(isFeatureEnabled(FLAG, { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' }), false);
    assert.equal(f.controller.snapshot().pendingEvidence, 1);

    assert.deepEqual(f.controller.flushPendingEvidence(), { recorded: 0, remaining: 1 }, 'retry while down keeps it queued');
    down = false;
    assert.deepEqual(f.controller.flushPendingEvidence(), { recorded: 1, remaining: 0 });
    assert.equal(f.audit[0].metadata?.evidenceDelayed, true);
    f.controller.reset();
  });

  it('blocks ramps while killed, and re-enabling restarts the ramp at 0%', () => {
    h.advance(25);
    h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 54: investigating', actor: ONCALL });
    h.tick(10 * MIN);
    rejects(() => h.advance(25), 'ROLLOUT_KILLED', 409);

    const cleared = h.controller.clearKillSwitch({ flag: FLAG, expectedVersion: h.controller.state(FLAG).version, reason: 'Incident 54 resolved: fix deployed', actor: ALICE });
    assert.equal(cleared.state.killSwitch, null);
    assert.equal(cleared.state.percentage, 0);
    assert.equal(enabledShare(), 0, 'nothing turns back on by itself');
    h.tick(10 * MIN);
    assert.equal(h.advance(25).state.percentage, 25);
  });

  it('refuses to clear a kill switch while its evidence is still pending', () => {
    let down = true;
    const f = harness({ failAudit: () => down });
    f.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 55: audit also down', actor: ONCALL });
    down = false;
    rejects(
      () => f.controller.clearKillSwitch({ flag: FLAG, expectedVersion: f.controller.state(FLAG).version, reason: 'Resolved, re-enabling it now', actor: ALICE }),
      'ROLLOUT_AUDIT_UNAVAILABLE',
      503
    );
    f.controller.flushPendingEvidence();
    f.controller.clearKillSwitch({ flag: FLAG, expectedVersion: f.controller.state(FLAG).version, reason: 'Resolved, re-enabling it now', actor: ALICE });
    f.controller.reset();
  });

  it('refuses to clear a kill switch that is not engaged, or with a stale version', () => {
    rejects(() => h.controller.clearKillSwitch({ flag: FLAG, expectedVersion: 0, reason: 'Nothing to clear here', actor: ALICE }), 'ROLLOUT_NOT_KILLED', 409);
    h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 56: investigating', actor: ONCALL });
    rejects(() => h.controller.clearKillSwitch({ flag: FLAG, expectedVersion: 0, reason: 'Incident 56 resolved now', actor: ALICE }), 'ROLLOUT_VERSION_CONFLICT', 409);
  });
});

describe('feature rollout — retry path (#309)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => (h = harness()));
  afterEach(() => h.controller.reset());

  it('replays a repeated request with the same requestId without applying it twice', () => {
    const first = h.controller.advance({ flag: FLAG, percentage: 10, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-1' });
    const retry = h.controller.advance({ flag: FLAG, percentage: 10, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-1' });
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(retry.auditEventId, first.auditEventId);
    assert.equal(h.controller.state(FLAG).version, 1, 'a stale expectedVersion on the retry is not a conflict');
    assert.equal(h.audit.length, 1);
  });

  it('refuses to reuse a requestId for a different change', () => {
    h.controller.advance({ flag: FLAG, percentage: 10, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-2' });
    rejects(() => h.controller.advance({ flag: FLAG, percentage: 5, expectedVersion: 1, reason: REASON, actor: ALICE, requestId: 'req-2' }), 'ROLLOUT_REQUEST_REUSED', 409);
  });

  it('does not remember failed requests, so they can be retried after fixing the cause', () => {
    rejects(() => h.controller.advance({ flag: FLAG, percentage: 50, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-3' }), 'ROLLOUT_STEP_TOO_LARGE');
    rejects(() => h.controller.advance({ flag: FLAG, percentage: 50, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-3' }), 'ROLLOUT_STEP_TOO_LARGE');
  });

  it('applies exactly one of many concurrent retries of the same request', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i % 3));
        return h.controller.advance({ flag: FLAG, percentage: 10, expectedVersion: 0, reason: REASON, actor: ALICE, requestId: 'req-burst' });
      })
    );
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(h.controller.state(FLAG).version, 1);
    assert.equal(h.audit.length, 1);
  });
});

describe('feature rollout — authorization path (#309)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => (h = harness()));
  afterEach(() => h.controller.reset());

  it('lets only maintainers ramp or re-enable', () => {
    for (const actor of [ONCALL, VIEWER, { id: 'x', role: 'system' } as RolloutActor]) {
      rejects(() => h.advance(10, { actor }), 'ROLLOUT_FORBIDDEN', 403);
    }
    h.controller.emergencyDisable({ flag: FLAG, reason: 'Incident 60: stop it now', actor: ONCALL });
    rejects(() => h.controller.clearKillSwitch({ flag: FLAG, expectedVersion: 1, reason: 'Operator tries to re-enable', actor: ONCALL }), 'ROLLOUT_FORBIDDEN', 403);
  });

  it('lets operators stop but not viewers, and rejects anonymous actors', () => {
    rejects(() => h.controller.emergencyDisable({ flag: FLAG, reason: 'Viewer pressing stop', actor: VIEWER }), 'ROLLOUT_FORBIDDEN', 403);
    rejects(() => h.controller.emergencyDisable({ flag: FLAG, reason: 'Blank actor pressing stop', actor: { id: ' ', role: 'operator' } }), 'ROLLOUT_FORBIDDEN', 403);
    rejects(() => h.controller.emergencyDisable({ flag: FLAG, reason: 'No actor pressing stop', actor: undefined as any }), 'ROLLOUT_FORBIDDEN', 403);
    assert.equal(h.controller.state(FLAG).killSwitch, null);
    assert.equal(h.controller.emergencyDisable({ flag: FLAG, reason: 'Operator pressing stop', actor: ONCALL }).changed, true);
  });
});
