# Rollback Verification After Failed Migrations or Deployments (#301)

## Overview & Goal
When a database migration fails midway, post-checks fail, or a production release experiences runtime errors, operators and automated continuous deployment systems trigger rollbacks. However, assuming that a rollback has cleanly converged without verification is dangerous. The Rollback Verification Engine validates that both the database schema and application deployment have completely, cleanly, and safely reverted to the expected baseline state.

---

## Verification Scope & Checks

### 1. Database Schema Rollback Verification
Given an expected pre-migration `SchemaBaseline`:
- **Missing Object Detection**: Verifies that all expected tables, views, and columns are restored.
- **Extraneous / Dirty Object Detection**: Scans for tables, columns, views, or indexes created by the failed migration that were not properly cleaned up by the rollback script.
- **Dangling Lock & State Check**: Verifies that no migration locks (`migrations_lock`) or dirty migration status markers remain active in the database.
- **Automated Remediation SQL**: Generates exact, copy-pasteable SQL commands (`DROP TABLE IF EXISTS ...`, `ALTER TABLE ... DROP COLUMN ...`) to remediate dirty objects.

### 2. Application Deployment Rollback Verification
- **Liveness & Readiness**: Probes `/api/health` and `/api/ready` to verify service health.
- **Version Assertion**: Checks that the observed running software version matches the declared rollback target version.
- **Transient Connection Retries**: Employs configurable retry loops with exponential backoff to handle container restarts and pool warmups.

---

## Operational Edge Cases & Recovery / Rollback Behavior

| Operational Scenario | Impact / System Behavior | Recovery & Rollback Path |
|---|---|---|
| **Aborted migration left dangling tables** | The failed migration created `table_v2`, but rollback DDL only reverted alterations on existing tables. | Verifier flags `extraneousTables: ['table_v2']` and emits `DROP TABLE IF EXISTS public.table_v2 CASCADE;`. |
| **Migration lock held by crashed runner** | Node process crashed during migration; lock flag remains `true`. | Verifier detects `dirtyMarkers: ['MIGRATION_LOCK_ACTIVE']` and outputs remediation SQL `UPDATE migrations_lock SET is_locked = false;`. |
| **Deployment rollback container rollover delay** | Verifier runs immediately while old pods are terminating and rollback pods are spinning up. | Built-in exponential backoff retries probe up to `maxRetries` (default: 2), avoiding false alarms. |
| **Partial deployment rollback (stale version running)** | Some nodes were rolled back but load balancer still routes to old deployment version. | Verifier fails with `versionMatch: false` and lists observed vs expected version. Operators restart remaining pods. |
| **Unauthorized execution** | Unprivileged operator or unauthorized script attempts to certify rollback. | Fails immediately with `UnauthorizedRollbackVerificationError` (HTTP 403). Requires `ADMIN` or `OWNER` credentials. |

---

## Complexity Analysis
- **Time Complexity**: $O(N)$ where $N$ is the number of schema objects ($O(1)$ per information schema row).
- **Space Complexity**: $O(N)$ for object sets and reporting structures.

---

## Post-rollback data verification (#209)

The schema and deployment checks above show that the *code and schema* are back
at the baseline. They do not show that the *data* is consistent with the
restored behaviour. While the rolled-back release was live, it may have written
records, enqueued jobs or dispatched provider calls that the restored release
cannot read, run or reconcile. `verifyReleaseRollback`
(`backend/src/ops/release-rollback-verification.ts`) checks for this and lists
every record that needs manual repair.

### Inputs

- **Window**: `rolledBackVersion`, `restoredVersion`, `deployedAt`,
  `rollbackStartedAt`, `rollbackCompletedAt`, `rollbackStatus`
  (`completed | in_progress | failed`).
- **Restored behaviour contract**: what the restored version understands:
  invoice statuses, readable `_schemaVersion`s, job types with their maximum
  payload version, and external reference kinds.
- **Data source**: a `RollbackDataSource` with read methods only
  (`listInvoices`, `listJobs`, `listExternalReferences`, optional `observedVersion`).

### Checks

| Check | Severity | Detects |
| --- | --- | --- |
| `rollback.status` | critical | Rollback `failed` or still `in_progress` |
| `rollback.version` | critical | Service still reports a version other than the restored one |
| `jobs.unknown_type` | repair | Queued/running jobs whose type has no handler after rollback (pending operations that would never run) |
| `jobs.payload_version` | repair | Queued/running jobs enqueued with a newer payload shape |
| `jobs.in_flight` | repair | Jobs claimed by a worker of the rolled-back release that are still running (partially processed) |
| `jobs.dead_in_window` | review | Jobs that dead-lettered while the bad release was live. Decide whether to requeue them |
| `invoices.unknown_status` | repair | Statuses the restored release does not know |
| `invoices.schema_version` | repair | Records stamped with a schema the restored release cannot read. Unversioned historical records are allowed unless `allowUnversionedInvoices: false` |
| `invoices.partial_settlement` | repair | `PAID` without full payment fields, unpaid records with a tx hash, an observed confirmed payment that was never applied, or a mismatched hash |
| `invoices.written_in_window` | review | User-facing records created or settled by the rolled-back release. Spot-check them |
| `external.unknown_kind` | repair | Provider references of a kind the restored release cannot reconcile |
| `external.pending` | repair | Provider calls dispatched during the window with no recorded outcome |
| `external.dangling` | repair | Provider references pointing at a missing invoice |

Outcome: `clean` (exit 0, review notes allowed), `needs_repair` (exit 1),
`failed` (exit 2). Every finding has a `remediation`, and `manualRepair` groups
the ids to fix by resource type.

### Read-only by default

The checks never write. The data source is wrapped in a proxy that exposes only
the read methods. Any other property access or assignment throws
`RollbackDataSourceWriteAttempt`, so an adapter that also exposes write methods
cannot be mutated by accident. There is no "apply" mode. Repairs go through the
existing audited paths: resumable repair jobs, maintainer intents
(`job.requeue_dead`) and reconciliation apply. Verification requires
`OPERATOR`, `ADMIN` or `OWNER`.

### Running it

```bash
cd backend
npm run rollback:verify -- --fixture clean     # exit 0
npm run rollback:verify -- --fixture partial   # exit 1, lists records needing repair
npm run rollback:verify -- --fixture failed    # exit 2
npm run rollback:verify -- --fixture partial --json
```

The fixtures (`backend/src/sandbox/rollback-fixtures.ts`) build on the seed
dataset ([SEED_FIXTURES.md](./SEED_FIXTURES.md)). For a real environment, call
`verifyReleaseRollback()` with a `RollbackDataSource` backed by the invoice
storage (`getAllInvoices`) and job store (`list`). Tests are in
`backend/tests/release-rollback-verification.test.ts`.
