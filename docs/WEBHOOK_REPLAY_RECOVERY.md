# Webhook deduplication recovery (issue #430)

Scope: the signed `POST /webhooks/incoming` route (`backend/src/routes/webhook.routes.ts`)
and its middleware (`backend/src/webhooks/webhook-middleware.ts`). Notification
deduplication for in-app, email and receipt records is already covered by
`backend/src/notifications/notification-service.ts` (`dedupKey`) and
`backend/src/notifications/delivery-receipt.ts` (#387).

## Behavior

| Path | Result | Event ID reserved? |
| --- | --- | --- |
| Missing headers | 400 `MALFORMED_WEBHOOK` | No |
| Timestamp outside tolerance | 408 `STALE_TIMESTAMP` | No |
| Bad or wrong-secret signature | 401 `INVALID_SIGNATURE` | No |
| First valid delivery | handled, 200 | Yes |
| Duplicate while reserved | 409 `DUPLICATE_EVENT` | n/a |
| Handler throws | 500 `WEBHOOK_HANDLER_FAILED`, `retryable: true` | Released |
| Redelivery after release | handled, 200 | Yes |
| Redelivery after replay window | handled, 200 | Yes (old entry evicted) |

Signature and timestamp checks run before the replay check, so forged traffic
cannot burn a real event ID.

## Edge cases

- Replay state is in-process (`MemoryReplayStore`, default 5 minute window, 10,000
  entries). Across multiple instances or restarts, duplicates can get through.
  Use the durable idempotency store via `processWebhook`
  (`backend/src/webhooks/process-webhook.ts`) for that; it has a 7 day TTL.
- A redelivery that arrives after the 5 minute replay window is accepted again
  if its timestamp is still within the 5 minute tolerance. Narrowing that gap
  needs a longer window or a durable store.
- Capacity eviction drops the oldest ID first; under heavy load an evicted ID
  can be replayed.
- `release` is idempotent and a no-op for unknown IDs. It only affects the event
  ID it was created for.
- Only the route calls `releaseWebhookEvent`. Other mounts of the middleware must
  release on their own failures or the redelivery will get 409.

## Recovery and rollback

- No data migration. `ReplayStore.release` is optional, so custom stores that do
  not implement it keep the old behavior (failed events stay reserved).
- Rollback: revert `backend/src/routes/webhook.routes.ts` to drop the try/catch.
  Event IDs of failed handlers will then stay reserved until the window expires.
- To force a redelivery during an incident, the provider can resend the event
  after the handler has failed (the release happens automatically on the 500 path).
  If the process restarted, the in-memory reservation is gone and the redelivery
  is accepted.

## Tests

`backend/tests/webhook-replay-release.test.ts` covers normal, duplicate, failure
and retry, authorization (forged, stale, wrong secret), and replay-window expiry
paths. Tests are written but were not run.
