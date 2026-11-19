# Public status: degraded, paused, maintenance (#254)

Code: `backend/src/ops/public-status.ts`. Tests: `backend/tests/public-status.test.ts`.

One status drives three paths, so the UI, the API and background work never disagree:

| Path | Mechanism |
|------|-----------|
| UI | `GET /api/status` (public, no auth, `Cache-Control: no-store`, standard `{ success, data }` envelope). The frontend renders `data` with `frontend/lib/public-status.js`. |
| API | `requireCapability` middleware on gated routes returns 503 with a stable `code`, `Retry-After` and `X-Service-Status`. |
| Background | `JobWorker` `gate` option. Held job types are not claimed, stay `queued` and consume no attempt. |

## States

Precedence: `maintenance` > `paused` > `degraded` > `operational`.

| State | Set by | Refused (503) | Jobs held |
|-------|--------|---------------|-----------|
| `operational` | default | nothing | none |
| `degraded` | operator, or derived from the dependency matrix | nothing from the status itself (dependency fallbacks still apply) | none |
| `paused` | operator | `POST /invoices` (`SERVICE_PAUSED`), `/invoices/:id/verify`, `/invoices/:id/simulate-payment` | `invoices.expire-pending` |
| `maintenance` | operator | every gated write: create, cancel, verify, simulate, send-email, `POST /exports` (`SERVICE_MAINTENANCE`) | all |

Reads (`GET /invoices…`, `GET /exports/:id`, `/health`, `/status`) are never gated.

## Public payload (`data`)

```json
{
  "state": "paused",
  "title": "Payments temporarily paused",
  "message": "New invoices and payment verification are paused. …",
  "since": "2026-11-18T10:00:00.000Z",
  "expectedResolutionAt": null,
  "retryAfterSeconds": 120,
  "capabilities": {
    "invoice_creation": "unavailable",
    "invoice_viewing": "available",
    "invoice_cancellation": "available",
    "payment_verification": "unavailable",
    "exports": "available",
    "email_notifications": "available"
  },
  "updatedAt": "…"
}
```

**Secret safety.** The payload is built from an allow-list. `title` and `message` come from a fixed catalog (`STATE_POLICY`). The operator's `reason`, the actor, dependency error strings, hosts and runbook links never appear in it. The tests feed a reason containing a fake API key, a host name and an incident id, plus a probe error containing an IP and a token, and assert that none of them reach `/api/status`. Operators see everything at `GET /api/ops/public-status`.

## Operating it

All routes need `Authorization: Bearer $JOBS_ADMIN_TOKEN`.

```bash
# Read (includes the internal reason and the version)
curl -s -H "Authorization: Bearer $T" $API/api/ops/public-status | jq .data

# Pause payments (expectedVersion = current .data.version)
curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"state":"paused","reason":"Horizon returning inconsistent ledgers, INC-42","expectedVersion":0,
       "expectedResolutionAt":"2026-11-18T12:00:00Z"}' \
  $API/api/ops/public-status

# Resume
curl -s -X DELETE -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"reason":"Horizon healthy again, resuming","expectedVersion":1}' $API/api/ops/public-status
```

Every declare and clear writes a `CONFIG_CHANGED` audit event (`metadata.configKey = "publicStatus"`) before the change is applied. A stale `expectedVersion` returns 409 `STATUS_VERSION_CONFLICT`, so two operators cannot silently overwrite each other.

## Edge cases and failure modes

- **Audit store unavailable.** The declare or clear returns 503 `STATUS_AUDIT_UNAVAILABLE` and the state does not change. There is never a status change without evidence.
- **Dependency probes crash.** `/api/status` still returns 200 with the declared state. The internal view reports `dependencyState: "unavailable"`. A failed probe run never invents an outage.
- **A dependency is down and nobody has declared anything.** The public state becomes `degraded` and the affected capabilities show `limited` or `unavailable`. The status gate itself still refuses nothing; the dependency matrix fallbacks (`DEPENDENCY-DEGRADATION.md`) decide.
- **Lazy expiry during a pause.** The background expiry sweep is held, but storage still expires overdue invoices lazily on read. A long pause can therefore expire invoices whose payers could not verify. For pauses longer than the shortest invoice expiry, tell affected sellers to reissue, or extend expiries before resuming.
- **Multiple instances.** The declaration is process-local, like admin-config overrides. Declare it on every instance, or route operator calls through one instance behind sticky sessions. A restart returns that instance to `operational`. Treat a restart as a clear and re-declare if needed.
- **Standalone worker.** `npm run worker` is a separate process with its own status. A declaration made through the API holds only the embedded worker in that API process. To hold background work during maintenance with a standalone worker, stop it (or scale it to zero) for the window.
- **Payments sent during a pause.** On-chain payments are not lost. Once the pause is cleared, `POST /invoices/:id/verify` settles them as long as the invoice has not expired.
- **Job attempts.** Held jobs are never claimed, so a long maintenance window cannot dead-letter them.

## Rollback and recovery

- **Undo a declaration.** `DELETE /api/ops/public-status`. Behaviour returns to the pre-#254 behaviour immediately.
- **Undo the feature.** Revert the commit. `operational` is the default and passes every request through, so no data or schema migration is involved.
- **Stuck in maintenance after a crash loop.** Restarting clears it (process-local). Check the audit trail for the last `publicStatus` event to see who declared it and why.
