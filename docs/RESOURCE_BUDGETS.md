# Resource Budgets

CI-enforced ceilings for worst-case, high-cardinality workloads.

- **Budget table:** `backend/src/ops/resource-budgets.ts` (`RESOURCE_BUDGETS`)
- **Tests:** `backend/tests/resource-budgets.test.ts` (part of `npm test`;
  also `npm run test:budgets`)

## Budgets

| Budget | Workload | Ceiling |
| --- | --- | --- |
| `user.whale_seller_pagination` | 20k invoices / 2k sellers; one seller owns 5k. 10 keyset pages + stats. | 1 500 ms CPU, +128 MB heap |
| `ledger.audit_append_and_verify` | 20k hash-chained audit appends into a 5k ring, full chain verify, 200 entity lookups | 3 000 ms CPU, +96 MB heap, size == capacity |
| `search.high_cardinality_queries` | 20k indexed invoices, 50 queries across 4 roles | 2 000 ms CPU, +128 MB heap |
| `ops.duplicate_scan` | duplicate detection over 20k invoices | 1 500 ms CPU, +96 MB heap |
| `ops.metadata_minimization_plan` | metadata review over 20k invoices | 1 500 ms CPU, +96 MB heap |
| `db.list_invoices_page` | `getInvoicesBySeller` at limit 1 / 50 / 500 | **2 queries** |
| `db.invoice_stats` | `getInvoiceStats` | **2 queries** |
| `db.get_invoice` | `getInvoiceById` | **2 queries** |
| `db.metadata_minimization_dry_run_2k` | dry run over 2k rows, pages of 500 | **5 queries**, no UPDATE |

Measured locally (Apple Silicon) at roughly 1/8 to 1/40 of each CPU ceiling.
The headroom is intentional: budgets catch complexity regressions (O(n) → O(n²),
N+1 queries, unbounded buffers), not micro-slowdowns.

## Design choices

- **Query counts are exact** and never scaled. They are deterministic and the
  most valuable signal for Postgres: a constant must stay constant as page size
  grows.
- **CPU, not wall time.** `process.cpuUsage()` is less sensitive to a noisy
  neighbour than wall clock. Wall time is printed for information only.
- **Heap growth is an upper bound.** It is measured without forcing GC, so
  garbage can only inflate it; a pass is meaningful, an occasional near-miss
  is worth a re-run before a code change.
- Every measurement is printed as a test diagnostic (`# user.whale_… cpu=…`),
  so the trend is visible in CI logs.

## Edge cases and failure modes

| Situation | What to do |
| --- | --- |
| Slow or shared CI runner trips a CPU/heap ceiling | Set `RESOURCE_BUDGET_MULTIPLIER=2` (or higher) for that job. Query budgets are unaffected. |
| A query budget trips | A code path added a round-trip (often an N+1). Fix the code; raising the number needs a written rationale in `RESOURCE_BUDGETS`. |
| A CPU budget trips by a large factor | Look for a nested loop over the workload. The workload sizes are fixed, so the ratio to the ceiling is meaningful. |
| Ledger verify fails after eviction | Fixed in this change: `MemoryAuditStore.verifyChain()` now starts from the hash of the last evicted event instead of `null`. Previously any store that had evicted reported a broken chain. |

## Rollback

The budgets are tests and a data table; nothing at runtime reads them.
To relax one temporarily, raise `RESOURCE_BUDGET_MULTIPLIER` in CI rather than
editing the ceiling, then fix the regression.
