import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  PublicStatusError,
  PublicStatusService,
  STATE_POLICY,
  STATUS_CAPABILITIES,
  publicStatusHandler,
} from '../src/ops/public-status.ts';
import { DegradedModeService } from '../src/ops/degraded-mode.service.ts';
import type { AuditEvent } from '../src/audit/audit-service.ts';
import { createInvoiceRouter } from '../src/routes/invoice.routes.ts';
import { createExportRouter } from '../src/routes/export.routes.ts';
import { createOpsRouter } from '../src/routes/ops.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import { MemoryJobStore } from '../src/jobs/memory-job-store.ts';
import { JobQueue, JobWorker } from '../src/jobs/worker.ts';
import { EXPIRE_PENDING_INVOICES_JOB, RECONCILE_PROJECTIONS_JOB } from '../src/jobs/runtime.ts';

const SELLER = `G${'A'.repeat(55)}`;
const SECRET_REASON = 'Rotating HORIZON key sk_live_abc123 on db-primary.internal:5432 per INC-42';
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

function makeService(options: ConstructorParameters<typeof PublicStatusService>[0] = {}) {
  const events: Array<Omit<AuditEvent, 'id' | 'timestamp'>> = [];
  const service = new PublicStatusService({
    recordAudit: (event) => {
      events.push(event);
      return { ...event, id: `evt-${events.length}`, timestamp: new Date().toISOString() } as AuditEvent;
    },
    ...options,
  });
  return { service, events };
}

const declare = (service: PublicStatusService, state: string, extra: Record<string, unknown> = {}) =>
  service.declare({ state, reason: SECRET_REASON, expectedVersion: service.getVersion(), actorId: 'maint-1', ...extra });

describe('public status: model', () => {
  it('defaults to operational with every capability available', async () => {
    const { service } = makeService();
    const status = await service.publicStatus();
    assert.equal(status.state, 'operational');
    for (const c of STATUS_CAPABILITIES) assert.equal(status.capabilities[c], 'available', c);
    for (const c of STATUS_CAPABILITIES) assert.equal(service.gate(c).allowed, true);
  });

  it('paused blocks creation and verification only', async () => {
    const { service } = makeService();
    declare(service, 'paused');
    const status = await service.publicStatus();
    assert.equal(status.state, 'paused');
    assert.equal(status.capabilities.invoice_creation, 'unavailable');
    assert.equal(status.capabilities.payment_verification, 'unavailable');
    assert.equal(status.capabilities.invoice_viewing, 'available');
    assert.equal(status.capabilities.invoice_cancellation, 'available');
    assert.equal(status.capabilities.exports, 'available');
  });

  it('maintenance is read-only', () => {
    const { service } = makeService();
    declare(service, 'maintenance', { expectedResolutionAt: FUTURE() });
    assert.equal(service.gate('invoice_viewing').allowed, true);
    for (const c of STATUS_CAPABILITIES.filter((c) => c !== 'invoice_viewing')) {
      const decision = service.gate(c);
      assert.equal(decision.allowed, false, c);
      assert.equal(decision.code, 'SERVICE_MAINTENANCE');
      assert.equal(decision.httpStatus, 503);
    }
  });

  it('never exposes the operator reason, actor or dependency internals publicly', async () => {
    const degraded = new DegradedModeService({ cacheTtlMs: 0 });
    degraded.registerProbe('stellar_horizon', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:8000 token=hzn_secret');
    });
    const { service } = makeService({ dependencies: degraded });
    declare(service, 'paused');
    const publicJson = JSON.stringify(await service.publicStatus());
    for (const leak of ['sk_live', 'db-primary', 'INC-42', 'maint-1', 'ECONNREFUSED', '10.0.0.7', 'hzn_secret', 'runbook', 'docs/']) {
      assert.ok(!publicJson.includes(leak), `public status leaked "${leak}"`);
    }
    assert.deepEqual(
      Object.keys(JSON.parse(publicJson)).sort(),
      ['capabilities', 'expectedResolutionAt', 'message', 'retryAfterSeconds', 'since', 'state', 'title', 'updatedAt']
    );
    // Operators still see the full picture.
    const internal = await service.internalStatus();
    assert.equal(internal.declaration!.reason, SECRET_REASON);
  });

  it('derives degraded from a down dependency without an operator declaration', async () => {
    const degraded = new DegradedModeService({ cacheTtlMs: 0 });
    degraded.registerProbe('stellar_horizon', async () => {
      throw new Error('ETIMEDOUT');
    });
    const { service } = makeService({ dependencies: degraded });
    const status = await service.publicStatus();
    assert.equal(status.state, 'degraded');
    assert.notEqual(status.capabilities.payment_verification, 'available');
    // Dependency degradation alone never blocks through the status gate.
    assert.equal(service.gate('payment_verification').allowed, true);
  });

  it('a more severe declaration wins over derived degradation', async () => {
    const degraded = new DegradedModeService({ cacheTtlMs: 0 });
    degraded.setOverride('postgres', 'down', 'drill');
    const { service } = makeService({ dependencies: degraded });
    declare(service, 'maintenance');
    assert.equal((await service.publicStatus()).state, 'maintenance');
  });

  it('a failing dependency check does not invent an outage or fail the status', async () => {
    const { service } = makeService({ dependencies: { getStatus: async () => { throw new Error('probe runner crashed'); } } });
    const internal = await service.internalStatus();
    assert.equal(internal.public.state, 'operational');
    assert.equal(internal.dependencyState, 'unavailable');
  });

  it('changes are audited first, versioned, and validated', () => {
    const { service, events } = makeService();
    assert.throws(() => declare(service, 'operational'), (e: PublicStatusError) => e.code === 'INVALID_STATUS_CHANGE');
    assert.throws(() => declare(service, 'paused', { reason: 'short' }), (e: PublicStatusError) => e.code === 'INVALID_STATUS_CHANGE');
    assert.throws(() => declare(service, 'paused', { expectedResolutionAt: '2000-01-01T00:00:00Z' }), (e: PublicStatusError) => e.code === 'INVALID_STATUS_CHANGE');
    declare(service, 'paused');
    assert.throws(() => service.declare({ state: 'maintenance', reason: SECRET_REASON, expectedVersion: 0, actorId: 'm2' }), (e: PublicStatusError) => e.code === 'STATUS_VERSION_CONFLICT');
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata!.change, 'status_declared');

    assert.equal(service.clear({ reason: 'Incident resolved, resuming', expectedVersion: 1, actorId: 'm' }), true);
    assert.equal(service.currentState(), 'operational');
    assert.equal(service.clear({ reason: 'noop', expectedVersion: 2, actorId: 'm' }), false);
    assert.equal(events.length, 2);
  });

  it('does not change state when the audit write fails', () => {
    const service = new PublicStatusService({ recordAudit: () => { throw new Error('audit down'); } });
    assert.throws(() => declare(service, 'maintenance'), (e: PublicStatusError) => e.code === 'STATUS_AUDIT_UNAVAILABLE');
    assert.equal(service.currentState(), 'operational');
    assert.equal(service.getVersion(), 0);
  });

  it('every user-facing message is free of internals', () => {
    for (const [state, policy] of Object.entries(STATE_POLICY)) {
      assert.ok(!/https?:\/\/|stack|Error:|ECONN|password|token|docs\//i.test(policy.title + policy.message), state);
    }
  });
});

describe('public status: API path', () => {
  const TOKEN = 'status-admin-token';
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let service: PublicStatusService;

  beforeEach(() => {
    memoryStorage.clear();
    service = makeService().service;
    const storage = new MemoryInvoiceStorage();
    const app = express();
    app.use(express.json());
    app.get('/api/status', publicStatusHandler(service));
    app.use('/api', createInvoiceRouter({ storage, publicStatus: service, allowSimulate: true }));
    app.use('/api', createExportRouter({ storage, publicStatus: service }));
    app.use('/api', createOpsRouter({ storage, adminToken: TOKEN, approvals: null, capabilities: null, publicStatus: service }));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterEach(() => server.close());

  const call = (method: string, path: string, body?: unknown, token: string | null = null) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const createInvoice = () => call('POST', '/invoices', { amount: 10, assetCode: 'XLM', sellerPublicKey: SELLER });

  it('operational: existing routes behave as before', async () => {
    assert.equal((await createInvoice()).status, 201);
    const body = await (await call('GET', '/status')).json();
    assert.equal(body.success, true);
    assert.equal(body.data.state, 'operational');
  });

  it('operator pauses, writes are refused with Retry-After, reads keep working, resume restores', async () => {
    const invoiceId = (await (await createInvoice()).json()).data.invoice.id;

    assert.equal((await call('PUT', '/ops/public-status', { state: 'paused', reason: SECRET_REASON, expectedVersion: 0 })).status, 401);
    const declared = await call('PUT', '/ops/public-status', { state: 'paused', reason: SECRET_REASON, expectedVersion: 0 }, TOKEN);
    assert.equal(declared.status, 200);

    const refused = await createInvoice();
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('retry-after'), String(STATE_POLICY.paused.retryAfterSeconds));
    assert.equal(refused.headers.get('x-service-status'), 'paused');
    const body = await refused.json();
    assert.equal(body.code, 'SERVICE_PAUSED');
    assert.ok(!JSON.stringify(body).includes('sk_live'));

    assert.equal((await call('POST', `/invoices/${invoiceId}/verify`, { txHash: 'a'.repeat(64) })).status, 503);
    assert.equal((await call('GET', `/invoices/${invoiceId}`)).status, 200);

    const publicStatus = (await (await call('GET', '/status')).json()).data;
    assert.equal(publicStatus.state, 'paused');
    assert.ok(!JSON.stringify(publicStatus).includes('sk_live'));

    const internal = await (await call('GET', '/ops/public-status', undefined, TOKEN)).json();
    assert.equal(internal.data.declaration.reason, SECRET_REASON);

    const cleared = await call('DELETE', '/ops/public-status', { reason: 'Payments resumed after fix', expectedVersion: 1 }, TOKEN);
    assert.equal(cleared.status, 200);
    assert.equal((await createInvoice()).status, 201);
  });

  it('maintenance refuses exports and cancellations', async () => {
    const invoiceId = (await (await createInvoice()).json()).data.invoice.id;
    await call('PUT', '/ops/public-status', { state: 'maintenance', reason: SECRET_REASON, expectedVersion: 0 }, TOKEN);
    assert.equal((await call('POST', '/exports', { requester: SELLER })).status, 503);
    assert.equal((await call('POST', `/invoices/${invoiceId}/cancel`, {})).status, 503);
    const conflict = await call('PUT', '/ops/public-status', { state: 'paused', reason: SECRET_REASON, expectedVersion: 0 }, TOKEN);
    assert.equal(conflict.status, 409);
  });
});

describe('public status: background path', () => {
  it('paused holds the expiry sweep but not other jobs; maintenance holds everything; resume drains', async () => {
    const { service } = makeService();
    const store = new MemoryJobStore();
    const queue = new JobQueue(store);
    const ran: string[] = [];
    const worker = new JobWorker({ store, gate: (type) => service.backgroundGate(type).run, log: () => {} });
    worker.register(EXPIRE_PENDING_INVOICES_JOB, async () => { ran.push(EXPIRE_PENDING_INVOICES_JOB); });
    worker.register(RECONCILE_PROJECTIONS_JOB, async () => { ran.push(RECONCILE_PROJECTIONS_JOB); });

    declare(service, 'paused');
    await queue.enqueue(EXPIRE_PENDING_INVOICES_JOB);
    await queue.enqueue(RECONCILE_PROJECTIONS_JOB);
    await worker.drain();
    assert.deepEqual(ran, [RECONCILE_PROJECTIONS_JOB]);

    service.clear({ reason: 'pause over', expectedVersion: 1, actorId: 'm' });
    service.declare({ state: 'maintenance', reason: SECRET_REASON, expectedVersion: 2, actorId: 'm' });
    await queue.enqueue(RECONCILE_PROJECTIONS_JOB, {}, { idempotencyKey: 'second' });
    await worker.drain();
    assert.deepEqual(ran, [RECONCILE_PROJECTIONS_JOB], 'maintenance holds every job');

    const held = (await store.list({ status: 'queued' } as any)).jobs;
    assert.ok(held.every((j: any) => j.attempts === 0), 'held jobs consume no attempts');

    service.clear({ reason: 'maintenance over', expectedVersion: 3, actorId: 'm' });
    await worker.drain();
    assert.deepEqual(ran.sort(), [EXPIRE_PENDING_INVOICES_JOB, RECONCILE_PROJECTIONS_JOB, RECONCILE_PROJECTIONS_JOB].sort());
  });
});
