/**
 * Reconciliation job: source-of-truth storage vs derived projections (#255).
 *
 * Invoice storage (Postgres or memory) is the source of truth. The search index
 * is a derived projection that can drift: it lives in process memory, is
 * written on a different code path from storage, and is not rebuilt after a
 * restore or an out-of-band SQL change. The job:
 *
 *  1. Detects drift record by record and classifies it.
 *  2. Reports each drift with a root-cause hint and, when an audit lookup is
 *     available, the audit evidence behind the hint.
 *  3. Repairs only through a dry-run-first workflow:
 *       plan()  -> read-only; returns a report and a single-use planId
 *       apply() -> re-detects, refuses if the drift no longer matches the
 *                  reviewed plan (PLAN_STALE), snapshots the projection,
 *                  applies the planned actions, then verifies
 *       rollback() -> restores the pre-apply snapshot of the last apply
 *
 * Invariants:
 *  - Storage is never written. Every repair action targets the projection.
 *  - plan() has no side effects on storage or projection (it only reads).
 *  - apply() executes exactly the reviewed actions or nothing: a changed drift
 *    set, an expired plan or a reused plan is refused before any write.
 *  - Drift that heals itself (an overdue PENDING row awaiting lazy expiry) is
 *    reported but never "repaired" backwards.
 *  - One reconciliation at a time per service instance.
 *
 * See docs/RECONCILIATION.md for the runbook.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditEvent } from '../audit/audit-service';
import type { InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';
import {
  PermissionAwareSearchIndex,
  defaultSearchIndex,
  type IndexedInvoiceRecord,
} from '../services/search-index.service';

export type DriftKind =
  | 'MISSING_IN_PROJECTION'
  | 'ORPHANED_IN_PROJECTION'
  | 'TOMBSTONED_IN_PROJECTION'
  | 'STATUS_DRIFT'
  | 'IMMUTABLE_FIELD_DRIFT';

export type DriftSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type RootCause =
  | 'CREATED_OUTSIDE_API'
  | 'INDEX_WRITE_LOST'
  | 'STORAGE_ROW_REMOVED'
  | 'PAYMENT_NOT_PROJECTED'
  | 'CANCELLATION_NOT_PROJECTED'
  | 'EXPIRY_NOT_PROJECTED'
  | 'PROJECTION_AHEAD_OF_STORAGE'
  | 'AWAITING_LAZY_EXPIRY'
  | 'OUT_OF_BAND_STORAGE_EDIT'
  | 'SOFT_DELETED_WHILE_LIVE'
  | 'UNKNOWN';

export type RepairActionType = 'INDEX_FROM_STORAGE' | 'PURGE_FROM_PROJECTION' | 'NONE';

export interface DriftItem {
  entityId: string;
  projection: 'search_index';
  kind: DriftKind;
  severity: DriftSeverity;
  fields: string[];
  storage: Pick<StoredInvoice, 'status' | 'amount' | 'assetCode' | 'sellerPublicKey' | 'memo'> | null;
  projected: Pick<IndexedInvoiceRecord, 'status' | 'amount' | 'assetCode' | 'sellerPublicKey' | 'memo' | 'isDeleted'> | null;
  rootCause: { code: RootCause; hint: string; evidence: string[] };
  action: RepairActionType;
}

export interface ReconciliationSummary {
  storageRecords: number;
  projectedRecords: number;
  drifts: number;
  repairable: number;
  bySeverity: Record<DriftSeverity, number>;
  byKind: Record<DriftKind, number>;
}

export interface ReconciliationPlan {
  planId: string;
  generatedAt: string;
  expiresAt: string;
  healthy: boolean;
  /** Hash of the planned actions. apply() refuses when the live drift hashes differently. */
  fingerprint: string;
  summary: ReconciliationSummary;
  drifts: DriftItem[];
}

export interface ReconciliationApplyResult {
  runId: string;
  planId: string;
  appliedAt: string;
  appliedBy: string;
  applied: Array<{ entityId: string; action: RepairActionType }>;
  failed: Array<{ entityId: string; action: RepairActionType; error: string }>;
  verification: { clean: boolean; remainingDrifts: DriftItem[] };
  rollbackAvailable: boolean;
}

export type ReconciliationErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'PLAN_EXPIRED'
  | 'PLAN_ALREADY_APPLIED'
  | 'PLAN_STALE'
  | 'RECONCILIATION_IN_PROGRESS'
  | 'NOTHING_TO_ROLL_BACK'
  | 'STORAGE_SCAN_UNSUPPORTED';

const HTTP_STATUS: Record<ReconciliationErrorCode, number> = {
  PLAN_NOT_FOUND: 404,
  PLAN_EXPIRED: 410,
  PLAN_ALREADY_APPLIED: 409,
  PLAN_STALE: 409,
  RECONCILIATION_IN_PROGRESS: 409,
  NOTHING_TO_ROLL_BACK: 409,
  STORAGE_SCAN_UNSUPPORTED: 501,
};

export class ReconciliationError extends Error {
  readonly httpStatus: number;

  constructor(public readonly code: ReconciliationErrorCode, message: string, public readonly plan?: ReconciliationPlan) {
    super(message);
    this.name = 'ReconciliationError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface ReconciliationServiceOptions {
  storage: InvoiceStorage;
  index?: PermissionAwareSearchIndex;
  /** Audit events for one invoice, used to back root-cause hints with evidence. */
  auditLookup?: (invoiceId: string) => Promise<AuditEvent[]>;
  now?: () => Date;
  /** How long a reviewed plan stays applicable. Default 15 minutes. */
  planTtlMs?: number;
  /** Plans kept for apply; oldest evicted first. Default 20. */
  maxPlans?: number;
}

const CRITICAL_FIELDS = new Set(['amount', 'sellerPublicKey', 'assetCode']);
const IMMUTABLE_FIELDS = ['amount', 'assetCode', 'sellerPublicKey', 'memo'] as const;

export class ReconciliationService {
  private readonly index: PermissionAwareSearchIndex;
  private readonly now: () => Date;
  private readonly planTtlMs: number;
  private readonly maxPlans: number;
  private readonly plans = new Map<string, { plan: ReconciliationPlan; applied: boolean }>();
  private lastApply: { runId: string; snapshot: IndexedInvoiceRecord[] } | null = null;
  private lastCounts = { storage: 0, projected: 0 };
  private running = false;

  constructor(private readonly options: ReconciliationServiceOptions) {
    this.index = options.index ?? defaultSearchIndex;
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? 15 * 60_000;
    this.maxPlans = options.maxPlans ?? 20;
  }

  /** Read-only. Detects drift and stores a single-use plan for apply(). O(S + P). */
  async plan(): Promise<ReconciliationPlan> {
    return this.exclusive(async () => {
      const drifts = await this.detect();
      const generatedAt = this.now();
      const plan: ReconciliationPlan = {
        planId: randomUUID(),
        generatedAt: generatedAt.toISOString(),
        expiresAt: new Date(generatedAt.getTime() + this.planTtlMs).toISOString(),
        healthy: drifts.length === 0,
        fingerprint: fingerprint(drifts),
        summary: summarize(drifts, this.lastCounts),
        drifts,
      };
      this.plans.set(plan.planId, { plan, applied: false });
      while (this.plans.size > this.maxPlans) this.plans.delete(this.plans.keys().next().value as string);
      return plan;
    });
  }

  /**
   * Applies a reviewed plan. Refuses before any write when the plan is
   * unknown, expired, already used, or no longer matches live drift.
   */
  async apply(planId: string, actorId: string): Promise<ReconciliationApplyResult> {
    return this.exclusive(async () => {
      const entry = this.plans.get(planId);
      if (!entry) throw new ReconciliationError('PLAN_NOT_FOUND', `Unknown plan ${planId}; run a dry run first`);
      if (entry.applied) throw new ReconciliationError('PLAN_ALREADY_APPLIED', `Plan ${planId} was already applied; run a new dry run`);
      if (this.now().getTime() > Date.parse(entry.plan.expiresAt)) {
        throw new ReconciliationError('PLAN_EXPIRED', `Plan ${planId} expired at ${entry.plan.expiresAt}; run a new dry run`);
      }

      const live = await this.detect();
      if (fingerprint(live) !== entry.plan.fingerprint) {
        const fresh: ReconciliationPlan = {
          ...entry.plan,
          planId: randomUUID(),
          generatedAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + this.planTtlMs).toISOString(),
          healthy: live.length === 0,
          fingerprint: fingerprint(live),
          summary: summarize(live, this.lastCounts),
          drifts: live,
        };
        this.plans.set(fresh.planId, { plan: fresh, applied: false });
        throw new ReconciliationError('PLAN_STALE', 'Drift changed since the dry run; review the new plan before applying', fresh);
      }

      entry.applied = true;
      const runId = randomUUID();
      const snapshot = this.index.exportRecords();
      const truth = new Map((await this.scanStorage()).map((inv) => [inv.id, inv]));
      const applied: ReconciliationApplyResult['applied'] = [];
      const failed: ReconciliationApplyResult['failed'] = [];

      for (const drift of entry.plan.drifts) {
        if (drift.action === 'NONE') continue;
        try {
          if (drift.action === 'PURGE_FROM_PROJECTION') {
            this.index.purge(drift.entityId);
          } else {
            const source = truth.get(drift.entityId);
            if (!source) throw new Error('Invoice disappeared from storage during apply');
            this.index.indexInvoice(source);
          }
          applied.push({ entityId: drift.entityId, action: drift.action });
        } catch (err) {
          failed.push({ entityId: drift.entityId, action: drift.action, error: err instanceof Error ? err.message : String(err) });
        }
      }

      this.lastApply = { runId, snapshot };
      const remaining = (await this.detect()).filter((d) => d.action !== 'NONE');
      return {
        runId,
        planId,
        appliedAt: this.now().toISOString(),
        appliedBy: actorId,
        applied,
        failed,
        verification: { clean: remaining.length === 0, remainingDrifts: remaining },
        rollbackAvailable: true,
      };
    });
  }

  /** Restores the projection exactly as it was before the last apply. Storage is untouched. */
  rollback(): { runId: string; restoredRecords: number } {
    if (this.running) throw new ReconciliationError('RECONCILIATION_IN_PROGRESS', 'A reconciliation is running; retry when it finishes');
    if (!this.lastApply) throw new ReconciliationError('NOTHING_TO_ROLL_BACK', 'No applied reconciliation to roll back');
    const { runId, snapshot } = this.lastApply;
    this.index.replaceAll(snapshot);
    this.lastApply = null;
    return { runId, restoredRecords: snapshot.length };
  }

  /** Summary for the scheduled job: detect only, never repair. */
  async scheduledCheck(): Promise<{ healthy: boolean; summary: ReconciliationSummary; critical: string[] }> {
    const plan = await this.plan();
    return {
      healthy: plan.healthy,
      summary: plan.summary,
      critical: plan.drifts.filter((d) => d.severity === 'CRITICAL').map((d) => `${d.entityId}:${d.rootCause.code}`),
    };
  }

  private async scanStorage(): Promise<StoredInvoice[]> {
    if (!this.options.storage.getAllInvoices) {
      throw new ReconciliationError('STORAGE_SCAN_UNSUPPORTED', `Storage "${this.options.storage.mode}" cannot list all invoices`);
    }
    return this.options.storage.getAllInvoices();
  }

  private async detect(): Promise<DriftItem[]> {
    const invoices = await this.scanStorage();
    const records = this.index.exportRecords();
    this.lastCounts = { storage: invoices.length, projected: records.length };
    const truth = new Map(invoices.map((inv) => [inv.id, inv]));
    const projected = new Map(records.map((rec) => [rec.id, rec]));
    const now = this.now().getTime();
    const drifts: DriftItem[] = [];

    for (const [id, source] of truth) {
      const rec = projected.get(id);
      if (!rec) {
        drifts.push(await this.withEvidence(missingDrift(source)));
        continue;
      }
      if (rec.isDeleted) {
        drifts.push(item(source, rec, 'TOMBSTONED_IN_PROJECTION', 'WARNING', ['isDeleted'], {
          code: 'SOFT_DELETED_WHILE_LIVE',
          hint: 'The index marked this invoice deleted, but storage still holds it. A removal hook ran for a live invoice, or the row was restored after deletion.',
        }, 'INDEX_FROM_STORAGE'));
        continue;
      }
      const changed = IMMUTABLE_FIELDS.filter((field) => rec[field] !== source[field]);
      if (changed.length > 0) {
        drifts.push(item(source, rec, 'IMMUTABLE_FIELD_DRIFT', changed.some((f) => CRITICAL_FIELDS.has(f)) ? 'CRITICAL' : 'WARNING', changed, {
          code: 'OUT_OF_BAND_STORAGE_EDIT',
          hint: `${changed.join(', ')} never change after creation through the API. Storage was edited out of band (manual SQL, migration, import) or the index was built from another environment. Storage wins; confirm the storage value is intended before applying.`,
        }, 'INDEX_FROM_STORAGE'));
        continue;
      }
      if (rec.status !== source.status) {
        drifts.push(await this.withEvidence(statusDrift(source, rec, now)));
      }
    }

    for (const [id, rec] of projected) {
      if (truth.has(id)) continue;
      drifts.push(item(null, rec, 'ORPHANED_IN_PROJECTION', 'WARNING', [], {
        code: 'STORAGE_ROW_REMOVED',
        hint: 'The index holds an invoice storage does not. Storage was restored from an older snapshot, a retention sweep removed the row, or the index was seeded from another environment.',
      }, 'PURGE_FROM_PROJECTION', id));
    }

    return drifts.sort((a, b) => a.entityId.localeCompare(b.entityId) || a.kind.localeCompare(b.kind));
  }

  /** Backs a hint with audit evidence when a lookup is configured. Lookup failures never fail detection. */
  private async withEvidence(drift: DriftItem): Promise<DriftItem> {
    if (!this.options.auditLookup) return drift;
    let events: AuditEvent[];
    try {
      events = await this.options.auditLookup(drift.entityId);
    } catch {
      drift.rootCause.evidence.push('Audit lookup failed; hint is based on state comparison only');
      return drift;
    }
    const actions = events.map((e) => e.action);
    if (drift.kind === 'MISSING_IN_PROJECTION') {
      if (actions.includes('INVOICE_CREATED')) {
        drift.rootCause.code = 'INDEX_WRITE_LOST';
        drift.rootCause.hint = 'Creation was audited but never reached the index. The index write failed, or the process restarted after creation (the index is in memory).';
      } else {
        drift.rootCause.code = 'CREATED_OUTSIDE_API';
        drift.rootCause.hint = 'No INVOICE_CREATED audit event. The invoice entered storage outside the API: import pipeline, seed, direct SQL or a snapshot restore.';
      }
    }
    if (drift.rootCause.code === 'PAYMENT_NOT_PROJECTED' && !actions.includes('PAYMENT_VERIFIED') && !actions.includes('PAYMENT_SIMULATED')) {
      drift.rootCause.evidence.push('No PAYMENT_VERIFIED audit event: storage was marked PAID outside the verify route (payment monitor, import or manual SQL); confirm the tx hash on Horizon');
    }
    for (const e of events.slice(-5)) drift.rootCause.evidence.push(`${e.timestamp} ${e.action} by ${e.actor.type}`);
    return drift;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new ReconciliationError('RECONCILIATION_IN_PROGRESS', 'A reconciliation is already running; retry when it finishes');
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
}

function item(
  source: StoredInvoice | null,
  rec: IndexedInvoiceRecord | null,
  kind: DriftKind,
  severity: DriftSeverity,
  fields: string[],
  cause: { code: RootCause; hint: string },
  action: RepairActionType,
  id?: string
): DriftItem {
  return {
    entityId: id ?? source?.id ?? rec!.id,
    projection: 'search_index',
    kind,
    severity,
    fields,
    storage: source
      ? { status: source.status, amount: source.amount, assetCode: source.assetCode, sellerPublicKey: source.sellerPublicKey, memo: source.memo }
      : null,
    projected: rec
      ? { status: rec.status, amount: rec.amount, assetCode: rec.assetCode, sellerPublicKey: rec.sellerPublicKey, memo: rec.memo, isDeleted: rec.isDeleted }
      : null,
    rootCause: { ...cause, evidence: [] },
    action,
  };
}

function missingDrift(source: StoredInvoice): DriftItem {
  return item(source, null, 'MISSING_IN_PROJECTION', source.status === 'PAID' ? 'CRITICAL' : 'WARNING', [], {
    code: 'UNKNOWN',
    hint: 'Storage holds an invoice the index does not. Typical after a restart (the index is in memory), an import, or a snapshot restore.',
  }, 'INDEX_FROM_STORAGE');
}

function statusDrift(source: StoredInvoice, rec: IndexedInvoiceRecord, now: number): DriftItem {
  const fields = ['status'];
  const pair = `${rec.status}->${source.status}`;
  if (source.status === 'PENDING' && rec.status === 'EXPIRED' && new Date(source.expiresAt).getTime() <= now) {
    return item(source, rec, 'STATUS_DRIFT', 'INFO', fields, {
      code: 'AWAITING_LAZY_EXPIRY',
      hint: 'Storage row is past expiry and will be marked EXPIRED on the next read or sweep. Self-healing; not repaired.',
    }, 'NONE');
  }
  if (rec.status !== 'PENDING' && source.status === 'PENDING') {
    return item(source, rec, 'STATUS_DRIFT', rec.status === 'PAID' ? 'CRITICAL' : 'WARNING', fields, {
      code: 'PROJECTION_AHEAD_OF_STORAGE',
      hint: `Index shows ${rec.status} but storage never committed it: a rolled-back transaction, a lost optimistic-lock write, or storage restored from an earlier snapshot. Storage wins.`,
    }, 'INDEX_FROM_STORAGE');
  }
  switch (pair) {
    case 'PENDING->PAID':
      return item(source, rec, 'STATUS_DRIFT', 'CRITICAL', fields, {
        code: 'PAYMENT_NOT_PROJECTED',
        hint: 'Payment settled in storage but the index still shows PENDING, so sellers searching see an unpaid invoice.',
      }, 'INDEX_FROM_STORAGE');
    case 'PENDING->CANCELLED':
      return item(source, rec, 'STATUS_DRIFT', 'WARNING', fields, {
        code: 'CANCELLATION_NOT_PROJECTED',
        hint: 'Cancellation committed in storage but did not reach the index.',
      }, 'INDEX_FROM_STORAGE');
    case 'PENDING->EXPIRED':
      return item(source, rec, 'STATUS_DRIFT', 'INFO', fields, {
        code: 'EXPIRY_NOT_PROJECTED',
        hint: 'Expiry (lazy on read or the expiry sweep) updates storage only; the index is not told. Expected and low risk.',
      }, 'INDEX_FROM_STORAGE');
    default:
      return item(source, rec, 'STATUS_DRIFT', 'WARNING', fields, {
        code: 'UNKNOWN',
        hint: `Unexpected transition ${pair} between projection and storage; check the audit trail for this invoice.`,
      }, 'INDEX_FROM_STORAGE');
  }
}

function fingerprint(drifts: DriftItem[]): string {
  const canonical = drifts.map((d) => `${d.entityId}|${d.kind}|${d.action}|${d.fields.join(',')}|${d.storage?.status ?? '-'}|${d.projected?.status ?? '-'}`);
  return createHash('sha256').update(canonical.join('\n')).digest('hex');
}

function summarize(drifts: DriftItem[], counts: { storage: number; projected: number }): ReconciliationSummary {
  const bySeverity: Record<DriftSeverity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  const byKind: Record<DriftKind, number> = {
    MISSING_IN_PROJECTION: 0,
    ORPHANED_IN_PROJECTION: 0,
    TOMBSTONED_IN_PROJECTION: 0,
    STATUS_DRIFT: 0,
    IMMUTABLE_FIELD_DRIFT: 0,
  };
  for (const d of drifts) {
    bySeverity[d.severity] += 1;
    byKind[d.kind] += 1;
  }
  return {
    storageRecords: counts.storage,
    projectedRecords: counts.projected,
    drifts: drifts.length,
    repairable: drifts.filter((d) => d.action !== 'NONE').length,
    bySeverity,
    byKind,
  };
}
