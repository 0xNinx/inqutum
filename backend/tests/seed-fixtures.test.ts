import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED_ANCHOR,
  SEED_IDS,
  buildSeedDataset,
  seedDatasetToSql,
  seedResetSql,
  validateSeedDataset,
  type SeedDataset,
} from '../src/sandbox/seed-fixtures';

const codes = (ds: SeedDataset) => validateSeedDataset(ds).issues.map((i) => i.code);

describe('Contributor seed fixtures (#201)', () => {
  it('the committed dataset is internally consistent', () => {
    const result = validateSeedDataset(buildSeedDataset());
    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
    assert.equal(result.counts.invoices, 8);
  });

  it('is deterministic: same anchor, deeply equal output and identical SQL', () => {
    const a = buildSeedDataset();
    const b = buildSeedDataset(DEFAULT_SEED_ANCHOR);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(seedDatasetToSql(a), seedDatasetToSql(b));
  });

  it('returns fresh objects so callers can mutate their copy safely', () => {
    const a = buildSeedDataset();
    a.invoices[0].status = 'CANCELLED';
    assert.equal(buildSeedDataset().invoices[0].status, 'PENDING');
  });

  it('stays consistent when re-anchored to another time (e.g. --anchor now)', () => {
    const shifted = buildSeedDataset('2030-06-01T00:00:00.000Z');
    assert.deepEqual(validateSeedDataset(shifted).issues, []);
    const delta = shifted.anchor.getTime() - buildSeedDataset().anchor.getTime();
    assert.equal(shifted.invoices[0].createdAt.getTime() - buildSeedDataset().invoices[0].createdAt.getTime(), delta);
  });

  it('covers the required edge cases', () => {
    const ds = buildSeedDataset();
    const anchor = ds.anchor.getTime();
    assert.ok(ds.settlements.some((s) => s.status === 'failed' && s.failureReason), 'failed settlement');
    assert.ok(ds.authorizations.some((a) => a.status === 'revoked'), 'revoked access');
    assert.ok(ds.workflows.some((w) => w.state !== 'completed' && w.slaDueAt.getTime() < anchor), 'overdue workflow');
    assert.ok(ds.invoices.some((i) => i.createdAt.getTime() < anchor - 365 * 86_400_000 && !i._schemaVersion), 'historical record');
    assert.ok(ds.authorizations.some((a) => a.status === 'active' && a.expiresAt.getTime() <= anchor), 'stale authorization');
    assert.ok(ds.jobs.some((j) => j.status === 'dead'), 'dead-lettered job');
    assert.ok(ds.invoices.some((i) => i.status === 'EXPIRED') && ds.invoices.some((i) => i.status === 'CANCELLED'));
  });

  it('contains no secrets, real emails or non-testnet identifiers', () => {
    const json = JSON.stringify(buildSeedDataset());
    assert.doesNotMatch(json, /\bS[A-Z2-7]{55}\b/, 'no Stellar secret seeds');
    for (const email of json.match(/[\w.+-]+@[\w.-]+/g) ?? []) assert.match(email, /\.test$/);
  });

  describe('validator catches broken edits', () => {
    it('missing references', () => {
      const ds = buildSeedDataset();
      ds.settlements[0].invoiceId = 'nope';
      ds.workflows[0].ownerId = 'ghost';
      assert.ok(codes(ds).filter((c) => c === 'MISSING_REFERENCE').length >= 2);
    });

    it('PAID invoice without a matching confirmed settlement', () => {
      const ds = buildSeedDataset();
      ds.settlements.find((s) => s.invoiceId === SEED_IDS.invPaid)!.status = 'pending';
      assert.ok(codes(ds).includes('PAID_WITHOUT_SETTLEMENT'));
    });

    it('PENDING invoice already past expiry (would be lazily expired on load)', () => {
      const ds = buildSeedDataset();
      ds.invoices.find((i) => i.id === SEED_IDS.invPending)!.expiresAt = new Date(ds.anchor.getTime() - 1);
      assert.ok(codes(ds).includes('PENDING_PAST_EXPIRY'));
    });

    it('broken renewal chain', () => {
      const ds = buildSeedDataset();
      ds.authorizations.find((a) => a.id === SEED_IDS.authRenewedNew)!.renewedFromId = undefined;
      assert.ok(codes(ds).includes('BROKEN_RENEWAL_CHAIN'));
    });

    it('duplicate ids and memos', () => {
      const ds = buildSeedDataset();
      ds.invoices.push({ ...ds.invoices[0] });
      const found = codes(ds);
      assert.ok(found.includes('DUPLICATE_ID'));
      assert.ok(found.includes('DUPLICATE_MEMO'));
    });

    it('secret material and real email domains', () => {
      const ds = buildSeedDataset();
      ds.users[0].email = 'someone@gmail.com';
      ds.invoices[0].description = `S${'A'.repeat(55)}`;
      const found = codes(ds);
      assert.ok(found.includes('UNSAFE_EMAIL'));
      assert.ok(found.includes('SECRET_MATERIAL'));
    });
  });

  describe('SQL export', () => {
    it('emits idempotent inserts for every Postgres-backed row', () => {
      const ds = buildSeedDataset();
      const sql = seedDatasetToSql(ds);
      assert.equal(sql.match(/INSERT INTO invoices/g)?.length, ds.invoices.length);
      assert.equal(sql.match(/INSERT INTO transactions/g)?.length, ds.settlements.length);
      assert.equal(sql.match(/INSERT INTO jobs/g)?.length, ds.jobs.length);
      assert.equal(sql.match(/ON CONFLICT DO NOTHING/g)?.length, ds.invoices.length + ds.settlements.length + ds.jobs.length);
    });

    it('reset deletes only seeded ids, children before parents', () => {
      const sql = seedResetSql(buildSeedDataset());
      const order = ['DELETE FROM jobs', 'DELETE FROM transactions', 'DELETE FROM payment_events', 'DELETE FROM invoices'].map((s) => sql.indexOf(s));
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      assert.ok(!/DELETE FROM \w+;/.test(sql), 'never an unscoped delete');
    });
  });
});
