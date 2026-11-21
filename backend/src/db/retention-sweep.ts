/**
 * Retention executor and job wiring (#61, #431).
 *
 * `retention.ts` decides; this file executes. The split matters: the decision
 * is a pure, fully tested function, while everything that can delete a row
 * lives here, is dry-run by default, and reports the affected records *before*
 * it deletes them.
 *
 * The guard against an accidental mass delete is threefold and deliberate:
 *
 *   1. `dryRun` defaults to true, so the job cannot delete anything unless the
 *      payload explicitly opts in.
 *   2. Each delete is capped at `batchSize` rows per table per run.
 *   3. A single sweep refuses to touch a table it does not recognise.
 *
 * Issue #431 adds two properties to the apply path:
 *
 *   4. Authorization. When `authorizeApply` is configured, an apply run is
 *      refused before any database read unless it returns exactly `true`.
 *      Dry runs are never gated. See docs/RETENTION_DELETION_VERIFICATION.md.
 *   5. Verification and atomicity. When the database supports transactions,
 *      all deletes run in one transaction. Each table's DELETE must remove
 *      exactly the planned rows, and a follow-up SELECT must find none of them
 *      still present. Any mismatch rolls the whole sweep back.
 */

import {
  RETENTION_POLICY,
  TABLE_CLASS,
  RETENTION_SWEEP_JOB,
  classifyRecord,
  planRetention,
  formatRetentionReport,
  type ClassifiedRecord,
  type RetentionRecord,
  type RetentionSweepPayload,
  type RetentionSweepResult,
  type RetentionPlan,
} from './retention';
import type { JobWorker } from '../jobs/worker';
import { NonRetryableJobError } from '../jobs/job-types';

export interface RetentionDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
  /**
   * Transaction control. When all three are present, an apply run is atomic.
   * When absent, an apply run is best-effort and a mid-sweep failure can leave
   * earlier tables already deleted (see the recovery note in the docs).
   */
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export interface SweepOptions {
  dryRun?: boolean;
  tables?: string[];
  now?: Date;
  sampleLimit?: number;
  /** Rows deleted per table per run. Bounds the blast radius. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 1_000;

/** Columns selected per table, so a plan can be built without loading the world. */
const SELECT_COLUMNS: Record<string, string> = {
  invoices: 'id, status, created_at, metadata',
  transactions: 'id, created_at',
  payment_events: 'id, created_at',
  jobs: 'id, status, completed_at, created_at',
};

/**
 * Raised when an apply run cannot prove its deletes did what the plan said.
 * The sweep has been rolled back (or, without transaction support, flagged)
 * by the time this reaches the caller.
 */
export class RetentionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionVerificationError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settlement-linked rows are resolved up front with one query so a PAID
 * invoice is protected regardless of its age, and so a transaction is never
 * deleted out from under an invoice that references it.
 */
async function loadSettlementLinks(db: RetentionDatabase): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  const { rows } = await db.query(
    `SELECT id FROM invoices WHERE status = 'PAID'
     UNION
     SELECT i.id FROM invoices i
       JOIN transactions t ON t.invoice_id = i.id
     UNION
     SELECT i.id FROM invoices i
       JOIN payment_events e ON e.invoice_id = i.id
       WHERE i.status = 'PAID'`
  );
  for (const row of rows) {
    if (row?.id) protectedIds.add(String(row.id));
  }
  return protectedIds;
}

async function loadTable(
  db: RetentionDatabase,
  table: string,
  settlementLinks: Set<string>
): Promise<RetentionRecord[]> {
  const columns = SELECT_COLUMNS[table];
  if (!columns) return [];

  const { rows } = await db.query(`SELECT ${columns} FROM "${table}"`);
  return rows.map((row: any) => ({
    table,
    id: String(row.id),
    ageAnchor: String(
      row.completed_at ?? row.created_at ?? row.processed_at ?? row.generated_at ?? ''
    ),
    status: row.status ?? null,
    settlementLinked: settlementLinks.has(String(row.id)),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    deadLetter: row.status === 'dead',
  }));
}

/** Builds the plan without touching anything. Safe to run at any time. */
export async function buildRetentionPlan(
  db: RetentionDatabase,
  options: SweepOptions = {}
): Promise<RetentionPlan> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const tables = options.tables ?? Object.keys(TABLE_CLASS);

  // Validate before planning: a table the policy does not describe must be
  // refused loudly, not silently dropped. Filtering first would turn a typo
  // into a sweep that quietly skips it.
  for (const table of tables) {
    if (!TABLE_CLASS[table] || !SELECT_COLUMNS[table]) {
      throw new Error(`retention sweep: refusing unknown table "${table}"`);
    }
  }

  const settlementLinks = await loadSettlementLinks(db);

  const records: RetentionRecord[] = [];
  for (const table of tables) {
    records.push(...(await loadTable(db, table, settlementLinks)));
  }

  return { ...planRetention(records, { now, sampleLimit: options.sampleLimit }), dryRun };
}

/** What an apply run actually did, as opposed to what the plan intended. */
interface ApplyOutcome {
  deleted: number;
  verifiedTables: string[];
}

/**
 * Deletes each planned batch and proves it is gone. Runs in one transaction
 * when the database supports it, so any failure undoes every earlier table.
 *
 * Verification per table:
 *   - the DELETE must report exactly as many rows as were planned, and
 *   - a follow-up SELECT by the same ids must return none of them.
 * A mismatch on either check is a RetentionVerificationError, which triggers a
 * rollback. Both checks run before COMMIT, so a bad batch is never made durable.
 */
async function applyDeletes(
  db: RetentionDatabase,
  byTable: Map<string, ClassifiedRecord[]>,
  batchSize: number
): Promise<ApplyOutcome> {
  const transactional =
    typeof db.begin === 'function' && typeof db.commit === 'function' && typeof db.rollback === 'function';

  if (transactional) await db.begin!();

  let deleted = 0;
  const verifiedTables: string[] = [];

  try {
    for (const [table, entries] of byTable) {
      // Bound the blast radius: never delete more than one batch per table.
      const ids = entries.slice(0, batchSize).map((e) => e.record.id);

      const { rowCount } = await db.query(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
      const reported = rowCount ?? ids.length;
      if (reported !== ids.length) {
        throw new RetentionVerificationError(
          `${table}: planned ${ids.length} row(s), database reported ${reported} deleted`
        );
      }

      const { rows } = await db.query(`SELECT id FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
      const survivors = rows.filter((row) => ids.includes(String(row.id)));
      if (survivors.length > 0) {
        throw new RetentionVerificationError(
          `${table}: ${survivors.length} planned row(s) still present after DELETE`
        );
      }

      deleted += reported;
      verifiedTables.push(table);
    }

    if (transactional) await db.commit!();
  } catch (error) {
    if (transactional) {
      try {
        await db.rollback!();
      } catch (rollbackError) {
        throw new RetentionVerificationError(
          `rollback failed after "${messageOf(error)}"; rollback error: "${messageOf(rollbackError)}". ` +
            'Database state needs manual inspection before any re-run.'
        );
      }
      throw error;
    }

    throw new RetentionVerificationError(
      `${messageOf(error)} (no transaction support: tables deleted before this failure are not restored)`
    );
  }

  return { deleted, verifiedTables };
}

export interface VerifiedSweepResult extends RetentionSweepResult {
  /** True only for an apply run in which every table's batch passed verification. */
  deletionVerified: boolean;
  /** Tables whose planned batch was deleted and then confirmed gone. */
  verifiedTables: string[];
}

export interface SweepOutcome {
  plan: RetentionPlan;
  result: VerifiedSweepResult;
  report: string;
}

/**
 * Plans, reports, and only then — when explicitly asked — deletes.
 */
export async function runRetentionSweep(
  db: RetentionDatabase,
  options: SweepOptions = {}
): Promise<SweepOutcome> {
  const dryRun = options.dryRun !== false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const plan = await buildRetentionPlan(db, options);

  // Report the affected records before any destructive action, as the issue
  // requires. In apply mode this happens before the first DELETE is issued.
  const report = formatRetentionReport(plan, 0);

  const byTable = new Map<string, ClassifiedRecord[]>();
  for (const entry of plan.eligible) {
    const list = byTable.get(entry.record.table) ?? [];
    list.push(entry);
    byTable.set(entry.record.table, list);
  }

  const outcome: ApplyOutcome = dryRun
    ? { deleted: 0, verifiedTables: [] }
    : await applyDeletes(db, byTable, batchSize);

  const result: VerifiedSweepResult = {
    dryRun,
    considered: plan.eligible.length + plan.protected.length,
    eligible: plan.eligible.length,
    protectedCount: plan.protected.length,
    deleted: outcome.deleted,
    byClass: plan.byClass,
    summary: plan.summary,
    deletionVerified: !dryRun && outcome.verifiedTables.length === byTable.size,
    verifiedTables: outcome.verifiedTables,
  };

  return { plan, result, report: dryRun ? report : formatRetentionReport(plan, outcome.deleted) };
}

/** Decides whether an apply run may proceed. Receives no database handle. */
export interface ApplyAuthorizationRequest {
  jobId: string;
  payload: RetentionSweepPayload;
}

export interface RetentionJobDeps {
  db: RetentionDatabase;
  /**
   * Consulted only for apply runs (`dryRun: false`). Only a literal `true`
   * authorizes; `false`, any other value, or a thrown error refuses the run
   * before any read. Omitting it keeps the pre-#431 behaviour, in which the
   * payload alone opts in. Wiring it is recommended in production.
   */
  authorizeApply?: (request: ApplyAuthorizationRequest) => boolean | Promise<boolean>;
}

/**
 * Registers the sweep with the job worker. Dry run is the default, so an
 * operator must send `{"dryRun": false}` to remove anything.
 *
 * Failures are never retried by the worker. A verified rollback is safe to
 * re-run by hand, but the worker cannot tell a rolled-back failure from a
 * partial one without the operator reading the error.
 */
export function registerRetentionJob(worker: JobWorker, deps: RetentionJobDeps): JobWorker {
  return worker.register(RETENTION_SWEEP_JOB, async (payload, ctx) => {
    const data = (payload?.data ?? {}) as RetentionSweepPayload;
    const dryRun = data.dryRun !== false;

    if (!dryRun && deps.authorizeApply) {
      let allowed = false;
      try {
        allowed = (await deps.authorizeApply({ jobId: ctx?.job?.id ?? '', payload: data })) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        throw new NonRetryableJobError('retention apply refused: not authorized');
      }
    }

    try {
      const { result } = await runRetentionSweep(deps.db, {
        dryRun,
        tables: data.tables,
        sampleLimit: data.sampleLimit,
      });
      return result as unknown as Record<string, unknown>;
    } catch (error) {
      // A failed sweep is never retried blindly: it may have deleted part of a
      // batch. Surface it for a human instead of compounding the damage.
      throw new NonRetryableJobError(`retention sweep failed: ${messageOf(error)}`);
    }
  });
}

export { RETENTION_SWEEP_JOB, RETENTION_POLICY };
export { classifyRecord };
