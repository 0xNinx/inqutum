# Metadata Minimization and Retention

Field-level retention for the free-form `invoices.metadata` JSONB column.
Row-level retention ([DATA_RETENTION.md](DATA_RETENTION.md)) decides when a
whole invoice may go; this decides when the fields *inside* it must.

- **Policy + pure review:** `backend/src/db/metadata-minimization.ts`
- **Executor / job:** `runMetadataMinimization`, job type `metadata.minimize`
- **Tests:** `backend/tests/metadata-minimization.test.ts`

## Classification

Keys are normalised before lookup (`ipAddress`, `IP-Address`, `ip address` →
`ip_address`).

| Category | Keys | Window | Why |
| --- | --- | --- | --- |
| `retention_hold` | `legal_hold`, `under_dispute`, `under_audit` | life of row | Drives row retention; must survive until cleared. |
| `business_reference` | `order`, `order_id`, `reference`, `external_id`, `po_number`, `invoice_number`, `project` | life of row | Seller reconciliation. |
| `operational` | `source`, `channel`, `import_batch`, `import_line`, `client_version`, `correlation_id`, `request_id` | 90 d | Debugging an import or a release; worthless after the support window. |
| `operational` (override) | `idempotency_key` | 30 d | Only meaningful within a client retry window. |
| `network_identifier` | `ip`, `ip_address`, `user_agent`, `device_id`, `session_id`, `geo`, `location` | 30 d | Personal data, kept only for abuse investigation. |
| `prohibited` | `password`, `secret`, `token`, `access_token`, `api_key`, `private_key`, `secret_key`, `seed`, `mnemonic`, `authorization`, `card_number`, `pan`, `cvv`, `ssn` | 0 (removed on sight, any depth) | Must never be stored. |
| *unclassified* | anything else | kept | Reported in `unclassifiedKeys` so it can be classified. |

Windows are measured from the invoice `created_at`.

## Rules (first match wins)

1. **Legal hold** pins the whole object. Nothing is removed. Prohibited keys
   found under a hold are reported in `escalations` for a human.
2. **Prohibited** keys are removed at any age and at any nesting depth.
3. **Windowed** keys are removed once `created_at + window` has passed.
4. Keys without a window are kept.
5. **Unclassified** keys are kept and counted. Deleting data that has not been
   classified would silently break integrations that read it.

Settlement status does not protect metadata: the settlement evidence is the
invoice's columns and the `transactions` table, not free-form metadata.
`business_reference` keys survive on `PAID` invoices because they have no window.

## Running it

```ts
import { runMetadataMinimization } from './src/db/metadata-minimization';

await runMetadataMinimization(pool);                       // dry run (default)
await runMetadataMinimization(pool, { dryRun: false });     // apply
await runMetadataMinimization(pool, { dryRun: false, batchSize: 500, maxBatches: 20 }); // bounded slice
```

Or enqueue job `metadata.minimize` with `{"dryRun": false}` after registering
it with `registerMetadataMinimizationJob(worker, { db })`.

The result reports counts per category, held rows, escalations and
unclassified keys. Removed **values are never reported**, only paths.

## Sensitive metadata enforcement tests (Issue #359)

`backend/tests/sensitive-metadata-retention.test.ts` pins the enforcement
matrix against the real executor and job worker:

```bash
cd backend
node --import tsx --test tests/sensitive-metadata-retention.test.ts
```

| Path | What is asserted |
| --- | --- |
| Normal | A 100-day-old invoice loses `ip` / `user_agent` (30 d) and `request_id` (90 d), keeps `order`, and a dry run writes nothing. |
| Boundary | A network identifier is kept at 29 days and removed at exactly 30 days. |
| Failure | An invalid `created_at` disables age-based removal but still removes `password`; a failed UPDATE leaves the row untouched. |
| Retry | A transient SELECT failure requeues `metadata.minimize`; the next attempt succeeds and applies the same minimization. |
| Authorization | A legal hold blocks all removals and escalates `password`; a settlement-linked invoice survives row retention while its IP is still minimized. |

Recovery follows the same rules as a normal run: fix the database/transient
error and re-run. Minimization is idempotent and compare-and-set, so a retry
converges without overwriting concurrent edits. If a hold was added after the
read, the compare-and-set skips the row and the next run re-reviews it.

## Edge cases and failure modes

| Situation | Behaviour |
| --- | --- |
| `metadata` is null, an array or a scalar | Treated as empty; nothing changes. |
| Unparseable `created_at` | Age-based removal disabled for that row (age we cannot prove is not age); prohibited keys still removed. |
| Row edited between read and write | `UPDATE … WHERE metadata = <value read>` matches nothing; counted as `skippedConcurrentChange` and re-reviewed next run. A concurrent `legal_hold` is never overwritten. |
| Run killed half way | Each UPDATE is atomic per row. Every row is either fully minimized or untouched; re-running converges. Resume with `afterId: result.lastId`. |
| Very large table | Reads in keyset pages (`id > $1 ORDER BY id LIMIT batchSize`); memory is bounded by `batchSize`. |
| Deeply nested objects | Prohibited-key stripping stops at depth 8. |

## Rollback / recovery

Removals are deletions by design — keeping a "backup" of removed IPs or
tokens would defeat the purpose. Therefore:

1. **Always dry-run first** and read the report (`removedByCategory`,
   `unclassifiedKeys`, `escalations`).
2. If a window was wrong, fix `METADATA_FIELD_POLICY` and redeploy; already
   removed values can only be restored from a database backup / PITR taken
   before the run (see [RESTORE_VALIDATION.md](RESTORE_VALIDATION.md)).
3. To stop enforcement, stop enqueuing `metadata.minimize`. There is no schema
   change and nothing else depends on it.

## Compatibility

No schema change and no API change. `metadata` stays a free-form object; only
its contents shrink over time.
