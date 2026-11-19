/**
 * Data minimization and retention enforcement for operational metadata (#246).
 *
 * Classification is data, review is pure, deletion is testable: the executor
 * runs against an in-memory `invoices` table double that understands the two
 * statements it issues (keyset SELECT and compare-and-set UPDATE).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  METADATA_FIELD_POLICY,
  classifyMetadataKey,
  normalizeMetadataKey,
  planMetadataMinimization,
  reviewMetadata,
  runMetadataMinimization,
  type MetadataDatabase,
} from '../src/db/metadata-minimization';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

describe('metadata classification (#246)', () => {
  it('classifies every policy key into exactly one category with a rationale', () => {
    for (const [key, rule] of Object.entries(METADATA_FIELD_POLICY)) {
      assert.equal(normalizeMetadataKey(key), key, `${key} must be stored normalized`);
      assert.ok(rule.rationale.length > 20, `${key} needs a rationale`);
    }
    assert.equal(METADATA_FIELD_POLICY.idempotency_key.retainDays, 30);
  });

  it('normalizes camelCase, dashes and spaces before classifying', () => {
    assert.equal(classifyMetadataKey('ipAddress')?.category, 'network_identifier');
    assert.equal(classifyMetadataKey('User-Agent')?.category, 'network_identifier');
    assert.equal(classifyMetadataKey('API key')?.category, 'prohibited');
    assert.equal(classifyMetadataKey('orderId')?.category, 'business_reference');
    assert.equal(classifyMetadataKey('favourite_colour'), null);
  });
});

describe('reviewMetadata (#246)', () => {
  it('removes prohibited keys at any age and at any depth, never reporting values', () => {
    const review = reviewMetadata(
      {
        id: 'a',
        createdAt: daysAgo(0),
        metadata: { order: 'A-17', cvv: '123', integration: { name: 'shop', apiKey: 'sk_live', hooks: [{ token: 't' }] } },
      },
      NOW
    );
    assert.deepEqual(review.next, { order: 'A-17', integration: { hooks: [{}], name: 'shop' } });
    assert.deepEqual(review.removed.map((r) => r.path).sort(), ['cvv', 'integration.apiKey', 'integration.hooks[0].token']);
    assert.ok(!JSON.stringify(review.removed).includes('sk_live'));
  });

  it('enforces windows per category relative to created_at', () => {
    const metadata = { ip: '203.0.113.9', source: 'csv-import', idempotency_key: 'k1', order: 'A-1' };

    const at29 = reviewMetadata({ id: 'a', createdAt: daysAgo(29), metadata }, NOW);
    assert.equal(at29.changed, false);
    assert.equal(at29.nextReviewAt, new Date(NOW.getTime() + 1 * DAY).toISOString());

    const at30 = reviewMetadata({ id: 'a', createdAt: daysAgo(30), metadata }, NOW);
    assert.deepEqual(Object.keys(at30.next).sort(), ['order', 'source']);

    const at90 = reviewMetadata({ id: 'a', createdAt: daysAgo(90), metadata }, NOW);
    assert.deepEqual(at90.next, { order: 'A-1' });
    assert.equal(at90.nextReviewAt, null);
  });

  it('keeps unclassified keys and reports them', () => {
    const review = reviewMetadata({ id: 'a', createdAt: daysAgo(500), metadata: { colour: 'blue', order: 'x' } }, NOW);
    assert.equal(review.changed, false);
    assert.deepEqual(review.unclassified, ['colour']);
  });

  it('a legal hold pins everything and escalates prohibited data instead of deleting it', () => {
    const review = reviewMetadata(
      { id: 'a', createdAt: daysAgo(400), metadata: { under_dispute: true, ip: '1.2.3.4', password: 'x' } },
      NOW
    );
    assert.equal(review.held, true);
    assert.equal(review.changed, false);
    assert.deepEqual(review.prohibitedUnderHold, ['password']);
  });

  it('an unparseable created_at disables age-based removal but not prohibited removal', () => {
    const review = reviewMetadata({ id: 'a', createdAt: 'not-a-date', metadata: { ip: '1.2.3.4', secret: 's' } }, NOW);
    assert.deepEqual(review.next, { ip: '1.2.3.4' });
  });

  it('tolerates null, arrays and scalars as metadata', () => {
    for (const metadata of [null, undefined, [] as any, 'str' as any]) {
      assert.equal(reviewMetadata({ id: 'a', createdAt: daysAgo(1), metadata }, NOW).changed, false);
    }
  });
});

describe('planMetadataMinimization (#246)', () => {
  it('is order-independent and summarises by category', () => {
    const records = [
      { id: 'b', createdAt: daysAgo(40), metadata: { ip: '1.1.1.1', vendor_note: 'x' } },
      { id: 'a', createdAt: daysAgo(1), metadata: { token: 't' } },
      { id: 'c', createdAt: daysAgo(1), metadata: { legal_hold: true, cvv: '1' } },
    ];
    const plan = planMetadataMinimization(records, NOW);
    assert.deepEqual(plan, planMetadataMinimization([...records].reverse(), NOW));
    assert.deepEqual(plan.changes.map((c) => c.id), ['a', 'b']);
    assert.deepEqual(plan.removedByCategory, { prohibited: 1, network_identifier: 1 });
    assert.deepEqual(plan.unclassifiedKeys, { vendor_note: 1 });
    assert.deepEqual(plan.escalations, [{ id: 'c', paths: ['cvv'] }]);
  });
});

/** Minimal `invoices` table double for the executor's two statements. */
function fakeDb(rows: Array<{ id: string; created_at: string; metadata: Record<string, unknown> | null }>) {
  const table = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  const log: string[] = [];
  let beforeUpdate: ((id: string) => void) | undefined;

  const db: MetadataDatabase = {
    async query(text, params = []) {
      const sql = text.trim();
      if (sql.startsWith('SELECT')) {
        log.push('select');
        const [afterId, limit] = params as [string, number];
        const page = [...table.values()]
          .filter((row) => row.metadata && Object.keys(row.metadata).length > 0 && row.id > afterId)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit);
        return { rows: structuredClone(page) };
      }
      if (sql.startsWith('UPDATE')) {
        log.push('update');
        const [id, next, expected] = params as [string, string, string];
        beforeUpdate?.(id);
        const row = table.get(id);
        if (!row || JSON.stringify(row.metadata) !== expected) return { rows: [], rowCount: 0 };
        row.metadata = JSON.parse(next);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, table, log, onBeforeUpdate: (fn: (id: string) => void) => (beforeUpdate = fn) };
}

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('runMetadataMinimization (#246)', () => {
  it('dry run (the default) reports but never writes', async () => {
    const { db, table, log } = fakeDb([{ id: uuid(1), created_at: daysAgo(100), metadata: { ip: '1.1.1.1', order: 'A' } }]);
    const result = await runMetadataMinimization(db, { now: NOW });
    assert.equal(result.dryRun, true);
    assert.equal(result.changed, 1);
    assert.equal(result.updated, 0);
    assert.ok(!log.includes('update'));
    assert.deepEqual(table.get(uuid(1))!.metadata, { ip: '1.1.1.1', order: 'A' });
  });

  it('apply deletes expired and prohibited fields and is idempotent', async () => {
    const { db, table } = fakeDb([
      { id: uuid(1), created_at: daysAgo(100), metadata: { ip: '1.1.1.1', order: 'A' } },
      { id: uuid(2), created_at: daysAgo(1), metadata: { password: 'p', source: 'api' } },
      { id: uuid(3), created_at: daysAgo(1), metadata: { order: 'B' } },
    ]);
    const first = await runMetadataMinimization(db, { now: NOW, dryRun: false });
    assert.equal(first.updated, 2);
    assert.equal(first.complete, true);
    assert.deepEqual(table.get(uuid(1))!.metadata, { order: 'A' });
    assert.deepEqual(table.get(uuid(2))!.metadata, { source: 'api' });

    const second = await runMetadataMinimization(db, { now: NOW, dryRun: false });
    assert.equal(second.changed, 0);
    assert.equal(second.updated, 0);
  });

  it('pages in bounded batches and resumes from lastId', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: uuid(i + 1),
      created_at: daysAgo(60),
      metadata: { ip: '10.0.0.1' } as Record<string, unknown>,
    }));
    const { db, log } = fakeDb(rows);

    const partial = await runMetadataMinimization(db, { now: NOW, dryRun: false, batchSize: 10, maxBatches: 2 });
    assert.equal(partial.reviewed, 20);
    assert.equal(partial.complete, false);
    assert.equal(partial.lastId, uuid(20));

    const rest = await runMetadataMinimization(db, { now: NOW, dryRun: false, batchSize: 10, afterId: partial.lastId! });
    assert.equal(rest.reviewed, 5);
    assert.equal(rest.complete, true);
    assert.equal(log.filter((l) => l === 'select').length, 3);
  });

  it('never overwrites a concurrent edit (compare-and-set)', async () => {
    const { db, table, onBeforeUpdate } = fakeDb([
      { id: uuid(1), created_at: daysAgo(100), metadata: { ip: '1.1.1.1', order: 'A' } },
    ]);
    onBeforeUpdate((id) => {
      table.get(id)!.metadata = { ip: '1.1.1.1', order: 'A', legal_hold: true };
    });
    const result = await runMetadataMinimization(db, { now: NOW, dryRun: false });
    assert.equal(result.updated, 0);
    assert.equal(result.skippedConcurrentChange, 1);
    assert.deepEqual(table.get(uuid(1))!.metadata, { ip: '1.1.1.1', order: 'A', legal_hold: true });
  });
});
