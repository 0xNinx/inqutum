/**
 * Privacy-safe export with field-level authorization (#308): normal, failure,
 * retry and authorization paths, at the service and through the HTTP route.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  EXPORT_FIELDS,
  EXPORT_FIELD_POLICY,
  EXPORT_SCHEMA_VERSION,
  EXPORT_SCHEMA_VERSION_FIELD_SELECTION,
  ExportCancelledError,
  ExportFieldError,
  ExportFieldForbiddenError,
  ExportIdempotencyConflictError,
  ExportService,
  authorizeExportFields,
  type ExportAccess,
} from '../src/exports/export-service';
import { createExportRouter } from '../src/routes/export.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { InvoiceStorage } from '../src/storage/invoice-storage';

const SELLER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);
const PAYER = 'G' + 'C'.repeat(55);
const AUDITOR: ExportAccess = { grants: ['owner', 'counterparty'] };

let storage: MemoryInvoiceStorage;
let seq = 0;

async function seedPaid(seller = SELLER) {
  const invoice = await storage.createInvoice({
    amount: 42,
    assetCode: 'XLM',
    sellerPublicKey: seller,
    sellerName: 'Ada Seller',
    sellerEmail: 'ada@example.com',
    customerName: 'Bob Customer',
    customerEmail: 'bob@example.com',
    expiresInDays: 7,
  } as any);
  const txHash = String(++seq).padStart(64, 'f');
  await storage.markAsPaid(invoice.id, txHash, PAYER, { payerName: 'Pat Payer', payerEmail: 'pat@example.com' });
  return invoice;
}

const PERSONAL = ['ada@example.com', 'Ada Seller', 'bob@example.com', 'Bob Customer', 'pat@example.com', 'Pat Payer'];

describe('export field policy (#308)', () => {
  it('classifies every default field and grants it to owners', () => {
    for (const field of EXPORT_FIELDS) {
      assert.equal(EXPORT_FIELD_POLICY[field].requires, 'owner', field);
    }
  });

  it('never makes personal fields exportable, for any grant', () => {
    const personal = Object.entries(EXPORT_FIELD_POLICY).filter(([, p]) => p.classification === 'personal');
    assert.ok(personal.length >= 6);
    for (const [field, policy] of personal) assert.equal(policy.requires, null, field);
  });

  it('returns null (default set) when no fields are requested', () => {
    assert.equal(authorizeExportFields(undefined, { grants: [] }), null);
  });

  it('dedupes and orders the selection by policy, independent of request order', () => {
    assert.deepEqual(authorizeExportFields(['paidAt', 'id', 'amount', 'id'], { grants: ['owner'] }), ['id', 'amount', 'paidAt']);
  });

  it('rejects unknown, empty and oversized selections with a validation error', () => {
    for (const bad of [[], ['id', 'nope'], ['__proto__'], ['constructor'], Array(33).fill('id'), [1 as any]]) {
      assert.throws(() => authorizeExportFields(bad, { grants: ['owner'] }), ExportFieldError, JSON.stringify(bad));
    }
  });

  it('reports every denied field at once with its classification and reason', () => {
    assert.throws(
      () => authorizeExportFields(['id', 'payerPublicKey', 'payerEmail', 'customerName'], { grants: ['owner'] }),
      (err: unknown) => {
        assert.ok(err instanceof ExportFieldForbiddenError);
        assert.deepEqual(err.denied, [
          { field: 'payerPublicKey', classification: 'counterparty', reason: 'missing_grant', requires: 'counterparty' },
          { field: 'payerEmail', classification: 'personal', reason: 'never_exportable', requires: null },
          { field: 'customerName', classification: 'personal', reason: 'never_exportable', requires: null },
        ]);
        return true;
      }
    );
  });

  it('denies even owner fields to a caller with no grants', () => {
    assert.throws(() => authorizeExportFields(['id'], { grants: [] }), ExportFieldForbiddenError);
  });
});

describe('field-level export — service (#308)', () => {
  beforeEach(() => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
  });

  it('keeps the default export identical to schema v1 (contract preserved)', async () => {
    await seedPaid();
    const artifact = await new ExportService(storage).create(SELLER, { format: 'json' });
    const doc = JSON.parse(artifact.body);
    assert.equal(doc.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.deepEqual(doc.fields, [...EXPORT_FIELDS]);
    assert.equal('fieldClassifications' in doc, false);
    assert.deepEqual(Object.keys(doc.records[0]), [...EXPORT_FIELDS]);
  });

  it('emits only the selected fields, as schema v2 with classifications', async () => {
    await seedPaid();
    const service = new ExportService(storage);
    const json = JSON.parse((await service.create(SELLER, { format: 'json', fields: ['amount', 'id'] })).body);
    assert.equal(json.schemaVersion, EXPORT_SCHEMA_VERSION_FIELD_SELECTION);
    assert.deepEqual(json.fields, ['id', 'amount']);
    assert.deepEqual(json.fieldClassifications, { id: 'identifier', amount: 'financial' });
    assert.deepEqual(Object.keys(json.records[0]), ['id', 'amount']);

    const csv = (await service.create(SELLER, { format: 'csv', fields: ['status', 'paymentTxHash'] })).body;
    assert.equal(csv.split('\r\n')[0], 'status,paymentTxHash');
    assert.match(csv.split('\r\n')[1], /^PAID,f+\d+$/);
  });

  it('exports the counterparty field only with the counterparty grant', async () => {
    await seedPaid();
    const service = new ExportService(storage);
    await assert.rejects(service.create(SELLER, { format: 'json', fields: ['id', 'payerPublicKey'] }), ExportFieldForbiddenError);
    const doc = JSON.parse((await service.create(SELLER, { format: 'json', fields: ['id', 'payerPublicKey'] }, SELLER, undefined, AUDITOR)).body);
    assert.equal(doc.records[0].payerPublicKey, PAYER);
  });

  it('never leaks personal data, whatever is requested or granted', async () => {
    await seedPaid();
    const service = new ExportService(storage);
    const everything = { grants: ['owner', 'counterparty'] } as ExportAccess;
    const allowed = Object.keys(EXPORT_FIELD_POLICY).filter((f) => (EXPORT_FIELD_POLICY as any)[f].requires !== null);
    for (const format of ['json', 'csv'] as const) {
      const body = (await service.create(SELLER, { format, fields: allowed }, SELLER, undefined, everything)).body;
      for (const secret of PERSONAL) assert.equal(body.includes(secret), false, `${format} leaked ${secret}`);
    }
  });

  it('authorizes before reading storage, so a denied request does no work', async () => {
    let reads = 0;
    const counting = Object.create(storage) as InvoiceStorage;
    counting.getInvoicesBySeller = async (...args: any[]) => {
      reads += 1;
      return (storage.getInvoicesBySeller as any)(...args);
    };
    const service = new ExportService(counting);
    await assert.rejects(service.create(SELLER, { format: 'json', fields: ['payerEmail'] }), ExportFieldForbiddenError);
    await assert.rejects(service.create(SELLER, { format: 'json', fields: ['bogus'] }), ExportFieldError);
    assert.equal(reads, 0);
    assert.equal(service.size(), 0);
  });

  it('keeps the wallet scope check ahead of field checks', async () => {
    const service = new ExportService(storage);
    await assert.rejects(service.create(SELLER, { format: 'json', fields: ['id'] }, OTHER), /only export your own/);
  });
});

describe('field-level export — retries and failures (#308)', () => {
  beforeEach(() => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
  });

  it('returns the same artifact for a repeated idempotency key', async () => {
    await seedPaid();
    const service = new ExportService(storage);
    const a = await service.create(SELLER, { format: 'json', fields: ['id'], idempotencyKey: 'k1' });
    const b = await service.create(SELLER, { format: 'json', fields: ['id'], idempotencyKey: 'k1' });
    assert.equal(a.meta.exportId, b.meta.exportId);
    assert.equal(service.size(), 1);
  });

  it('treats a reordered but equivalent field list as the same request', async () => {
    const service = new ExportService(storage);
    const a = await service.create(SELLER, { format: 'json', fields: ['id', 'amount'], idempotencyKey: 'k-order' });
    const b = await service.create(SELLER, { format: 'json', fields: ['amount', 'id'], idempotencyKey: 'k-order' });
    assert.equal(a.meta.exportId, b.meta.exportId);
  });

  it('refuses to reuse a key for a different request', async () => {
    const service = new ExportService(storage);
    await service.create(SELLER, { format: 'json', fields: ['id'], idempotencyKey: 'k2' });
    await assert.rejects(service.create(SELLER, { format: 'csv', fields: ['id'], idempotencyKey: 'k2' }), ExportIdempotencyConflictError);
    await assert.rejects(service.create(SELLER, { format: 'json', fields: ['amount'], idempotencyKey: 'k2' }), ExportIdempotencyConflictError);
  });

  it('scopes keys per wallet, so one wallet cannot fetch another wallet\'s artifact by key', async () => {
    await seedPaid(SELLER);
    await seedPaid(OTHER);
    const service = new ExportService(storage);
    const mine = await service.create(SELLER, { format: 'json', idempotencyKey: 'shared' });
    const theirs = await service.create(OTHER, { format: 'json', idempotencyKey: 'shared' });
    assert.notEqual(mine.meta.exportId, theirs.meta.exportId);
    assert.equal(theirs.owner, OTHER);
  });

  it('generates once for many concurrent retries of the same request', async () => {
    let reads = 0;
    const slow = Object.create(storage) as InvoiceStorage;
    slow.getInvoicesBySeller = async (...args: any[]) => {
      reads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return (storage.getInvoicesBySeller as any)(...args);
    };
    await seedPaid();
    const service = new ExportService(slow);
    const results = await Promise.all(Array.from({ length: 20 }, () => service.create(SELLER, { format: 'json', idempotencyKey: 'burst' })));
    assert.equal(new Set(results.map((r) => r.meta.exportId)).size, 1);
    assert.equal(reads, 1);
    assert.equal(service.size(), 1);
  });

  it('forgets a key whose generation failed, so a retry can succeed', async () => {
    let fail = true;
    const flaky = Object.create(storage) as InvoiceStorage;
    flaky.getInvoicesBySeller = async (...args: any[]) => {
      if (fail) throw new Error('db down');
      return (storage.getInvoicesBySeller as any)(...args);
    };
    const service = new ExportService(flaky);
    await assert.rejects(service.create(SELLER, { format: 'json', idempotencyKey: 'k3' }), /db down/);
    assert.equal(service.size(), 0);
    fail = false;
    const ok = await service.create(SELLER, { format: 'json', idempotencyKey: 'k3' });
    assert.equal(ok.owner, SELLER);
  });

  it('forgets a key whose generation was cancelled', async () => {
    const service = new ExportService(storage);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.create(SELLER, { format: 'json', idempotencyKey: 'k4' }, SELLER, controller.signal), ExportCancelledError);
    const ok = await service.create(SELLER, { format: 'json', idempotencyKey: 'k4' });
    assert.ok(ok.meta.exportId);
  });

  it('regenerates under the same key after the earlier artifact expired', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const service = new ExportService(storage, { now: () => now, retentionMs: 1000 });
    const first = await service.create(SELLER, { format: 'json', idempotencyKey: 'k5' });
    now = new Date(now.getTime() + 5000);
    const second = await service.create(SELLER, { format: 'json', idempotencyKey: 'k5' });
    assert.notEqual(first.meta.exportId, second.meta.exportId);
  });

  it('rejects malformed idempotency keys', async () => {
    const service = new ExportService(storage);
    await assert.rejects(service.create(SELLER, { format: 'json', idempotencyKey: '' }), ExportFieldError);
    await assert.rejects(service.create(SELLER, { format: 'json', idempotencyKey: 'x'.repeat(201) }), ExportFieldError);
  });
});

describe('field-level export — HTTP route (#308)', () => {
  let server: Server;
  let base: string;
  const audit: any[] = [];

  before(async () => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    await seedPaid();
    const auditing = Object.create(storage) as InvoiceStorage;
    auditing.recordAuditEvent = async (event: any) => {
      audit.push(event);
      return event;
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter({ storage: auditing }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/exports`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves a field-selected export and audits the selection', async () => {
    const res = await post({ requester: SELLER, fields: ['id', 'amount'] });
    assert.equal(res.status, 201);
    const meta = (await res.json()).data;
    assert.deepEqual(meta.fields, ['id', 'amount']);
    assert.equal(meta.schemaVersion, 2);
    assert.deepEqual(audit.at(-1).metadata.fields, ['id', 'amount']);

    const file = await fetch(`${base}${meta.downloadPath.replace('/api', '')}`);
    assert.deepEqual(Object.keys((await file.json()).records[0]), ['id', 'amount']);
  });

  it('answers 403 EXPORT_FIELD_FORBIDDEN with the denied fields, never granting counterparty data publicly', async () => {
    const res = await post({ requester: SELLER, fields: ['id', 'payerPublicKey', 'payerEmail'] });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'EXPORT_FIELD_FORBIDDEN');
    assert.deepEqual(body.deniedFields.map((d: any) => d.field), ['payerPublicKey', 'payerEmail']);
    assert.ok(Array.isArray(body.remediation));
  });

  it('answers 400 for unknown fields', async () => {
    const res = await post({ requester: SELLER, fields: ['secretKey'] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_EXPORT_FIELDS');
  });

  it('honours the Idempotency-Key header and 409s on reuse for a different request', async () => {
    const a = await (await post({ requester: SELLER }, { 'idempotency-key': 'route-1' })).json();
    const b = await (await post({ requester: SELLER }, { 'idempotency-key': 'route-1' })).json();
    assert.equal(a.data.exportId, b.data.exportId);
    const c = await post({ requester: SELLER, format: 'csv' }, { 'idempotency-key': 'route-1' });
    assert.equal(c.status, 409);
    assert.equal((await c.json()).code, 'EXPORT_IDEMPOTENCY_CONFLICT');
  });

  it('keeps the default request unchanged (v1, default fields)', async () => {
    const res = await post({ requester: SELLER });
    const meta = (await res.json()).data;
    assert.equal(meta.schemaVersion, 1);
    assert.deepEqual(meta.fields, [...EXPORT_FIELDS]);
  });
});
