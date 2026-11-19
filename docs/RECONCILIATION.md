# Projection reconciliation (#255)

Code: `backend/src/ops/reconciliation.ts`. Tests: `backend/tests/reconciliation.test.ts`.

Invoice storage (Postgres or memory) is the source of truth. The search index is a derived projection held in process memory. Reconciliation compares the two record by record, explains each difference, and repairs the projection only through a reviewed dry run. **Storage is never written.**

## Workflow

```
POST /api/ops/reconciliation/dry-run      → plan (read-only), planId, expiresAt
            review drifts + root causes
POST /api/ops/reconciliation/apply        {planId}  → applied / failed / verification
POST /api/ops/reconciliation/rollback     → restore pre-apply projection
```

All three need `Authorization: Bearer $JOBS_ADMIN_TOKEN`. Apply and rollback write a `MAINTAINER_ACTION` audit event.

- **Dry run** reads storage and the index. It changes nothing and stores a single-use plan for 15 minutes.
- **Apply** re-detects first. If the live drift no longer hashes to the reviewed plan, it returns 409 `PLAN_STALE` with a fresh plan and writes nothing. Otherwise it snapshots the index, applies exactly the planned actions, re-detects, and reports `verification.clean`. The response is 207 if anything failed or remained.
- **Rollback** restores the snapshot taken by the last apply. It does not touch storage.

A scheduled job, `projections.reconcile`, runs the dry run only. Enable it with `RECONCILIATION_INTERVAL_MS` (for example `900000`). The job result lists `healthy`, the summary, and the critical drifts as `<invoiceId>:<rootCause>`. It never repairs.

## Drift kinds and root-cause hints

| Kind | Root cause | Severity | Action |
|------|-----------|----------|--------|
| `MISSING_IN_PROJECTION` | `INDEX_WRITE_LOST` (an `INVOICE_CREATED` audit exists) or `CREATED_OUTSIDE_API` (no audit event: import, seed, SQL, restore) | CRITICAL if PAID, else WARNING | index from storage |
| `ORPHANED_IN_PROJECTION` | `STORAGE_ROW_REMOVED`: restored from an older snapshot, retention sweep, or another environment | WARNING | purge from index |
| `TOMBSTONED_IN_PROJECTION` | `SOFT_DELETED_WHILE_LIVE` | WARNING | re-index from storage |
| `STATUS_DRIFT` PENDING→PAID | `PAYMENT_NOT_PROJECTED`. Adds evidence when no `PAYMENT_VERIFIED` event exists. | CRITICAL | re-index |
| `STATUS_DRIFT` PENDING→CANCELLED | `CANCELLATION_NOT_PROJECTED` | WARNING | re-index |
| `STATUS_DRIFT` PENDING→EXPIRED | `EXPIRY_NOT_PROJECTED`: expiry is not an event (see `CONTRACT_MAP.md`) | INFO | re-index |
| `STATUS_DRIFT` index ahead of storage | `PROJECTION_AHEAD_OF_STORAGE`: rolled-back transaction, lost optimistic-lock write, or older storage snapshot | CRITICAL if the index says PAID | re-index (storage wins) |
| `STATUS_DRIFT` index EXPIRED, storage PENDING but overdue | `AWAITING_LAZY_EXPIRY` | INFO | **none**: self-heals on the next read or sweep |
| `IMMUTABLE_FIELD_DRIFT` | `OUT_OF_BAND_STORAGE_EDIT`: amount, asset, seller or memo changed outside the API | CRITICAL for amount, seller or asset | re-index (confirm the storage value first) |

When `getAuditEventsByInvoice` is available, each hint carries the invoice's last five audit events as evidence. A failed audit lookup is noted in the evidence and detection continues on state alone.

## Edge cases and failure modes

- **Drift changes between review and apply** (new payment, new invoice). Apply refuses with `PLAN_STALE` before any write. Review the returned plan and apply that one.
- **Plan expired or already applied.** 410 `PLAN_EXPIRED` or 409 `PLAN_ALREADY_APPLIED`. Run a new dry run.
- **Two operators at once.** 409 `RECONCILIATION_IN_PROGRESS`. Only one dry run or apply runs per instance.
- **An invoice disappears from storage mid-apply.** That action is reported under `failed`, the rest still apply, and verification reports what remains. The response is 207.
- **`IMMUTABLE_FIELD_DRIFT` means storage was edited.** Reconciliation trusts storage. If the storage value is wrong, fix storage first through the normal recovery path (`RESUMABLE_REPAIR.md`), then reconcile.
- **`PROJECTION_AHEAD_OF_STORAGE` with PAID.** Someone could have seen "paid" in search for an invoice storage has as unpaid. Verify the tx hash on Horizon before telling the seller anything.
- **Multiple instances.** Each API process has its own in-memory index. Run reconciliation on each instance. The scheduled job is registered only by the embedded worker, so a standalone `npm run worker` never claims it and never reconciles an index it cannot see.
- **Storage without `getAllInvoices`.** Returns 501 `STORAGE_SCAN_UNSUPPORTED`.
- **Large stores.** Detection is O(storage + index) in memory, the same bound as `stale-projections`. For very large stores, prefer the event replay rebuild (`EVENT_REPLAY.md`).

## Rollback and recovery

- **Undo an apply.** `POST /api/ops/reconciliation/rollback` restores the exact pre-apply index. Only the most recent apply can be rolled back. A restart also discards it, because the index is rebuilt from scratch on restart.
- **Undo the feature.** Revert the commit. No schema or storage change was made. `RECONCILIATION_INTERVAL_MS` unset means the scheduler never starts.
