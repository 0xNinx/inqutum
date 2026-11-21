# Export download: requester header (#444)

## Status of the issue

Field-level authorization for invoice exports already exists on the default
branch (#308): `EXPORT_FIELD_POLICY`, `authorizeExportFields`, the 403
`EXPORT_FIELD_FORBIDDEN` response with `deniedFields`, idempotent retries, and
tests in `backend/tests/export-field-authorization.test.ts`. This change does
not duplicate that work. The one remaining gap it addresses is the wallet key
sitting in the download URL.

## What changed

- `GET /api/exports/:id` reads the requester from the `X-Requester` header.
  `?requester=` is still accepted.
- Sending both with different values returns 400 `REQUESTER_MISMATCH`. Sending
  both with the same value is fine.
- `POST /api/exports` keeps `downloadPath` byte for byte. It adds
  `downloadPathNoQuery` and `downloadHeaders` (`{ "X-Requester": "G..." }`).

## Migration

1. Clients switch to `downloadPathNoQuery` plus the `X-Requester` header.
2. Browser clients on another origin need `X-Requester` in the CORS allowed
   headers. This was not checked in this draft; confirm the CORS config.
3. Once clients have moved, `downloadPath` can be dropped in a schema bump.
   That is a separate change.

## Edge cases and recovery

- Malformed header (not a Stellar key, or repeated) returns 400
  `REQUESTER_REQUIRED`. Retry with a valid key.
- Another wallet's artifact id returns 404 `EXPORT_NOT_FOUND`, the same as an
  unknown id. Nothing is revealed.
- Expired artifact returns 410 `EXPORT_EXPIRED`. Generate a new export; the
  idempotency key regenerates under the same key.
- No new storage, no new state. Rollback is reverting the route file; old
  query-string clients are unaffected in both directions.

## Not verified

Tests were written but not run, per the task rules.
