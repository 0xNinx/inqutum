# Cross-service contract map (#252)

Source of truth: `backend/src/contracts/domain-events.ts`.
Executable check: `backend/tests/domain-event-contracts.test.ts` (runs in `npm test`).

Domain events move between components on three channels:

| Channel | Transport | Delivery |
|---------|-----------|----------|
| `audit` | Hash-chained audit store (`audit/audit-service.ts`) | Synchronous append. Consumers replay or query it later. |
| `notification` | In-app feed (`notifications/notification-service.ts`) | Synchronous, deduplicated by `dedupKey`, filtered by the preference router. |
| `job` | Durable job table (`jobs/worker.ts`) | At least once. Retry with backoff, then dead-letter. |

## What the test enforces

- Every `AuditAction`, `NotificationType` and `*_JOB` type in code has a contract. The `IMPERSONATION_*` and `CAPABILITY_ISSUED` security-session actions are out of scope (see `THREAT_MODEL.md`).
- Every `action: '…'` literal written anywhere in `src` is either declared or listed in `KNOWN_UNDECLARED_EVENTS`.
- Every producer and consumer names a file and a literal marker. The marker must still be in that file, so removing a producer or consumer without updating the map fails CI.
- `status` agrees with the endpoints. `no_producer` means zero producers. Every other status has at least one. Every event has at least one consumer.
- Real payloads match `requiredFields`: audit events recorded by the invoice API, a notification for a paid invoice, and jobs from both schedulers.
- Pinned required fields for the most depended-on events cannot change unless the version is bumped.
- Every contract name appears in this document.

## Version rules

| Change | Breaking? | Required action |
|--------|-----------|-----------------|
| Add an optional field, a producer or a consumer | No | None. Keep `version`. |
| Add a required field | Yes | Bump `version`. |
| Remove or rename any field | Yes | Bump `version`. Producers keep writing the old field until every consumer reads the new one. |
| Change a field's type | Yes | Bump `version`. Treat it as a removal plus an addition. |
| Remove an event | Yes | Mark it `no_producer` for one release, then delete it. |

`compareContracts(previous, next)` applies these rules. During a version window consumers accept N and N‑1. The audit store is append-only, so `projection-replay` must keep reading every version still held in the store.

## Contracts

### Audit channel

Every audit event carries `id, timestamp, action, actor.type, actor.id, scope.entityType, scope.entityId, hash`. "Invoice snapshot" below means `afterState.{id, sellerPublicKey, amount, assetCode, memo, status}`.

| Event | Status | Extra required fields | Producers (on failure) | Consumers (on failure) |
|-------|--------|-----------------------|------------------------|------------------------|
| `INVOICE_CREATED` | active | invoice snapshot | invoice handlers (log_and_continue) | search-index replay (refuse_and_report), reconciliation (degrade_to_state), audit query (pass_through) |
| `INVOICE_CANCELLED` | active | invoice snapshot | invoice handlers (log_and_continue) | search-index replay, audit query |
| `PAYMENT_VERIFIED` | active | invoice snapshot, `metadata.txHash`, `metadata.payerPublicKey` | invoice handlers (log_and_continue) | search-index replay, reconciliation, audit query |
| `PAYMENT_SIMULATED` | active | invoice snapshot | invoice handlers (dev only) | search-index replay, audit query |
| `INVOICE_EXPIRED` | **no_producer** | invoice snapshot | none: expiry is a lazy storage transition | search-index replay (derives expiries from storage instead) |
| `PROOF_EXPORTED` | audit_only | `metadata.schemaVersion`, `metadata.recordCount`, `metadata.format` | export routes (log_and_continue) | audit query |
| `CONFIG_CHANGED` | audit_only | `reason`, `metadata.configKey`, `metadata.change` | admin config, rollout guard, public status (all refuse_and_report: no evidence, no change) | audit query |
| `MAINTAINER_ACTION` | audit_only | `reason` | ops routes, jobs routes (log_and_continue) | audit query |

### Notification channel

Every notification carries `id, recipient, type, severity, title, message, dedupKey, entityId, createdAt`. All producers are `dedupe_idempotent`. The preference router is `skip_and_count`: a suppressed notification is still recorded in the routing audit.

| Event | Status | Notes |
|-------|--------|-------|
| `invoice.paid` | active | Mandatory, cannot be muted. Also requires `data.invoiceId`. |
| `invoice.expired` | active | Requires `data.invoiceId`. |
| `invoice.cancelled` | active | Requires `data.invoiceId`. |
| `payment.rejected` | active | Sent for recoverable rejection codes only. |
| `invoice.reminder` | active | The producer method exists, but nothing in `src` calls it yet. |
| `security.alert` | active | Mandatory. The producer method exists, but nothing in `src` calls it yet. |
| `marketing.digest` | **no_producer** | The router knows this type, but nothing emits it. |

### Job channel

Every job carries `id, type, payload.version, payload.data`. Consumers are `retry_then_dead_letter`.

| Event | Status | Notes |
|-------|--------|-------|
| `invoices.expire-pending` | active | One job per interval bucket (idempotency key). Held while the public status is `paused` or `maintenance`. |
| `projections.reconcile` | active | Detect only. Opt in with `RECONCILIATION_INTERVAL_MS`. Only the embedded worker runs it (see `RECONCILIATION.md`). |
| `records.resumable-repair` | **no_producer** | A handler is registered, but `/ops/repair-records` runs the service inline. |
| `retention.sweep` | **no_producer** | A handler is registered, but no scheduler enqueues it. |

## Known gaps (found while building the map)

- **`EMAIL_SENT`** is written by the send-email handler with `as any`, so it is not an `AuditAction`. Generic audit consumers see it, but typed consumers never match it. Declare it before anything depends on it.
- **`INVOICE_EXPIRED` has no producer.** Audit-derived projections therefore never see expiries. Projection replay overlays them from storage, and reconciliation reports them as `EXPIRY_NOT_PROJECTED`.
- **Audit writes on the invoice path are `log_and_continue`.** A failed audit append does not fail the request, so a projection rebuilt from audit can miss the event. Reconciliation (#255) detects the resulting drift.

## Failure behaviour glossary

| Value | Meaning |
|-------|---------|
| `log_and_continue` | The failure is logged and the user-facing operation still succeeds. |
| `retry_then_dead_letter` | The job retry policy applies with backoff, then the job goes to the dead-letter set (`/api/jobs`). |
| `dedupe_idempotent` | A duplicate delivery is a no-op keyed by a dedup key. |
| `skip_and_count` | The consumer skips an unusable event and counts it. |
| `refuse_and_report` | The consumer refuses to act at all (no partial apply) and returns the reason. |
| `degrade_to_state` | The consumer falls back to comparing state without the event. |
| `pass_through` | The consumer returns the event as stored and never interprets it. |

## Operational edge cases and recovery

- **A marker moved during a refactor.** CI fails with `"<marker>" not found in <file>`. Update the endpoint's `file` and `marker`. Nothing changes at runtime.
- **A new audit action or job type was added.** CI fails with `has no contract`. Add a contract with real producers and consumers, then add it to this document.
- **A required field changed.** CI fails on the pinned lock. Bump `version` and keep producing the old field until every consumer accepts the new version. Then update `PINNED` in the test.
- **Rollback.** The map is data plus a test. Reverting the commit removes it with no runtime effect. The routing and job changes it describes are covered by their own runbooks.
