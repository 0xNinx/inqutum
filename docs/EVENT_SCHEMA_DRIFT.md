# Cross-Service Event Schema Drift Detection (#389)

## Overview
Quittance services emit and consume cross-service domain events (`invoice.created`, `invoice.paid`, `ownership.transferred`). `EventSchemaDriftDetector` (`backend/src/schema/event-schema-drift.ts`) validates observed event payloads against canonical versioned `EventSchemaContract` definitions before schema mismatches cause silent consumer failures.

## Drift Classification
| Severity | Drift Kinds | Impact |
|---|---|---|
| `NONE` | — | Payload matches active contract. |
| `NON_BREAKING` | `UNKNOWN_OPTIONAL_FIELD` | Additive field observed; consumers ignoring unknown keys remain safe. |
| `BREAKING` | `MISSING_REQUIRED_FIELD`, `TYPE_MISMATCH`, `INVALID_ENUM_VALUE`, `VERSION_MISMATCH`, `UNKNOWN_CONTRACT` | Consumers may fail or misinterpret data. `rollbackRecommended: true`. |

## Authorization & HTTP Ops API
All ops endpoints require `Authorization: Bearer <JOBS_ADMIN_TOKEN>`:
- `GET /api/ops/event-schemas/contracts` — List active registered contracts.
- `POST /api/ops/event-schemas/drift-check` — Validate an `ObservedEventSample` (`200` if no breaking drift, `409` if breaking drift detected, `400` on invalid payload).
- `POST /api/ops/event-schemas/rollback` — Roll back an event contract to a prior version.

Programmatic contract mutations (`registerContract`, `rollbackContract`) require `OWNER` or `ADMIN` role and throw `UnauthorizedSchemaOperationError` (HTTP `403`) otherwise.

## Retry, Edge Cases & Recovery / Rollback
- **Transient Probe Failures**: `detectDriftWithRetry(fetcher, { maxRetries, initialBackoffMs })` retries transient transport errors with exponential backoff and throws `DRIFT_PROBE_UNAVAILABLE` (HTTP `503`) if exhausted. Validation errors (`EventSchemaDriftError`) fail fast without retry.
- **Nullable Fields**: Fields with `nullable: true` accept `null`; non-nullable fields flag `null` as `TYPE_MISMATCH` (`BREAKING`).
- **Rollback**: If a producer deploys a breaking schema change, call `rollbackContract(eventType, targetVersion, actor)` (or `POST /api/ops/event-schemas/rollback`) to pin the previous contract version while rolling back the producer deployment.
- **Contract Preservation**: Existing `_schemaVersion` record versioning (`backend/src/schema/schema-version.ts`) is untouched; event drift detection is additive.
