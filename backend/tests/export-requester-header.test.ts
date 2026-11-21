/**
 * Export download requester moved out of the URL (#444): normal, failure,
 * retry and authorization paths for the `X-Requester` header on
 * GET /exports/:id, with the legacy `?requester=` form kept working.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ExportService } from '../src/exports/export-service';
import { createExportRouter } from '../src/routes/export.routes';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { InvoiceStorage } from '../src/storage/invoice-storage';

const SELLER = 'G' + 'A'.repeat(55);
const OTHER = 'G' + 'B'.repeat(55);

let storage: MemoryInvoiceStorage;
let seq = 0;

async function seedPaid(seller = SELLER) {
  const invoice = await storage.createInvoice({
    amount: 42,
    assetCode: 'XLM',
    sellerPublicKey: seller,
    customerName: 'Bob Customer',
    customerEmail: 'bob@example.com',
    expiresInDays: 7,
  } as any);
  await storage.markAsPaid(invoice.id, String(++seq).padStart(64, 'e'), 'G' + 'C'.repeat(55), {});
  return invoice;
}

describe('export download requester header (#444)', () => {
  let server: Server;
  let base: string;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

  let now = new Date('2026-01-01T00:00:00Z');

  before(async () => {
    memoryStorage.clear();
    storage = new MemoryInvoiceStorage();
    await seedPaid();
    const service = new ExportService(storage, { now: () => now, retentionMs: 60_000 });
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter({ storage: storage as InvoiceStorage, service }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    now = new Date('2026-01-01T00:00:00Z');
  });

  // Normal path

  it('downloads with the X-Requester header and no query string', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPathNoQuery.replace('/api', ''), { 'X-Requester': SELLER });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).records.length, 1);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  it('keeps the legacy ?requester= download working', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPath.replace('/api', ''));
    assert.equal(res.status, 200);
  });

  it('returns downloadPath unchanged and adds downloadHeaders for the new form', async () => {
    const data = (await (await post({ requester: SELLER })).json()).data;
    assert.equal(data.downloadPath, `/api/exports/${data.exportId}?requester=${SELLER}`);
    assert.equal(data.downloadPathNoQuery, `/api/exports/${data.exportId}`);
    assert.deepEqual(data.downloadHeaders, { 'X-Requester': SELLER });
  });

  // Failure paths

  it('answers 400 REQUESTER_REQUIRED when neither header nor query is sent', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPathNoQuery.replace('/api', ''));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'REQUESTER_REQUIRED');
  });

  it('answers 400 for a malformed X-Requester header', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPathNoQuery.replace('/api', ''), { 'X-Requester': 'not-a-key' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'REQUESTER_REQUIRED');
  });

  it('answers 400 REQUESTER_MISMATCH when header and query name different wallets', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPath.replace('/api', ''), { 'X-Requester': OTHER });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'REQUESTER_MISMATCH');
  });

  it('accepts header and query together when they agree', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPath.replace('/api', ''), { 'X-Requester': SELLER });
    assert.equal(res.status, 200);
  });

  // Authorization paths

  it('answers 404 to a different wallet sent in the header, never revealing the artifact', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const res = await get(meta.downloadPathNoQuery.replace('/api', ''), { 'X-Requester': OTHER });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'EXPORT_NOT_FOUND');
  });

  // Retry and expiry paths

  it('serves the same artifact to repeated header-based downloads', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    const path = meta.downloadPathNoQuery.replace('/api', '');
    const a = await (await get(path, { 'X-Requester': SELLER })).json();
    const b = await (await get(path, { 'X-Requester': SELLER })).json();
    assert.equal(a.exportId, b.exportId);
  });

  it('answers 410 EXPORT_EXPIRED through the header after retention passes', async () => {
    const meta = (await (await post({ requester: SELLER })).json()).data;
    now = new Date(Date.parse(meta.expiresAt) + 1);
    const res = await get(meta.downloadPathNoQuery.replace('/api', ''), { 'X-Requester': SELLER });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, 'EXPORT_EXPIRED');
  });
});
