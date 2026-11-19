/**
 * Resource budgets for worst-case workloads (#251).
 *
 * A budget is a ceiling, written down as data, that a high-cardinality
 * scenario must stay under: CPU time, heap growth, and — the one that matters
 * most for Postgres — the number of database round-trips. Query counts are
 * exact and deterministic, so they are enforced as-is. Time and memory vary
 * with the machine, so their ceilings carry generous headroom and scale with
 * `RESOURCE_BUDGET_MULTIPLIER` for slow runners.
 *
 * The budgets catch complexity regressions (an O(n) path turning O(n²), an
 * N+1 query, an unbounded buffer), not micro-slowdowns. If one trips, the fix
 * is almost always in the code under test, not the number here.
 */

export interface ResourceBudget {
  /** CPU time (user + system) for the workload. */
  maxCpuMs?: number;
  /** heapUsed after minus before. An upper bound; GC only makes it smaller. */
  maxHeapGrowthMb?: number;
  /** Exact ceiling on database round-trips. Never scaled. */
  maxQueries?: number;
  /** What the workload is and why this ceiling. */
  rationale: string;
}

export const RESOURCE_BUDGETS = {
  'user.whale_seller_pagination': {
    maxCpuMs: 1_500,
    maxHeapGrowthMb: 128,
    rationale:
      '20k invoices across 2k sellers, one seller owning 5k. Paging 10 pages + stats for that seller is O(n) per call in the memory backend.',
  },
  'ledger.audit_append_and_verify': {
    maxCpuMs: 3_000,
    maxHeapGrowthMb: 96,
    rationale:
      '20k hash-chained audit events into a 5k-capacity store, then a full chain verify and per-entity lookups. Memory must stay bounded by capacity.',
  },
  'search.high_cardinality_queries': {
    maxCpuMs: 2_000,
    maxHeapGrowthMb: 128,
    rationale: '20k indexed invoices, 50 mixed-role queries. Each query is one linear scan; anything quadratic blows this.',
  },
  'ops.duplicate_scan': {
    maxCpuMs: 1_500,
    maxHeapGrowthMb: 96,
    rationale: 'Duplicate detection over 20k invoices is O(n log n): one hash per invoice plus a sort per group.',
  },
  'ops.metadata_minimization_plan': {
    maxCpuMs: 1_500,
    maxHeapGrowthMb: 96,
    rationale: 'Reviewing metadata on 20k invoices is linear in total key count.',
  },
  'db.list_invoices_page': {
    maxQueries: 2,
    rationale: 'Lazy expiry + one SELECT. Must not grow with page size (no N+1).',
  },
  'db.invoice_stats': {
    maxQueries: 2,
    rationale: 'Lazy expiry + one aggregate. Revenue per asset is a subquery, not a query per asset.',
  },
  'db.get_invoice': {
    maxQueries: 2,
    rationale: 'Lazy expiry + one SELECT by primary key.',
  },
  'db.metadata_minimization_dry_run_2k': {
    maxQueries: 5,
    rationale: '2k rows in pages of 500: four full pages and one empty page. A dry run must never issue an UPDATE.',
  },
} satisfies Record<string, ResourceBudget>;

export type BudgetName = keyof typeof RESOURCE_BUDGETS;

/** Scales time/memory ceilings for slow machines. Query ceilings are exact. */
export function budgetMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.RESOURCE_BUDGET_MULTIPLIER);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export interface Measurement {
  cpuMs: number;
  wallMs: number;
  heapGrowthMb: number;
  queries: number;
}

export interface QueryLike {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Counts round-trips. Delegates when given a database, else returns empty results. */
export class CountingQueryable implements QueryLike {
  readonly statements: string[] = [];

  constructor(private readonly delegate?: QueryLike) {}

  get count(): number {
    return this.statements.length;
  }

  reset(): void {
    this.statements.length = 0;
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> {
    this.statements.push(text.trim().split(/\s+/)[0].toUpperCase());
    return this.delegate ? this.delegate.query(text, params) : { rows: [], rowCount: 0 };
  }
}

export async function measure<T>(
  workload: () => T | Promise<T>,
  queries?: CountingQueryable
): Promise<{ result: T; measurement: Measurement }> {
  const startQueries = queries?.count ?? 0;
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();

  const result = await workload();

  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

  return {
    result,
    measurement: {
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      heapGrowthMb: Math.max(0, heapGrowth) / (1024 * 1024),
      queries: (queries?.count ?? 0) - startQueries,
    },
  };
}

/** Human-readable violations; empty when the measurement is within budget. */
export function checkBudget(name: BudgetName, measurement: Measurement, multiplier = budgetMultiplier()): string[] {
  const budget: ResourceBudget = RESOURCE_BUDGETS[name];
  const violations: string[] = [];
  if (budget.maxCpuMs !== undefined && measurement.cpuMs > budget.maxCpuMs * multiplier) {
    violations.push(`${name}: cpu ${measurement.cpuMs.toFixed(0)}ms > ${budget.maxCpuMs * multiplier}ms`);
  }
  if (budget.maxHeapGrowthMb !== undefined && measurement.heapGrowthMb > budget.maxHeapGrowthMb * multiplier) {
    violations.push(`${name}: heap +${measurement.heapGrowthMb.toFixed(1)}MB > ${budget.maxHeapGrowthMb * multiplier}MB`);
  }
  if (budget.maxQueries !== undefined && measurement.queries > budget.maxQueries) {
    violations.push(`${name}: ${measurement.queries} queries > ${budget.maxQueries}`);
  }
  return violations;
}
