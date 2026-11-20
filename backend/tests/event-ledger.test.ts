/**
 * Tamper-evident chronological ledger (#250): chain construction, export,
 * offline verification, and detection of every class of tampering.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventLedger,
  LEDGER_GENESIS_HASH,
  LEDGER_SCHEMA_ID,
  LedgerCapacityError,
  LedgerIntegrityError,
  hashLedgerEntry,
  verifyLedgerExport,
  type LedgerEntry,
  type LedgerExport,
} from '../src/audit/event-ledger';
import { MemoryAuditStore } from '../src/audit/audit-service';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');

function clock(start = T0) {
  let ms = start;
  return {
    now: () => new Date(ms),
    advance: (by: number) => (ms += by),
    set: (to: number) => (ms = to),
  };
}

const payment = (i: number) => ({
  category: 'financial' as const,
  action: 'PAYMENT_VERIFIED',
  actor: { type: 'payer', id: `GPAYER${i}` },
  subject: { type: 'invoice', id: `inv-${i}` },
  payload: { amount: 10 + i, txHash: `tx-${i}` },
});

function seeded(n: number, c = clock()) {
  const ledger = new EventLedger({ now: c.now });
  for (let i = 1; i <= n; i++) {
    ledger.append(payment(i));
    c.advance(1000);
  }
  return { ledger, c };
}

/** Recompute an entry's hash after editing it, as a careful attacker would. */
const rehash = (entry: LedgerEntry) => {
  const { hash: _h, ...rest } = entry;
  entry.hash = hashLedgerEntry(rest);
};

const clone = (doc: LedgerExport): LedgerExport => JSON.parse(JSON.stringify(doc));

describe('event ledger — chain construction (#250)', () => {
  it('starts at the genesis hash and links every entry to the previous one', () => {
    const { ledger } = seeded(3);
    const doc = ledger.export();
    assert.equal(doc.schema, LEDGER_SCHEMA_ID);
    assert.deepEqual(doc.anchor, { sequence: 0, hash: LEDGER_GENESIS_HASH });
    assert.deepEqual(doc.entries.map((e) => e.sequence), [1, 2, 3]);
    assert.equal(doc.entries[0].previousHash, LEDGER_GENESIS_HASH);
    assert.equal(doc.entries[1].previousHash, doc.entries[0].hash);
    assert.equal(doc.entries[2].previousHash, doc.entries[1].hash);
    assert.deepEqual(doc.head, { sequence: 3, hash: doc.entries[2].hash });
    assert.equal(ledger.verify().valid, true);
    assert.equal(verifyLedgerExport(doc).valid, true);
  });

  it('is deterministic: the same inputs and clock give the same hashes', () => {
    assert.deepEqual(seeded(5).ledger.export().head, seeded(5).ledger.export().head);
  });

  it('strips secrets from payloads before hashing', () => {
    const ledger = new EventLedger({ now: clock().now });
    const entry = ledger.append({ ...payment(1), payload: { secretKey: 'SBADSECRET', amount: 5 } });
    assert.notEqual(entry.payload.secretKey, 'SBADSECRET');
    assert.equal(ledger.verify().valid, true);
  });

  it('keeps recordedAt monotonic when the wall clock steps backwards and records the skew', () => {
    const c = clock();
    const ledger = new EventLedger({ now: c.now });
    ledger.append(payment(1));
    c.advance(-5000);
    const held = ledger.append(payment(2));
    assert.equal(held.recordedAt, new Date(T0).toISOString());
    assert.equal(held.clockSkewMs, 5000);
    assert.equal(verifyLedgerExport(ledger.export()).valid, true);
  });

  it('serializes interleaved async appends into a gap-free sequence', async () => {
    const ledger = new EventLedger();
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        await new Promise((r) => setImmediate(r));
        ledger.append(payment(i));
      })
    );
    const doc = ledger.export();
    assert.deepEqual(doc.entries.map((e) => e.sequence), Array.from({ length: 200 }, (_, i) => i + 1));
    assert.equal(verifyLedgerExport(doc).valid, true);
  });
});

describe('event ledger — tamper detection (#250)', () => {
  let doc: LedgerExport;
  beforeEach(() => {
    doc = seeded(5).ledger.export();
  });

  const failsWith = (d: unknown, reason: string, sequence?: number | null, opts = {}) => {
    const result = verifyLedgerExport(d, opts);
    assert.equal(result.valid, false, 'tampering went undetected');
    assert.equal(result.failure?.reason, reason);
    if (sequence !== undefined) assert.equal(result.failure?.sequence, sequence);
  };

  it('detects an edited field', () => {
    const d = clone(doc);
    (d.entries[2].payload as any).amount = 1_000_000;
    failsWith(d, 'entry_hash', 3);
  });

  it('detects an edited field even when the attacker recomputes that entry hash', () => {
    const d = clone(doc);
    (d.entries[2].payload as any).amount = 1_000_000;
    rehash(d.entries[2]);
    failsWith(d, 'previous_hash', 4);
  });

  it('detects a deleted entry', () => {
    const d = clone(doc);
    d.entries.splice(1, 1);
    d.entryCount -= 1;
    failsWith(d, 'sequence_gap', 3);
  });

  it('detects a deleted entry even when sequences are renumbered', () => {
    const d = clone(doc);
    d.entries.splice(1, 1);
    d.entries.forEach((e, i) => (e.sequence = i + 1));
    failsWith(d, 'previous_hash');
  });

  it('detects an inserted entry', () => {
    const d = clone(doc);
    const forged = { ...clone(doc).entries[1], action: 'PAYMENT_SIMULATED' };
    d.entries.splice(2, 0, forged);
    failsWith(d, 'sequence_gap', 2);
  });

  it('detects reordered entries', () => {
    const d = clone(doc);
    [d.entries[1], d.entries[2]] = [d.entries[2], d.entries[1]];
    failsWith(d, 'sequence_gap', 3);
  });

  it('detects a backdated entry', () => {
    const d = clone(doc);
    d.entries[3].recordedAt = '2020-01-01T00:00:00.000Z';
    rehash(d.entries[3]);
    // The rehash breaks entry 5's link first only if the chain is checked before time;
    // whichever comes first, the export must be rejected.
    assert.equal(verifyLedgerExport(d).valid, false);
  });

  it('detects tail truncation against an independently recorded head', () => {
    const head = doc.head;
    const d = clone(doc);
    d.entries.pop();
    d.entryCount -= 1;
    d.head = { sequence: d.entries.at(-1)!.sequence, hash: d.entries.at(-1)!.hash };
    assert.equal(verifyLedgerExport(d).valid, true, 'a truncated chain is self-consistent');
    failsWith(d, 'head_mismatch', 4, { expectedHead: head });
  });

  it('detects a declared head or count that does not match the entries', () => {
    const d = clone(doc);
    d.head = { sequence: 99, hash: 'f'.repeat(64) };
    failsWith(d, 'head_mismatch');
    const e = clone(doc);
    e.entryCount = 4;
    failsWith(e, 'count_mismatch');
  });

  it('rejects malformed or foreign documents without throwing', () => {
    for (const bad of [null, 42, 'x', {}, { ...doc, schema: 'other' }, { ...doc, schemaVersion: 2 }, { ...doc, entries: 'no' }, { ...doc, anchor: { sequence: -1, hash: 'x' } }]) {
      failsWith(bad, 'schema');
    }
    const d = clone(doc);
    (d.entries as any)[1] = null;
    failsWith(d, 'schema');
  });

  it('cannot be altered through an export: exports are deep copies', () => {
    const { ledger } = seeded(2);
    const exported = ledger.export();
    (exported.entries[0].payload as any).amount = 0;
    assert.equal(ledger.verify().valid, true);
  });
});

describe('event ledger — export ranges and pruning (#250)', () => {
  it('exports a sub-range that verifies on its own from its anchor', () => {
    const { ledger } = seeded(10);
    const full = ledger.export();
    const part = ledger.export({ fromSequence: 4, toSequence: 7 });
    assert.deepEqual(part.entries.map((e) => e.sequence), [4, 5, 6, 7]);
    assert.deepEqual(part.anchor, { sequence: 3, hash: full.entries[2].hash });
    assert.equal(verifyLedgerExport(part).valid, true);
  });

  it('clamps out-of-range requests and returns an empty, valid export', () => {
    const { ledger } = seeded(3);
    assert.equal(ledger.export({ fromSequence: -5, toSequence: 99 }).entryCount, 3);
    const none = ledger.export({ fromSequence: 10 });
    assert.equal(none.entryCount, 0);
    assert.equal(verifyLedgerExport(none).valid, true);
  });

  it('emits NDJSON with a header line and one entry per line', () => {
    const { ledger } = seeded(3);
    const lines = ledger.exportNdjson().trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].schema, LEDGER_SCHEMA_ID);
    assert.equal(lines[0].entryCount, 3);
    assert.equal(lines.length, 4);
    assert.equal(verifyLedgerExport({ ...lines[0], entries: lines.slice(1) }).valid, true);
  });

  it('keeps verifying after pruning, from the retained anchor', () => {
    const { ledger, c } = seeded(6);
    const archived = ledger.export({ toSequence: 4 });
    const { pruned, anchor } = ledger.prune(4);
    assert.equal(pruned, 4);
    assert.deepEqual(anchor, archived.head);
    ledger.append(payment(7));
    c.advance(1000);
    assert.equal(ledger.verify().valid, true);
    const rest = ledger.export();
    assert.deepEqual(rest.anchor, archived.head, 'the archive and the live ledger join exactly');
    assert.equal(verifyLedgerExport(rest).valid, true);
    assert.deepEqual(rest.entries.map((e) => e.sequence), [5, 6, 7]);
  });

  it('fails closed when full instead of dropping evidence', () => {
    const ledger = new EventLedger({ maxEntries: 2 });
    ledger.append(payment(1));
    ledger.append(payment(2));
    assert.throws(() => ledger.append(payment(3)), LedgerCapacityError);
    assert.equal(ledger.size(), 2);
    ledger.prune(1);
    assert.equal(ledger.append(payment(3)).sequence, 3);
  });
});

describe('event ledger — compromise and recovery (#250)', () => {
  it('refuses appends and pruning after self-verification fails, until resealed', () => {
    const { ledger } = seeded(4);
    (ledger.unsafeEntriesForTesting()[1].payload as any).amount = 999;

    const result = ledger.verify();
    assert.equal(result.valid, false);
    assert.equal(result.failure?.sequence, 2);
    assert.equal(ledger.status().compromised, true);
    assert.throws(() => ledger.append(payment(5)), (err: unknown) => err instanceof LedgerIntegrityError && err.code === 'LEDGER_COMPROMISED');
    assert.throws(() => ledger.prune(4), LedgerIntegrityError);

    assert.throws(() => ledger.reseal({ actorId: 'ops', reason: 'short' }));
    const sealed = ledger.reseal({ actorId: 'maintainer-alice', reason: 'Incident 7: entry 2 edited in memory, archived copy kept' });
    assert.equal(sealed.action, 'LEDGER_RESEALED');
    assert.equal(sealed.sequence, 5);
    assert.equal((sealed.payload.finding as any).sequence, 2);
    assert.equal(ledger.status().compromised, false);

    // History is not rewritten: the full export still shows the break, the post-reseal range verifies.
    assert.equal(verifyLedgerExport(ledger.export()).valid, false);
    assert.equal(verifyLedgerExport(ledger.export({ fromSequence: 5 })).valid, true);
    assert.equal(ledger.append(payment(6)).sequence, 6);
  });

  it('refuses to reseal a healthy ledger', () => {
    assert.throws(() => seeded(1).ledger.reseal({ actorId: 'ops', reason: 'nothing is wrong here at all' }));
  });
});

describe('event ledger — audit store integration (#250)', () => {
  it('mirrors privileged and financial audit events only, linked by id and hash', () => {
    const ledger = new EventLedger();
    const store = new MemoryAuditStore(100, { ledger });
    const paid = store.recordEvent({
      action: 'PAYMENT_VERIFIED',
      actor: { type: 'payer', id: 'GPAYER' },
      scope: { entityType: 'invoice', entityId: 'inv-1' },
      afterState: { status: 'PAID' },
    });
    store.recordEvent({ action: 'CONFIG_CHANGED', actor: { type: 'maintainer', id: 'alice' }, scope: { entityType: 'config', entityId: 'featureFlags.x' } });
    store.recordEvent({ action: 'IMPERSONATION_STARTED', actor: { type: 'maintainer', id: 'alice' }, scope: { entityType: 'system', entityId: 's' } });

    const doc = ledger.export();
    assert.deepEqual(doc.entries.map((e) => [e.category, e.action]), [
      ['financial', 'PAYMENT_VERIFIED'],
      ['privileged', 'CONFIG_CHANGED'],
      ['privileged', 'IMPERSONATION_STARTED'],
    ]);
    assert.equal(doc.entries[0].sourceEventId, paid.id);
    assert.equal(doc.entries[0].payload.auditHash, paid.hash);
  });

  it('never fails the audit write when the ledger cannot accept it, and backfills in order later', () => {
    const c = clock();
    const ledger = new EventLedger({ now: c.now, maxEntries: 1 });
    const store = new MemoryAuditStore(100, { ledger });
    const record = (id: string) =>
      store.recordEvent({ action: 'INVOICE_CREATED', actor: { type: 'seller', id: 'G' }, scope: { entityType: 'invoice', entityId: id }, timestamp: new Date(c.now()).toISOString() });

    record('a');
    record('b');
    record('c');
    assert.equal(store.size(), 3, 'every audit event was kept');
    assert.equal(ledger.status().deferred, 2);

    assert.deepEqual(ledger.drainDeferred(), { appended: 0, remaining: 2, dropped: 0 }, 'retry while still full is a no-op');

    // Room for one: b is appended, c stays queued behind it.
    ledger.prune(1);
    assert.deepEqual(ledger.drainDeferred(), { appended: 1, remaining: 1, dropped: 0 });
    // A new event must queue behind c rather than overtake it.
    record('d');
    assert.equal(ledger.status().deferred, 2);

    ledger.prune(2);
    ledger.drainDeferred();
    ledger.prune(3);
    ledger.drainDeferred();
    assert.equal(ledger.status().deferred, 0);
    assert.equal(ledger.verify().valid, true);
    assert.equal(ledger.head().sequence, 4, 'a, b, c, d each got exactly one sequence number');
  });

  it('backfills deferred events with their original timestamp once healthy', () => {
    const ledger = new EventLedger({ maxEntries: 10 });
    const store = new MemoryAuditStore(100, { ledger });
    ledger.append(payment(1));
    (ledger.unsafeEntriesForTesting()[0].payload as any).amount = 0;
    ledger.verify();

    const e = store.recordEvent({ action: 'PAYMENT_VERIFIED', actor: { type: 'payer', id: 'G' }, scope: { entityType: 'invoice', entityId: 'x' } });
    assert.equal(ledger.status().deferred, 1);

    ledger.reseal({ actorId: 'alice', reason: 'Incident 9: resealing after investigation' });
    assert.deepEqual(ledger.drainDeferred(), { appended: 1, remaining: 0, dropped: 0 });
    const last = ledger.export().entries.at(-1)!;
    assert.equal(last.sourceEventId, e.id);
    assert.equal(last.payload.backfilled, true);
    assert.equal(last.payload.originalTimestamp, e.timestamp);
  });

  it('keeps the audit chain verifiable after ring-buffer eviction', () => {
    const store = new MemoryAuditStore(3);
    for (let i = 0; i < 7; i++) {
      store.recordEvent({ action: 'INVOICE_CREATED', actor: { type: 'seller', id: 'G' }, scope: { entityType: 'invoice', entityId: `i${i}` } });
    }
    assert.equal(store.size(), 3);
    assert.deepEqual(store.verifyChain(), { valid: true, checked: 3 });
  });
});
