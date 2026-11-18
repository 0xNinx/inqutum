/**
 * HTTP flows for the event ledger (#250) and feature rollout guardrails (#309)
 * through the real ops router: admin token, capability tokens, evidence.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { EventLedger, verifyLedgerExport } from '../src/audit/event-ledger';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { FeatureRolloutController } from '../src/config/feature-rollout';
import { isFeatureEnabled } from '../src/config/feature-flags';
import { CapabilityTokenService } from '../src/security/capability-tokens';
import { createOpsRouter } from '../src/routes/ops.routes';
import { correlationMiddleware } from '../src/observability/telemetry';

const ADMIN = 'governance-routes-admin-token';
const SECRET = 'governance-routes-capability-secret-0123';
const FLAG = 'paymentAmountTolerance';

describe('governance routes — ledger and rollouts (#250, #309)', () => {
  let server: Server;
  let base: string;
  let ledger: EventLedger;
  let store: MemoryAuditStore;
  let rollout: FeatureRolloutController;

  before(async () => {
    ledger = new EventLedger();
    store = new MemoryAuditStore(1000, { ledger });
    rollout = new FeatureRolloutController({ env: {}, guardrails: { minSoakMs: 0 }, recordAudit: (e) => store.recordEvent(e) });
    const app = express();
    app.use(correlationMiddleware());
    app.use(express.json());
    app.use(
      '/api',
      createOpsRouter({
        storage: {} as any,
        adminToken: ADMIN,
        approvals: null,
        capabilities: new CapabilityTokenService({ secret: SECRET }),
        ledger,
        rollout,
      })
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    rollout.reset();
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const capability = async () => {
    const res = await call('POST', '/ops/capabilities', { action: 'config.feature_flag.rollout', target: FLAG, subject: 'maintainer-alice' });
    assert.equal(res.status, 201);
    return (await res.json()).data.token as string;
  };

  it('requires the admin token on every governance route', async () => {
    for (const [method, path] of [
      ['GET', '/ops/ledger'],
      ['GET', '/ops/ledger/verify'],
      ['GET', '/ops/ledger/export'],
      ['POST', '/ops/ledger/prune'],
      ['POST', '/ops/ledger/reseal'],
      ['GET', '/ops/rollouts'],
      ['PUT', `/ops/rollouts/${FLAG}`],
      ['POST', `/ops/rollouts/${FLAG}/emergency-disable`],
      ['DELETE', `/ops/rollouts/${FLAG}/kill-switch`],
      ['POST', '/ops/rollouts/evidence/flush'],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.ok([401, 403].includes(res.status), `${method} ${path} answered ${res.status}`);
    }
  });

  it('ramps with a capability, records evidence in the ledger, and exports a verifiable chain', async () => {
    const noCap = await call('PUT', `/ops/rollouts/${FLAG}`, { percentage: 10, expectedVersion: 0, reason: 'Stage 1 of the tolerance rollout' });
    assert.equal(noCap.status, 401);

    const res = await call(
      'PUT',
      `/ops/rollouts/${FLAG}`,
      { percentage: 10, expectedVersion: 0, reason: 'Stage 1 of the tolerance rollout' },
      { 'x-capability-token': await capability() }
    );
    assert.equal(res.status, 200);
    const result = (await res.json()).data;
    assert.equal(result.state.percentage, 10);

    const tooFar = await call(
      'PUT',
      `/ops/rollouts/${FLAG}`,
      { percentage: 90, expectedVersion: 1, reason: 'Skipping ahead is not allowed' },
      { 'x-capability-token': await capability() }
    );
    assert.equal(tooFar.status, 422);
    assert.equal((await tooFar.json()).code, 'ROLLOUT_STEP_TOO_LARGE');

    const exported = await (await call('GET', '/ops/ledger/export')).json();
    assert.equal(verifyLedgerExport(exported).valid, true);
    const last = exported.entries.at(-1);
    assert.equal(last.action, 'CONFIG_CHANGED');
    assert.equal(last.subject.id, `rollouts.${FLAG}`);
    assert.equal(last.sourceEventId, result.auditEventId);

    const ndjson = await call('GET', '/ops/ledger/export?format=ndjson');
    assert.match(ndjson.headers.get('content-type') ?? '', /ndjson/);
    assert.equal((await call('GET', '/ops/ledger/export?format=xml')).status, 400);
  });

  it('emergency-disables with the admin token alone, idempotently', async () => {
    const body = { actorId: 'oncall-bob', reason: 'Incident 77: wrong settlements' };
    const first = await call('POST', `/ops/rollouts/${FLAG}/emergency-disable`, body);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).data.changed, true);
    assert.equal(isFeatureEnabled(FLAG, { FEATURE_PAYMENT_AMOUNT_TOLERANCE: 'true' }), false);

    const again = await call('POST', `/ops/rollouts/${FLAG}/emergency-disable`, body);
    assert.equal((await again.json()).data.changed, false);

    const anonymous = await call('POST', `/ops/rollouts/${FLAG}/emergency-disable`, { reason: 'Nobody pressed this button' });
    assert.equal(anonymous.status, 403);
  });

  it('clears the kill switch only with a capability and the current version', async () => {
    const version = (await (await call('GET', '/ops/rollouts')).json()).data.flags.find((f: any) => f.flag === FLAG).version;
    const stale = await call(
      'DELETE',
      `/ops/rollouts/${FLAG}/kill-switch`,
      { expectedVersion: version - 1, reason: 'Incident 77 resolved: fix deployed' },
      { 'x-capability-token': await capability() }
    );
    assert.equal(stale.status, 409);
    const ok = await call(
      'DELETE',
      `/ops/rollouts/${FLAG}/kill-switch`,
      { expectedVersion: version, reason: 'Incident 77 resolved: fix deployed' },
      { 'x-capability-token': await capability() }
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.state.percentage, 0);
  });

  it('verifies, detects tampering, refuses reseal without a reason, and reseals', async () => {
    assert.equal((await call('GET', '/ops/ledger/verify')).status, 200);
    assert.equal((await call('POST', '/ops/ledger/reseal', { actorId: 'a', reason: 'no need to do this' })).status, 409);

    (ledger.unsafeEntriesForTesting()[0].payload as any).reason = 'rewritten history';
    const broken = await call('GET', '/ops/ledger/verify');
    assert.equal(broken.status, 409);
    assert.equal((await broken.json()).data.failure.sequence, 1);
    assert.equal((await (await call('GET', '/ops/ledger')).json()).data.compromised, true);

    assert.equal((await call('POST', '/ops/ledger/reseal', { actorId: 'alice', reason: 'short' })).status, 400);
    const sealed = await call('POST', '/ops/ledger/reseal', { actorId: 'alice', reason: 'Incident 78: entry 1 altered in memory' });
    assert.equal(sealed.status, 200);
    assert.equal((await sealed.json()).data.entry.action, 'LEDGER_RESEALED');
  });

  it('prunes only with the hash of the last archived entry', async () => {
    const doc = await (await call('GET', '/ops/ledger/export?toSequence=2')).json();
    const wrong = await call('POST', '/ops/ledger/prune', { throughSequence: 2, confirmHash: 'f'.repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal((await call('POST', '/ops/ledger/prune', { throughSequence: -1 })).status, 400);
    const ok = await call('POST', '/ops/ledger/prune', { throughSequence: 2, confirmHash: doc.head.hash });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data.anchor, doc.head);
  });
});
