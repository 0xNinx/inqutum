/**
 * Retention deletion verification and apply authorization (#431).
 *
 * Extends data-retention.test.ts with the apply-path properties that issue
 * asks for: normal, failure, retry and authorization paths. The fake pool
 * supports transactions with snapshot semantics, so a rollback restores rows
 * the way a real database would. Written for review; not executed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RETENTION_SWEEP_JOB, type RetentionSweepPayload } from '../src/db/retention';
import {
  RetentionVerificationError,
  registerRetentionJob,
  runRetentionSweep,
  type RetentionDatabase,
} from '../src/db/retention-sweep';
import { JobWorker } from '../src/jobs/worker';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { NonRetryableJobError } from '../src/jobs/job-types';

const NOW = new Date('2026-09-27T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface FakeState {
  rows: Record<string, any[]>;
  log: string[];
  transactional: boolean;
  snapshot: Record<string, any[]> | null;
  begins: number;
  commits: number;
  rollbacks: number;
  /** DELETE on this table throws, as a deadlock or dropped connection would. */
  failDeleteOn?: string;
  /** DELETE on this table reports zero rows and removes nothing. */
  zeroCountOn?: string;
  /** DELETE on this table reports success, but the rows survive. */
  ghostOn?: string;
  /** ROLLBACK itself fails. */
  rollbackFails?: boolean;
}

/**
 * Seeded so that, at NOW, exactly two invoices and one payment event are
 * eligible. The PAID invoice, the recent invoice and the old transaction are
 * protected.
 */
function seed(overrides: Partial<FakeState> = {}): FakeState {
  return {
    rows: {
      settlementLinks: [{ id: 'i-paid' }],
      invoices: [
        { id: 'i-old-1', status: 'EXPIRED', created_at: daysAgo(800), metadata: null },
        { id: 'i-old-2', status: 'CANCELLED', created_at: daysAgo(900), metadata: null },
        { id: 'i-recent', status: 'PENDING', created_at: daysAgo(3), metadata: null },
        { id: 'i-paid', status: 'PAID', created_at: daysAgo(900), metadata: null },
      ],
      transactions: [{ id: 't-old', created_at: daysAgo(5000) }],
      payment_events: [{ id: 'e-old', created_at: daysAgo(800) }],
      jobs: [],
    },
    log: [],
    transactional: true,
    snapshot: null,
    begins: 0,
    commits: 0,
    rollbacks: 0,
    ...overrides,
  };
}

function fakeDb(state: FakeState): RetentionDatabase {
  const query: RetentionDatabase['query'] = async (text, params = []) => {
    state.log.push(text.trim().split('\n')[0]);

    if (/^\s*DELETE/i.test(text)) {
      const table = /DELETE FROM "([^"]+)"/.exec(text)?.[1] ?? '';
      const ids = (params[0] as string[]) ?? [];
      if (state.failDeleteOn === table) throw new Error(`deadlock detected on ${table}`);
      if (state.zeroCountOn === table) return { rows: [], rowCount: 0 };
      if (state.ghostOn === table) return { rows: [], rowCount: ids.length };
      const before = state.rows[table]?.length ?? 0;
      state.rows[table] = (state.rows[table] ?? []).filter((r) => !ids.includes(String(r.id)));
      return { rows: [], rowCount: before - state.rows[table].length };
    }

    if (text.includes("status = 'PAID'")) return { rows: state.rows.settlementLinks ?? [] };

    const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? '';
    const all = state.rows[table] ?? [];
    if (text.includes('WHERE id = ANY')) {
      const ids = (params[0] as string[]) ?? [];
      return { rows: all.filter((r) => ids.includes(String(r.id))) };
    }
    return { rows: all };
  };

  if (!state.transactional) return { query };

  return {
    query,
    async begin() {
      state.begins += 1;
      state.log.push('BEGIN');
      state.snapshot = JSON.parse(JSON.stringify(state.rows));
    },
    async commit() {
      state.commits += 1;
      state.log.push('COMMIT');
      state.snapshot = null;
    },
    async rollback() {
      state.rollbacks += 1;
      state.log.push('ROLLBACK');
      if (state.rollbackFails) throw new Error('connection lost');
      state.rows = state.snapshot ?? state.rows;
      state.snapshot = null;
    },
  };
}

type Authorizer = (request: { jobId: string; payload: RetentionSweepPayload }) => boolean | Promise<boolean>;

function workerWith(db: RetentionDatabase, authorizeApply?: Authorizer): JobWorker {
  const worker = new JobWorker({ store: new MemoryJobStore(), workerId: 'test-retention-431' });
  registerRetentionJob(worker, { db, authorizeApply });
  return worker;
}

/** Invokes the registered sweep handler the way the worker does. */
function invoke(worker: JobWorker, data: Record<string, unknown>, jobId = 'job-431'): Promise<any> {
  const handler = (worker as any).handlers.get(RETENTION_SWEEP_JOB);
  return handler({ version: 1, data }, { job: { id: jobId } });
}

describe('Apply path — normal', () => {
  it('deletes the planned batches inside one transaction and verifies them', async () => {
    const state = seed();
    const { result } = await runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false });

    assert.equal(result.deleted, 3);
    assert.equal(result.deletionVerified, true);
    assert.deepEqual(result.verifiedTables, ['invoices', 'payment_events']);
    assert.deepEqual(state.rows.invoices.map((r) => r.id).sort(), ['i-paid', 'i-recent']);
    assert.deepEqual(state.rows.payment_events, []);

    assert.equal(state.begins, 1);
    assert.equal(state.commits, 1);
    assert.equal(state.rollbacks, 0);

    const begin = state.log.indexOf('BEGIN');
    const firstDelete = state.log.findIndex((l) => /DELETE/i.test(l));
    const commit = state.log.indexOf('COMMIT');
    assert.ok(begin >= 0 && begin < firstDelete, 'the transaction opens before the first DELETE');
    assert.ok(firstDelete < commit, 'COMMIT comes after the deletes and their checks');
  });

  it('a dry run opens no transaction and claims no verification', async () => {
    const state = seed();
    const { result } = await runRetentionSweep(fakeDb(state), { now: NOW });

    assert.equal(result.dryRun, true);
    assert.equal(result.deletionVerified, false);
    assert.deepEqual(result.verifiedTables, []);
    assert.equal(state.begins, 0);
    assert.equal(state.rows.invoices.length, 4);
  });

  it('with batchSize 1, deletes one row per table and still verifies that batch', async () => {
    const state = seed();
    const { result } = await runRetentionSweep(fakeDb(state), {
      now: NOW,
      dryRun: false,
      batchSize: 1,
    });

    assert.equal(result.deleted, 2, 'one invoice and one payment event');
    assert.equal(result.deletionVerified, true);
    assert.equal(state.rows.invoices.length, 3, 'the second eligible invoice is left for the next run');
  });
});

describe('Apply path — failure and rollback', () => {
  it('a failure part-way rolls back every earlier table', async () => {
    const state = seed({ failDeleteOn: 'payment_events' });

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false }),
      /deadlock detected on payment_events/
    );

    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
    assert.equal(state.rows.invoices.length, 4, 'the invoice delete from the first table must be undone');
    assert.equal(state.rows.payment_events.length, 1);
  });

  it('a DELETE reporting the wrong count is a verification failure and rolls back', async () => {
    const state = seed({ zeroCountOn: 'invoices' });

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof RetentionVerificationError);
        assert.match(error.message, /planned 2 row\(s\), database reported 0 deleted/);
        return true;
      }
    );

    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
    assert.equal(state.rows.invoices.length, 4);
  });

  it('rows that survive a DELETE are caught by the follow-up check and rolled back', async () => {
    const state = seed({ ghostOn: 'payment_events' });

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof RetentionVerificationError);
        assert.match(error.message, /still present after DELETE/);
        return true;
      }
    );

    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
    assert.equal(state.rows.payment_events.length, 1, 'the surviving event was never made durable as deleted');
    assert.equal(state.rows.invoices.length, 4, 'and the invoice batch was undone with it');
  });

  it('a failed rollback is reported as needing manual inspection', async () => {
    const state = seed({ failDeleteOn: 'payment_events', rollbackFails: true });

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof RetentionVerificationError);
        assert.match(error.message, /rollback failed[\s\S]*manual inspection/);
        return true;
      }
    );
  });

  it('without transaction support, a failure leaves earlier tables deleted (documented limitation)', async () => {
    const state = seed({ transactional: false, failDeleteOn: 'payment_events' });

    await assert.rejects(
      () => runRetentionSweep(fakeDb(state), { now: NOW, dryRun: false }),
      /no transaction support/
    );

    assert.equal(state.rows.invoices.length, 2, 'the invoices were already deleted and cannot be restored here');
  });

  it('a verification mismatch surfaces through the job as a non-retryable failure', async () => {
    const state = seed({ zeroCountOn: 'invoices' });
    const worker = workerWith(fakeDb(state));

    await assert.rejects(
      () => invoke(worker, { dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableJobError);
        assert.match((error as Error).message, /planned 2 row\(s\)/);
        return true;
      }
    );
    assert.equal(state.rows.invoices.length, 4);
  });
});

describe('Apply path — retry', () => {
  it('after a rolled-back sweep, re-running the apply completes exactly once', async () => {
    const state = seed({ failDeleteOn: 'payment_events' });
    const db = fakeDb(state);

    await assert.rejects(() => runRetentionSweep(db, { now: NOW, dryRun: false }));

    state.failDeleteOn = undefined;
    const first = await runRetentionSweep(db, { now: NOW, dryRun: false });
    assert.equal(first.result.deleted, 3);
    assert.equal(first.result.deletionVerified, true);

    const second = await runRetentionSweep(db, { now: NOW, dryRun: false });
    assert.equal(second.result.eligible, 0);
    assert.equal(second.result.deleted, 0);
    assert.equal(second.result.deletionVerified, true);
    assert.deepEqual(state.rows.invoices.map((r) => r.id).sort(), ['i-paid', 'i-recent']);
  });

  it('the worker does not retry a rolled-back failure on its own', async () => {
    const state = seed({ failDeleteOn: 'payment_events' });
    const worker = workerWith(fakeDb(state));

    await assert.rejects(
      () => invoke(worker, { dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableJobError);
        assert.match((error as Error).message, /deadlock detected/);
        return true;
      }
    );
    assert.equal(state.rows.invoices.length, 4, 'nothing from the failed attempt was kept');
  });
});

describe('Apply path — authorization', () => {
  it('an unauthorized apply is refused before any query runs', async () => {
    const state = seed();
    let seen: unknown = null;
    const worker = workerWith(fakeDb(state), (request) => {
      seen = request;
      return false;
    });

    await assert.rejects(
      () => invoke(worker, { dryRun: false }, 'job-abc'),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableJobError);
        assert.match((error as Error).message, /not authorized/);
        return true;
      }
    );

    assert.equal(state.log.length, 0, 'no read or write may happen for a refused apply');
    assert.deepEqual(seen, { jobId: 'job-abc', payload: { dryRun: false } });
  });

  it('an authorizer that throws counts as a refusal', async () => {
    const state = seed();
    const worker = workerWith(fakeDb(state), async () => {
      throw new Error('policy service unavailable');
    });

    await assert.rejects(
      () => invoke(worker, { dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableJobError);
        assert.match((error as Error).message, /not authorized/);
        return true;
      }
    );
    assert.equal(state.log.length, 0);
  });

  it('only a literal true authorizes an apply', async () => {
    const state = seed();
    const worker = workerWith(fakeDb(state), (() => 'yes') as unknown as Authorizer);

    await assert.rejects(() => invoke(worker, { dryRun: false }), /not authorized/);
    assert.equal(state.log.length, 0);
  });

  it('dry runs are never gated', async () => {
    const state = seed();
    let calls = 0;
    const worker = workerWith(fakeDb(state), () => {
      calls += 1;
      return false;
    });

    const result = await invoke(worker, {});

    assert.equal(result.dryRun, true);
    assert.equal(result.deleted, 0);
    assert.equal(calls, 0, 'the authorizer is not consulted for a dry run');
  });

  it('an authorized apply proceeds and is verified', async () => {
    const state = seed();
    const worker = workerWith(fakeDb(state), () => true);

    const result = await invoke(worker, { dryRun: false });

    assert.equal(result.deleted, 3);
    assert.equal(result.deletionVerified, true);
  });

  it('with no authorizer configured, the payload alone opts in (existing contract)', async () => {
    const state = seed();
    const worker = workerWith(fakeDb(state));

    const result = await invoke(worker, { dryRun: false });

    assert.equal(result.deleted, 3);
  });
});
