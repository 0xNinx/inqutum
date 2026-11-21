/**
 * Concurrency stress tests for critical mutation paths (#208).
 *
 * Every test drives many concurrent requests through a seeded scheduler: each
 * task yields a pseudo-random number of event-loop turns at its await points,
 * so the interleavings are varied but replayable. A failure prints its seed;
 * rerun with STRESS_SEED=<seed> to reproduce it exactly.
 *
 * Invariants checked after every run:
 *  - no duplicate irreversible records (one PAID transition, one
 *    PAYMENT_VERIFIED audit event and ledger entry, one invoice per tx hash),
 *  - no missing records (every accepted create is stored, ledger has no gaps),
 *  - consistent records (version == number of applied transitions + 1, final
 *    status matches exactly one winning request).
 *
 * Paths covered: concurrent success, conflicting requests, duplicate retries,
 * and lock timeouts. Strategy notes: docs/CONCURRENCY.md §5.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { createInvoiceHandlers, type InvoiceHandlers } from '../src/routes/invoice.handlers';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import memoryStorage from '../src/storage/memory-storage';
import type { InvoiceStorage } from '../src/storage/invoice-storage';
import { InvoiceLockManager, LockTimeoutError } from '../src/concurrency/lock-manager';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { EventLedger, verifyLedgerExport } from '../src/audit/event-ledger';
import { ExportService } from '../src/exports/export-service';

const SELLER = 'G' + 'A'.repeat(55);
const PAYER = 'GCCC' + 'A'.repeat(52);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 208);
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 5);

/** mulberry32: tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Yield 0-3 event-loop turns, chosen by the seeded PRNG. */
const scheduler = (rand: () => number) => async () => {
  const turns = Math.floor(rand() * 4);
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

interface FakeRes {
  statusCode: number;
  body: any;
}

function createRes(): FakeRes & Response {
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const req = (init: { body?: any; params?: any; headers?: Record<string, string> }): Request =>
  ({ body: init.body ?? {}, params: init.params ?? {}, query: {}, headers: init.headers ?? {}, ip: '127.0.0.1', get: () => undefined }) as unknown as Request;

async function call(handler: (req: Request, res: Response) => Promise<void>, request: Request): Promise<FakeRes> {
  const res = createRes();
  await handler(request, res);
  return res;
}

function paymentTx(memo: string, amount: string) {
  return { transaction: { memo }, operations: [{ type: 'payment', from: PAYER, to: SELLER, amount, asset_type: 'native' }] };
}

/** Handlers over fresh memory storage, with a ledger-backed audit trail and a seeded Horizon. */
function rig(seed: number) {
  memoryStorage.clear();
  const rand = prng(seed);
  const pause = scheduler(rand);
  const ledger = new EventLedger();
  const audit = new MemoryAuditStore(10_000, { ledger });
  const storage = new MemoryInvoiceStorage();
  const wrapped = Object.create(storage) as InvoiceStorage;
  wrapped.recordAuditEvent = async (event: any) => {
    await pause();
    return audit.recordEvent(event);
  };
  // Interleave every storage mutation too, not just Horizon.
  for (const method of ['getInvoiceById', 'markAsPaid', 'cancelInvoice'] as const) {
    const original = (storage as any)[method].bind(storage);
    (wrapped as any)[method] = async (...args: any[]) => {
      await pause();
      const result = await original(...args);
      await pause();
      return result;
    };
  }
  const memos = new Map<string, { memo: string; amount: number }>();
  let horizonCalls = 0;
  const stellar = {
    async getTransaction(txHash: string) {
      horizonCalls += 1;
      await pause();
      const info = memos.get(txHash);
      return paymentTx(info?.memo ?? 'UNKNOWN', String(info?.amount ?? 1));
    },
  };
  const notifications: any = { syncInvoiceNotifications() {}, notifyPaymentRejected() {} };
  const handlers: InvoiceHandlers = createInvoiceHandlers({ storage: wrapped, stellar: stellar as any, notifications });
  return { handlers, storage, audit, ledger, memos, pause, rand, horizonCalls: () => horizonCalls };
}

async function createInvoice(handlers: InvoiceHandlers, amount = 25) {
  const res = await call(handlers.createInvoice, req({ body: { sellerPublicKey: SELLER, amount, assetCode: 'XLM' } }));
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body.data.invoice;
}

const seeds = Array.from({ length: ROUNDS }, (_, i) => BASE_SEED + i);
/** Which side won the verify/cancel race, across all seeds. */
const raceCoverage = new Set<string>();

describe('concurrency stress — concurrent success (#208)', () => {
  for (const seed of seeds) {
    it(`[seed ${seed}] 60 concurrent creates and settlements of distinct invoices all succeed with no collisions`, async () => {
      const r = rig(seed);
      const invoices = await Promise.all(Array.from({ length: 60 }, (_, i) => createInvoice(r.handlers, 10 + i)));
      assert.equal(new Set(invoices.map((i: any) => i.id)).size, 60, 'duplicate invoice id');
      assert.equal(new Set(invoices.map((i: any) => i.memo)).size, 60, 'duplicate memo');

      const results = await Promise.all(
        invoices.map((inv: any, i: number) => {
          const txHash = i.toString(16).padStart(64, 'a');
          r.memos.set(txHash, { memo: inv.memo, amount: inv.amount });
          return call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body: { txHash, payerPublicKey: PAYER } }));
        })
      );
      for (const res of results) assert.equal(res.statusCode, 200, JSON.stringify(res.body));

      for (const inv of invoices) {
        const stored = await r.storage.getInvoiceById(inv.id);
        assert.equal(stored?.status, 'PAID');
        assert.equal(stored?.version, 2);
      }
      assert.equal(r.audit.queryEvents({ action: 'PAYMENT_VERIFIED', limit: 500 }).total, 60);
      const doc = r.ledger.export();
      assert.equal(verifyLedgerExport(doc).valid, true, 'ledger chain broken under concurrency');
      assert.equal(doc.entries.filter((e) => e.action === 'PAYMENT_VERIFIED').length, 60);
      assert.equal(doc.entries.filter((e) => e.action === 'INVOICE_CREATED').length, 60);
    });
  }
});

describe('concurrency stress — duplicate retries (#208)', () => {
  for (const seed of seeds) {
    it(`[seed ${seed}] 50 duplicate verifies of one payment settle it exactly once`, async () => {
      const r = rig(seed);
      const inv = await createInvoice(r.handlers, 50);
      const txHash = 'b'.repeat(64);
      r.memos.set(txHash, { memo: inv.memo, amount: inv.amount });

      const results = await Promise.all(
        Array.from({ length: 50 }, () => call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body: { txHash, payerPublicKey: PAYER } })))
      );
      const ok = results.filter((res) => res.statusCode === 200);
      assert.equal(ok.length, 1, `expected one success, got ${ok.length}`);
      for (const res of results.filter((x) => x.statusCode !== 200)) {
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'INVOICE_ALREADY_PAID');
      }
      const stored = await r.storage.getInvoiceById(inv.id);
      assert.equal(stored?.version, 2, 'version bumped more than once');
      assert.equal(r.horizonCalls(), 1, 'duplicates reached Horizon');
      assert.equal(r.audit.queryEvents({ action: 'PAYMENT_VERIFIED' }).total, 1, 'duplicate irreversible audit record');
      assert.equal(r.ledger.export().entries.filter((e) => e.action === 'PAYMENT_VERIFIED').length, 1);
    });
  }

  it('a retry after success is answered without a second transition', async () => {
    const r = rig(BASE_SEED);
    const inv = await createInvoice(r.handlers);
    const txHash = 'c'.repeat(64);
    r.memos.set(txHash, { memo: inv.memo, amount: inv.amount });
    const body = { txHash, payerPublicKey: PAYER };
    assert.equal((await call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body }))).statusCode, 200);
    for (let i = 0; i < 5; i++) {
      const retry = await call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body }));
      assert.equal(retry.body.code, 'INVOICE_ALREADY_PAID');
    }
    assert.equal((await r.storage.getInvoiceById(inv.id))?.version, 2);
  });

  it('20 concurrent export retries with one idempotency key generate one artifact', async () => {
    const r = rig(BASE_SEED);
    await createInvoice(r.handlers);
    const service = new ExportService(r.storage);
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        await r.pause();
        return service.create(SELLER, { format: 'json', idempotencyKey: 'stress' });
      })
    );
    assert.equal(new Set(results.map((a) => a.meta.exportId)).size, 1);
    assert.equal(service.size(), 1);
  });
});

describe('concurrency stress — conflicting requests (#208)', () => {
  for (const seed of seeds) {
    it(`[seed ${seed}] verify racing cancel on one invoice: exactly one wins`, async () => {
      const r = rig(seed);
      const inv = await createInvoice(r.handlers, 30);
      const txHash = 'd'.repeat(60) + String(seed % 10000).padStart(4, '0');
      r.memos.set(txHash, { memo: inv.memo, amount: inv.amount });

      const [verify, cancel] = await Promise.all([
        call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body: { txHash, payerPublicKey: PAYER } })),
        (async () => {
          // Seeded head start for verify, so both orders occur across seeds.
          const turns = seed % 2 === 0 ? 0 : 6 + Math.floor(r.rand() * 20);
          for (let i = 0; i < turns; i++) await new Promise((res) => setImmediate(res));
          return call(r.handlers.cancelInvoice, req({ params: { id: inv.id }, body: { version: 1 } }));
        })(),
      ]);
      const stored = await r.storage.getInvoiceById(inv.id);
      raceCoverage.add(verify.statusCode === 200 ? 'verify' : 'cancel');
      const winners = [verify, cancel].filter((res) => res.statusCode === 200);
      assert.equal(winners.length, 1, `verify ${verify.statusCode} ${verify.body?.code} / cancel ${cancel.statusCode} ${cancel.body?.code}`);
      assert.equal(stored?.version, 2);
      if (verify.statusCode === 200) {
        assert.equal(stored?.status, 'PAID');
        assert.equal(stored?.paymentTxHash, txHash);
        assert.equal(r.audit.queryEvents({ action: 'INVOICE_CANCELLED' }).total, 0);
      } else {
        assert.equal(stored?.status, 'CANCELLED');
        assert.equal(stored?.paymentTxHash ?? null, null, 'a cancelled invoice must not carry a settlement');
        assert.equal(r.audit.queryEvents({ action: 'PAYMENT_VERIFIED' }).total, 0);
      }
    });

    it(`[seed ${seed}] one tx hash raced across 8 invoices settles at most one`, async () => {
      const r = rig(seed);
      const invoices = await Promise.all(Array.from({ length: 8 }, () => createInvoice(r.handlers, 40)));
      const txHash = 'e'.repeat(64);
      // The transaction pays the first invoice's memo; the others must fail validation or uniqueness.
      r.memos.set(txHash, { memo: invoices[0].memo, amount: 40 });
      await Promise.all(
        invoices.map((inv: any) => call(r.handlers.verifyPayment, req({ params: { id: inv.id }, body: { txHash, payerPublicKey: PAYER } })))
      );
      const stored = await Promise.all(invoices.map((inv: any) => r.storage.getInvoiceById(inv.id)));
      const settled = stored.filter((s) => s?.paymentTxHash === txHash);
      assert.equal(settled.length, 1, 'tx hash reused across invoices');
      assert.equal(settled[0]?.id, invoices[0].id);
    });

    it(`[seed ${seed}] 10 concurrent cancels with the same expected version: one 200, the rest conflict`, async () => {
      const r = rig(seed);
      const inv = await createInvoice(r.handlers);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => call(r.handlers.cancelInvoice, req({ params: { id: inv.id }, body: { version: 1 } })))
      );
      assert.equal(results.filter((x) => x.statusCode === 200).length, 1);
      for (const res of results.filter((x) => x.statusCode !== 200)) assert.ok([400, 409].includes(res.statusCode), String(res.statusCode));
      assert.equal((await r.storage.getInvoiceById(inv.id))?.version, 2);
      assert.equal(r.audit.queryEvents({ action: 'INVOICE_CANCELLED' }).total, 1);
    });
  }
});

describe('concurrency stress — race coverage (#208)', () => {
  it('exercised both outcomes of the verify/cancel race (otherwise the race test proves nothing)', () => {
    if (ROUNDS < 2) return;
    assert.deepEqual([...raceCoverage].sort(), ['cancel', 'verify']);
  });
});

describe('concurrency stress — lock manager and timeouts (#208)', () => {
  let locks: InvoiceLockManager;
  beforeEach(() => (locks = new InvoiceLockManager()));

  for (const seed of seeds) {
    it(`[seed ${seed}] 300 tasks over 5 keys: mutual exclusion and no lost updates`, async () => {
      const pause = scheduler(prng(seed));
      const counters = new Map<string, number>();
      const inside = new Map<string, number>();
      let maxInside = 0;
      const expected = new Map<string, number>();
      const rand = prng(seed ^ 0x5eed);

      await Promise.all(
        Array.from({ length: 300 }, async () => {
          const key = `inv-${Math.floor(rand() * 5)}`;
          expected.set(key, (expected.get(key) ?? 0) + 1);
          await pause();
          await locks.withLock(key, async () => {
            inside.set(key, (inside.get(key) ?? 0) + 1);
            maxInside = Math.max(maxInside, inside.get(key)!);
            const read = counters.get(key) ?? 0; // read-modify-write across awaits
            await pause();
            counters.set(key, read + 1);
            inside.set(key, inside.get(key)! - 1);
          });
        })
      );
      assert.equal(maxInside, 1, 'two tasks were inside one critical section');
      assert.deepEqual(Object.fromEntries([...counters].sort()), Object.fromEntries([...expected].sort()), 'lost update');
      assert.equal(locks.activeLocks, 0, 'leaked lock');
    });
  }

  it('releases the lock when the critical section throws', async () => {
    await assert.rejects(locks.withLock('k', async () => {
      throw new Error('horizon exploded');
    }), /horizon exploded/);
    assert.equal(locks.isLocked('k'), false);
    assert.equal(await locks.withLock('k', () => 'next'), 'next');
  });

  it('times out waiters behind a stuck holder without ever running them later', async () => {
    const release = await locks.acquire('stuck');
    let ranLate = 0;
    const waiters = Array.from({ length: 10 }, () =>
      locks.withLock('stuck', () => {
        ranLate += 1;
      }, { timeoutMs: 20 })
    );
    const results = await Promise.allSettled(waiters);
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.ok((r as PromiseRejectedResult).reason instanceof LockTimeoutError);
      assert.equal((r as PromiseRejectedResult).reason.code, 'LOCK_TIMEOUT');
    }
    assert.equal(locks.isLocked('stuck'), true, 'a timeout must not steal the holder\'s lock');
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ranLate, 0, 'a timed-out waiter acquired the lock after giving up');
    assert.equal(locks.activeLocks, 0);
  });

  it('lets a waiter with enough patience through once the holder releases', async () => {
    const release = await locks.acquire('slow');
    setTimeout(release, 10);
    assert.equal(await locks.withLock('slow', () => 'got it', { timeoutMs: 500 }), 'got it');
  });

  it('serves a mix of patient and impatient waiters correctly', async () => {
    const release = await locks.acquire('mix');
    setTimeout(release, 25);
    const outcomes = await Promise.allSettled([
      locks.withLock('mix', () => 'patient-1', { timeoutMs: 1000 }),
      locks.withLock('mix', () => 'impatient', { timeoutMs: 5 }),
      locks.withLock('mix', () => 'patient-2'),
    ]);
    assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(locks.activeLocks, 0);
  });

  it('treats timeoutMs 0 as try-lock and rejects invalid timeouts', async () => {
    const release = await locks.acquire('try');
    await assert.rejects(locks.acquire('try', { timeoutMs: 0 }), LockTimeoutError);
    release();
    (await locks.acquire('try', { timeoutMs: 0 }))();
    for (const bad of [-1, Number.NaN, Infinity]) await assert.rejects(locks.acquire('x', { timeoutMs: bad }), RangeError);
  });
});
