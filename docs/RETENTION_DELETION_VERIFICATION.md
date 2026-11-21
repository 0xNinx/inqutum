# Retention: apply authorization and deletion verification

Issue #431. Extends the retention sweep from [DATA_RETENTION.md](DATA_RETENTION.md).
The policy, planner and dry-run default are unchanged. This note covers only
the apply path.

- **Executor:** `backend/src/db/retention-sweep.ts`
- **Tests:** `backend/tests/retention-deletion-verification.test.ts`
  (existing tests in `backend/tests/data-retention.test.ts` still apply)

## What changed

1. **Authorization.** `registerRetentionJob(worker, { db, authorizeApply })`
   accepts an optional authorizer. For an apply run (`dryRun: false`) it is
   called with `{ jobId, payload }` before any read. Only a literal `true`
   authorizes. `false`, any other value, or a thrown error refuses the run with
   a `NonRetryableJobError`, and no query is issued. Dry runs are never gated.
2. **Verification.** Each table's planned batch is deleted and then checked.
   The DELETE must report exactly the planned row count, and a follow-up
   `SELECT ... WHERE id = ANY(...)` must return none of the planned ids. Any
   mismatch raises `RetentionVerificationError`.
3. **Atomicity.** When the database exposes `begin`, `commit` and `rollback`,
   all deletes and their checks run in one transaction. Any failure rolls every
   table back. `COMMIT` is issued only after every table has passed.
4. **Result fields.** The sweep result gains `deletionVerified` (true only for
   an apply in which every planned table passed) and `verifiedTables`. Existing
   fields are unchanged.

## Contract and migration

- The default is unchanged. Without `authorizeApply`, a payload with
  `dryRun: false` applies, as before. No existing caller breaks.
- To enforce authorization, pass an authorizer when wiring the job. This is a
  maintainer decision. The authorizer should decide from the job's origin, not
  from the payload alone, because the payload is attacker-reachable by anyone
  who can enqueue a job.
- The database adapter should implement `begin`, `commit` and `rollback`. Until
  it does, apply runs are best-effort (see edge cases).

## Recovery

| Outcome | State of the database | What to do |
| --- | --- | --- |
| Dry run | Unchanged | Nothing. |
| Apply succeeds, `deletionVerified: true` | Planned rows removed and committed | Nothing. |
| `RetentionVerificationError` or DB error, transaction rolled back | Unchanged | Read the error, fix the cause, re-run apply. Re-running is safe; the second run deletes only what is still eligible. |
| Error message contains `rollback failed` | Unknown; the transaction may still be open | Inspect the tables against the logged plan before any re-run. Check the connection for an open transaction. |
| Error message contains `no transaction support` | Tables listed before the failure are already deleted | Restore from backup, or accept the loss if the rows were past their window. Then add transaction support to the adapter before the next apply. |

The worker never retries a failed sweep. A rolled-back failure is safe to
re-run, but that decision belongs to an operator who has read the error.

## Edge cases

- **Plan-to-delete drift.** The plan is built in one read and the deletes run
  later. A row that becomes `PAID` or settlement-linked between the two is not
  re-checked and can be deleted. Narrow the window by running the sweep in
  off-peak hours, or add a settlement guard to each DELETE. Neither is in this
  change.
- **Batch cap.** `batchSize` applies per table. With a cap, `deletionVerified`
  means every batch that was attempted was verified. It does not mean every
  eligible row was removed. Use `result.eligible` against `result.deleted` to
  see what remains.
- **Empty apply.** With nothing eligible, an apply opens and commits an empty
  transaction and reports `deletionVerified: true` with zero deletes.
- **Count mismatch from concurrency.** If another writer removes a planned row
  between the plan and the DELETE, the count differs and the sweep rolls back.
  The next run re-plans and succeeds.
- **Unknown tables** are still refused before any read, as before.

## What this does not cover

- Authentication of the caller who enqueues the job. The authorizer is the hook;
  the identity source is a deployment decision.
- Verification of backups or of rows outside the planned set.
- Tests in this change are written for review and have not been executed.
