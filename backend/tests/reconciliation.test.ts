import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ReconciliationError, ReconciliationService } from '../src/ops/reconciliation.ts';
import { PermissionAwareSearchIndex } from '../src/services/search-index.service.ts';
import type { InvoiceStorage, StoredInvoice } from '../src/storage/invoice-storage.ts';
import type { AuditEvent } from '../src/audit/audit-service.ts';
import { createOpsRouter } from '../src/routes/ops.routes.ts';
import { MemoryJobStore } from '../src/jobs/memory-job-store.ts';
import { JobQueue, JobWorker } from '../src/jobs/worker.ts';
import { RECONCILE_PROJECTIONS_JOB, registerJobHandlers, scheduleReconciliation } from '../src/jobs/runtime.ts';

const SELLER = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const DAY = 86_400_000;

function invoice(id: string, overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  return {
    id,
    sellerPublicKey: SELLER,
    amount: 100,
    assetCode: 'XLM',
    memo: `MEMO-${id}`,
    status: 'PENDING',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date(Date.now() + DAY),
    ...overrides,
  };
}

/** Storage stub that counts writes so tests can prove storage is never written. */
function storageOf(rows: StoredInvoice[]) {
  const map = new Map(rows.map((r) => [r.id, { ...r }]));
  let writes = 0;
  const write = () => {
    writes += 1;
    throw new Error('reconciliation must not write storage');
  };
  const storage = {
    mode: 'test',
    getAllInvoices: async () => [...map.values()].map((r) => ({ ...r })),
    createInvoice: write,
    cancelInvoice: write,
    markAsPaid: write,
    markExpiredInvoices: write,
  } as unknown as InvoiceStorage;
  return { storage, map, writes: () => writes };
}

const audit = (action: string): AuditEvent => ({
  id: action,
  timestamp: '2026-01-01T00:00:00.000Z',
  action: action as AuditEvent['action'],
  actor: { type: 'seller', id: SELLER },
  scope: { entityType: 'invoice', entityId: 'x' },
});

/** Builds a drifted world covering every drift kind. */
function driftedWorld() {
  const rows = [
    invoice('inv-ok'),
    invoice('inv-missing', { status: 'PAID' }),
    invoice('inv-paid', { status: 'PAID' }),
    invoice('inv-cancelled', { status: 'CANCELLED' }),
    invoice('inv-expired', { status: 'EXPIRED' }),
    invoice('inv-ahead'),
    invoice('inv-lazy', { expiresAt: new Date(Date.now() - DAY) }),
    invoice('inv-edited', { amount: 250 }),
    invoice('inv-tomb'),
  ];
  const { storage, map, writes } = storageOf(rows);
  const index = new PermissionAwareSearchIndex();
  for (const row of rows) {
    if (row.id === 'inv-missing') continue;
    index.indexInvoice({ ...row, status: ['inv-paid', 'inv-cancelled', 'inv-expired'].includes(row.id) ? 'PENDING' : row.status, amount: row.id === 'inv-edited' ? 100 : row.amount });
  }
  index.indexInvoice(invoice('inv-ahead', { status: 'PAID' }));
  index.indexInvoice(invoice('inv-lazy', { status: 'EXPIRED' }));
  index.removeIndexRecord('inv-tomb');
  index.indexInvoice(invoice('inv-orphan', { sellerPublicKey: OTHER }));
  return { storage, map, writes, index };
}

const byId = (plan: { drifts: Array<{ entityId: string }> }, id: string) => plan.drifts.find((d) => d.entityId === id) as any;

describe('reconciliation: detection and root-cause hints', () => {
  it('reports a healthy plan when projection matches storage', async () => {
    const { storage } = storageOf([invoice('a'), invoice('b', { status: 'PAID' })]);
    const index = new PermissionAwareSearchIndex();
    index.indexInvoice(invoice('a'));
    index.indexInvoice(invoice('b', { status: 'PAID' }));
    const plan = await new ReconciliationService({ storage, index }).plan();
    assert.equal(plan.healthy, true);
    assert.equal(plan.summary.drifts, 0);
  });

  it('classifies every drift kind with severity, root cause and action', async () => {
    const { storage, index, writes } = driftedWorld();
    const before = JSON.stringify(index.exportRecords());
    const plan = await new ReconciliationService({ storage, index }).plan();

    assert.equal(byId(plan, 'inv-ok'), undefined);
    assert.deepEqual(
      [byId(plan, 'inv-missing').kind, byId(plan, 'inv-missing').severity, byId(plan, 'inv-missing').action],
      ['MISSING_IN_PROJECTION', 'CRITICAL', 'INDEX_FROM_STORAGE']
    );
    assert.equal(byId(plan, 'inv-paid').rootCause.code, 'PAYMENT_NOT_PROJECTED');
    assert.equal(byId(plan, 'inv-paid').severity, 'CRITICAL');
    assert.equal(byId(plan, 'inv-cancelled').rootCause.code, 'CANCELLATION_NOT_PROJECTED');
    assert.equal(byId(plan, 'inv-expired').rootCause.code, 'EXPIRY_NOT_PROJECTED');
    assert.equal(byId(plan, 'inv-ahead').rootCause.code, 'PROJECTION_AHEAD_OF_STORAGE');
    assert.equal(byId(plan, 'inv-ahead').severity, 'CRITICAL');
    assert.equal(byId(plan, 'inv-lazy').rootCause.code, 'AWAITING_LAZY_EXPIRY');
    assert.equal(byId(plan, 'inv-lazy').action, 'NONE');
    assert.equal(byId(plan, 'inv-edited').kind, 'IMMUTABLE_FIELD_DRIFT');
    assert.deepEqual(byId(plan, 'inv-edited').fields, ['amount']);
    assert.equal(byId(plan, 'inv-tomb').kind, 'TOMBSTONED_IN_PROJECTION');
    assert.equal(byId(plan, 'inv-orphan').action, 'PURGE_FROM_PROJECTION');
    assert.equal(plan.summary.drifts, 9);
    assert.equal(plan.summary.repairable, 8);
    for (const d of plan.drifts) assert.ok(d.rootCause.hint.length > 20, d.entityId);

    // Dry run has no side effects.
    assert.equal(JSON.stringify(index.exportRecords()), before);
    assert.equal(writes(), 0);
  });

  it('uses audit evidence to sharpen hints, and survives a failing audit lookup', async () => {
    const { storage } = storageOf([invoice('api-made'), invoice('imported'), invoice('paid-no-proof', { status: 'PAID' })]);
    const index = new PermissionAwareSearchIndex();
    index.indexInvoice(invoice('paid-no-proof'));
    const events: Record<string, AuditEvent[]> = { 'api-made': [audit('INVOICE_CREATED')], imported: [], 'paid-no-proof': [audit('INVOICE_CREATED')] };
    const plan = await new ReconciliationService({ storage, index, auditLookup: async (id) => events[id] ?? [] }).plan();
    assert.equal(byId(plan, 'api-made').rootCause.code, 'INDEX_WRITE_LOST');
    assert.equal(byId(plan, 'imported').rootCause.code, 'CREATED_OUTSIDE_API');
    assert.ok(byId(plan, 'paid-no-proof').rootCause.evidence.some((e: string) => e.includes('No PAYMENT_VERIFIED')));

    const failing = await new ReconciliationService({ storage, index, auditLookup: async () => { throw new Error('db down'); } }).plan();
    assert.ok(byId(failing, 'imported').rootCause.evidence[0].includes('Audit lookup failed'));
  });

  it('fails clearly when storage cannot be scanned', async () => {
    const storage = { mode: 'legacy' } as unknown as InvoiceStorage;
    await assert.rejects(new ReconciliationService({ storage, index: new PermissionAwareSearchIndex() }).plan(), (e: ReconciliationError) => e.code === 'STORAGE_SCAN_UNSUPPORTED');
  });
});

describe('reconciliation: dry-run-first repair', () => {
  it('apply repairs exactly the plan, verifies clean, and never writes storage', async () => {
    const { storage, index, writes } = driftedWorld();
    const service = new ReconciliationService({ storage, index });
    const plan = await service.plan();
    const result = await service.apply(plan.planId, 'maint-1');

    assert.equal(result.applied.length, 8);
    assert.equal(result.failed.length, 0);
    assert.equal(result.verification.clean, true);
    assert.equal(writes(), 0);
    const after = await service.plan();
    assert.deepEqual(after.drifts.map((d) => d.entityId), ['inv-lazy'], 'only self-healing drift remains');
    assert.equal(index.exportRecords().find((r) => r.id === 'inv-edited')!.amount, 250);
    assert.equal(index.exportRecords().find((r) => r.id === 'inv-tomb')!.isDeleted, false);
    assert.equal(index.exportRecords().some((r) => r.id === 'inv-orphan'), false);
  });

  it('refuses unknown, reused and expired plans before any write', async () => {
    let now = new Date('2026-06-01T00:00:00Z');
    const { storage, index } = driftedWorld();
    const service = new ReconciliationService({ storage, index, now: () => now, planTtlMs: 60_000 });
    await assert.rejects(service.apply('nope', 'm'), (e: ReconciliationError) => e.code === 'PLAN_NOT_FOUND');

    const plan = await service.plan();
    now = new Date(now.getTime() + 61_000);
    const before = JSON.stringify(index.exportRecords());
    await assert.rejects(service.apply(plan.planId, 'm'), (e: ReconciliationError) => e.code === 'PLAN_EXPIRED');
    assert.equal(JSON.stringify(index.exportRecords()), before);

    const fresh = await service.plan();
    await service.apply(fresh.planId, 'm');
    await assert.rejects(service.apply(fresh.planId, 'm'), (e: ReconciliationError) => e.code === 'PLAN_ALREADY_APPLIED');
  });

  it('refuses a stale plan when drift changed after review and hands back a new plan', async () => {
    const { storage, map, index } = driftedWorld();
    const service = new ReconciliationService({ storage, index });
    const plan = await service.plan();
    map.set('inv-new', invoice('inv-new', { status: 'PAID' }));
    const before = JSON.stringify(index.exportRecords());
    const err = await service.apply(plan.planId, 'm').catch((e) => e);
    assert.ok(err instanceof ReconciliationError);
    assert.equal(err.code, 'PLAN_STALE');
    assert.ok(byId(err.plan!, 'inv-new'));
    assert.equal(JSON.stringify(index.exportRecords()), before, 'no partial apply');
    const result = await service.apply(err.plan!.planId, 'm');
    assert.equal(result.verification.clean, true);
  });

  it('rollback restores the exact pre-apply projection', async () => {
    const { storage, index } = driftedWorld();
    const service = new ReconciliationService({ storage, index });
    assert.throws(() => service.rollback(), (e: ReconciliationError) => e.code === 'NOTHING_TO_ROLL_BACK');
    const before = index.exportRecords();
    await service.apply((await service.plan()).planId, 'm');
    const restored = service.rollback();
    assert.equal(restored.restoredRecords, before.length);
    assert.deepEqual(index.exportRecords(), before);
    assert.throws(() => service.rollback(), (e: ReconciliationError) => e.code === 'NOTHING_TO_ROLL_BACK');
  });

  it('runs one reconciliation at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const storage = { mode: 'slow', getAllInvoices: async () => { await gate; return []; } } as unknown as InvoiceStorage;
    const service = new ReconciliationService({ storage, index: new PermissionAwareSearchIndex() });
    const first = service.plan();
    await assert.rejects(service.plan(), (e: ReconciliationError) => e.code === 'RECONCILIATION_IN_PROGRESS');
    release();
    await first;
  });
});

describe('reconciliation: scheduled job', () => {
  it('the job detects only and is idempotent per interval bucket', async () => {
    const { storage, index } = driftedWorld();
    const before = JSON.stringify(index.exportRecords());
    const service = new ReconciliationService({ storage, index });
    const store = new MemoryJobStore();
    const worker = registerJobHandlers(new JobWorker({ store, log: () => {} }), {
      expirePendingInvoices: async () => 0,
      reconcileProjections: () => service.scheduledCheck(),
    });
    const queue = new JobQueue(store);
    const at = new Date('2026-06-01T00:00:00Z');
    await scheduleReconciliation(queue, at, 900_000);
    const dup = await scheduleReconciliation(queue, new Date(at.getTime() + 1_000), 900_000);
    assert.equal(dup.created, false);

    const job = await worker.runOnce();
    assert.equal(job!.type, RECONCILE_PROJECTIONS_JOB);
    assert.equal(job!.status, 'succeeded');
    const result = job!.result as { healthy: boolean; critical: string[] };
    assert.equal(result.healthy, false);
    assert.ok(result.critical.includes('inv-paid:PAYMENT_NOT_PROJECTED'));
    assert.equal(JSON.stringify(index.exportRecords()), before, 'scheduled run never repairs');
  });
});

describe('reconciliation: ops routes', () => {
  const TOKEN = 'reconcile-admin-token';
  let server: ReturnType<express.Express['listen']> | undefined;
  afterEach(() => server?.close());

  it('apply requires a plan id from a dry run, and rollback undoes it', async () => {
    const { storage, index } = driftedWorld();
    const reconciliation = new ReconciliationService({ storage, index });
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage, adminToken: TOKEN, approvals: null, capabilities: null, reconciliation }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ops/reconciliation`;
    const call = (path: string, body?: unknown, token: string | null = TOKEN) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });

    assert.equal((await call('/dry-run', {}, null)).status, 401);
    assert.equal((await call('/apply', {})).status, 400);
    const plan = (await (await call('/dry-run')).json()).data;
    assert.equal(plan.healthy, false);
    const applied = await call('/apply', { planId: plan.planId });
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).data.verification.clean, true);
    assert.equal((await call('/apply', { planId: plan.planId })).status, 409);
    assert.equal((await call('/rollback')).status, 200);
    assert.equal((await call('/rollback')).status, 409);
  });
});
