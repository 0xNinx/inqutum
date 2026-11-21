/**
 * Retention enforcement for sensitive metadata (#359).
 *
 * These tests pin the boundary between row retention and field-level
 * minimization: an old invoice may be deleted as a row, but its IP address,
 * user agent and request ids are removed on their own shorter windows even
 * while the row is protected. Holds and settlement links are authorization
 * inputs, not age inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  METADATA_MINIMIZATION_JOB,
  registerMetadataMinimizationJob,
  reviewMetadata,
  runMetadataMinimization,
  type MetadataDatabase,
} from '../src/db/metadata-minimization';
import { runRetentionSweep, type RetentionDatabase } from '../src/db/retention-sweep';
import { JobQueue, JobWorker } from '../src/jobs/worker';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { DEFAULT_RETRY_POLICY } from '../src/jobs/job-types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

interface MetadataRow {
  id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function metadataDb(
  rows: MetadataRow[],
  options: { failSelects?: number; failUpdates?: number } = {}
) {
  const table = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  let selects = 0;
  let updates = 0;
  const log: string[] = [];

  const db: MetadataDatabase = {
    async query(text, params = []) {
      const sql = text.trim();
      if (sql.startsWith('SELECT')) {
        selects += 1;
        if (selects <= (options.failSelects ?? 0)) throw new Error('connection reset');
        log.push('select');
        const [afterId, limit] = params as [string, number];
        const page = [...table.values()]
          .filter((row) => row.metadata && Object.keys(row.metadata).length > 0 && row.id > afterId)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit);
        return { rows: structuredClone(page) };
      }
      if (sql.startsWith('UPDATE')) {
        updates += 1;
        if (updates <= (options.failUpdates ?? 0)) throw new Error('write failed');
        log.push('update');
        const [id, next, expected] = params as [string, string, string];
        const row = table.get(id);
        if (!row || JSON.stringify(row.metadata) !== expected) return { rows: [], rowCount: 0 };
        row.metadata = JSON.parse(next);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  return { db, table, log };
}

interface RetentionRow {
  id: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function retentionDb(rows: RetentionRow[], settlementLinkedIds: string[]) {
  const table = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  const deleted: string[] = [];
  const db: RetentionDatabase = {
    async query(text, params = []) {
      const sql = text.trim();
      if (sql.includes("status = 'PAID'")) {
        return { rows: settlementLinkedIds.map((id) => ({ id })) };
      }
      if (sql.startsWith('DELETE')) {
        const ids = (params[0] as string[]) ?? [];
        for (const id of ids) {
          if (table.delete(id)) deleted.push(id);
        }
        return { rows: [], rowCount: ids.length };
      }
      if (sql.startsWith('SELECT')) {
        return { rows: structuredClone([...table.values()]) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, table, deleted };
}

describe('Sensitive metadata retention enforcement (#359)', () => {
  describe('normal path', () => {
    it('removes network identifiers after 30 days and operational fields after 90 days, while keeping business references', async () => {
      const { db, table, log } = metadataDb([
        {
          id: uuid(1),
          created_at: daysAgo(100),
          metadata: {
            ip: '203.0.113.9',
            user_agent: 'curl/8.0',
            request_id: 'req-1',
            order: 'A-1',
          },
        },
      ]);

      const dry = await runMetadataMinimization(db, { now: NOW });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.changed, 1);
      assert.equal(dry.updated, 0);
      assert.deepEqual(dry.removedByCategory, { network_identifier: 2, operational: 1 });
      assert.ok(!log.includes('update'), 'dry run must not write');
      assert.deepEqual(table.get(uuid(1))!.metadata, {
        ip: '203.0.113.9',
        user_agent: 'curl/8.0',
        request_id: 'req-1',
        order: 'A-1',
      });

      const applied = await runMetadataMinimization(db, { now: NOW, dryRun: false });
      assert.equal(applied.updated, 1);
      assert.deepEqual(table.get(uuid(1))!.metadata, { order: 'A-1' });
    });

    it('uses the exact 30-day boundary for network identifiers', () => {
      const metadata = { ip: '203.0.113.9', order: 'A-1' };
      const at29 = reviewMetadata({ id: 'a', createdAt: daysAgo(29), metadata }, NOW);
      const at30 = reviewMetadata({ id: 'a', createdAt: daysAgo(30), metadata }, NOW);

      assert.equal(at29.changed, false);
      assert.equal(at30.changed, true);
      assert.deepEqual(at30.next, { order: 'A-1' });
    });
  });

  describe('failure path', () => {
    it('does not guess an age when created_at is invalid, but still removes prohibited credentials', async () => {
      const { db, table } = metadataDb([
        {
          id: uuid(1),
          created_at: 'not-a-date',
          metadata: { ip: '203.0.113.9', password: 'p', order: 'A-1' },
        },
      ]);

      const result = await runMetadataMinimization(db, { now: NOW, dryRun: false });

      assert.equal(result.updated, 1);
      assert.deepEqual(table.get(uuid(1))!.metadata, { ip: '203.0.113.9', order: 'A-1' });
      assert.deepEqual(result.removedByCategory, { prohibited: 1 });
    });

    it('leaves the row untouched when a write fails, and a later run converges', async () => {
      const { db, table } = metadataDb(
        [
          {
            id: uuid(1),
            created_at: daysAgo(100),
            metadata: { ip: '203.0.113.9', order: 'A-1' },
          },
        ],
        { failUpdates: 1 }
      );

      await assert.rejects(
        () => runMetadataMinimization(db, { now: NOW, dryRun: false }),
        /write failed/
      );
      assert.deepEqual(table.get(uuid(1))!.metadata, { ip: '203.0.113.9', order: 'A-1' });

      const retry = await runMetadataMinimization(db, { now: NOW, dryRun: false });
      assert.equal(retry.updated, 1);
      assert.deepEqual(table.get(uuid(1))!.metadata, { order: 'A-1' });
    });
  });

  describe('retry path', () => {
    it('retries a transient read failure through the job worker and succeeds on the next attempt', async () => {
      const { db, table } = metadataDb(
        [
          {
            id: uuid(1),
            created_at: daysAgo(100),
            metadata: { ip: '203.0.113.9', order: 'A-1' },
          },
        ],
        { failSelects: 1 }
      );
      const store = new MemoryJobStore();
      let now = new Date(NOW);
      const worker = new JobWorker({
        store,
        workerId: 'metadata-retry-test',
        now: () => now,
        log: () => {},
      });
      registerMetadataMinimizationJob(worker, { db });
      const queue = new JobQueue(store, DEFAULT_RETRY_POLICY, () => now);
      const { job } = await queue.enqueue(METADATA_MINIMIZATION_JOB, { dryRun: false });

      const first = await worker.runOnce();
      assert.equal(first?.status, 'queued');
      assert.match(first?.errors[0]?.message ?? '', /connection reset/);
      assert.deepEqual(table.get(uuid(1))!.metadata, { ip: '203.0.113.9', order: 'A-1' });

      now = new Date(now.getTime() + 2_000);
      const second = await worker.runOnce();
      assert.equal(second?.id, job.id);
      assert.equal(second?.status, 'succeeded');
      assert.equal(second?.attempts, 2);
      assert.deepEqual(table.get(uuid(1))!.metadata, { order: 'A-1' });
    });
  });

  describe('authorization path', () => {
    it('a legal hold blocks minimization and escalates prohibited data instead of deleting it', async () => {
      const { db, table } = metadataDb([
        {
          id: uuid(1),
          created_at: daysAgo(400),
          metadata: { under_dispute: true, ip: '203.0.113.9', password: 'p' },
        },
      ]);

      const result = await runMetadataMinimization(db, { now: NOW, dryRun: false });

      assert.equal(result.updated, 0);
      assert.equal(result.held, 1);
      assert.deepEqual(result.escalations, [{ id: uuid(1), paths: ['password'] }]);
      assert.deepEqual(table.get(uuid(1))!.metadata, {
        under_dispute: true,
        ip: '203.0.113.9',
        password: 'p',
      });
    });

    it('settlement protects the row from deletion but not its sensitive metadata fields', async () => {
      const row = {
        id: 'i-paid',
        status: 'PAID',
        created_at: daysAgo(900),
        metadata: { ip: '203.0.113.9', order: 'A-1' },
      };
      const retention = retentionDb([row], ['i-paid']);

      const sweep = await runRetentionSweep(retention.db, { now: NOW, dryRun: false });
      assert.equal(sweep.result.deleted, 0);
      assert.equal(retention.table.has('i-paid'), true);

      const metadata = metadataDb([{ ...row, id: uuid(7) }]);
      const minimized = await runMetadataMinimization(metadata.db, { now: NOW, dryRun: false });
      assert.equal(minimized.updated, 1);
      assert.deepEqual(metadata.table.get(uuid(7))!.metadata, { order: 'A-1' });
    });
  });
});
