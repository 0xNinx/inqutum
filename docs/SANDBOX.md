# Sandbox mode

Sandbox mode swaps Horizon for a fake with fixed responses, so contributors
can exercise payment verification without network access, wallets or
credentials.

## Setup

```bash
cd backend
INQUTUM_SANDBOX=true node --import tsx --test tests/sandbox.test.ts
```

No `.env` is needed. `assertSandboxSafe()` refuses to run when
`STELLAR_NETWORK=PUBLIC` or when `SELLER_SECRET_KEY` is set.

## Adapter

`backend/src/sandbox/adapters.ts`: `SandboxHorizon` has `getTransaction` and
`verifyPayment` with the same shape as `StellarService`, backed by the
fixtures. Verification runs through the real `verifyHorizonPayment`, so
results match production rules.

## Scenarios

`backend/src/sandbox/fixtures.ts` holds one invoice (`SANDBOX_INVOICE`) and a
transaction per scenario:

| Scenario | Tx hash | Result |
| -------- | ------- | ------ |
| `success` | `1` x 64 | verified |
| `memo_mismatch` | `2` x 64 | `MEMO_MISMATCH` |
| `underpaid` | `3` x 64 | `AMOUNT_MISMATCH` |
| `wrong_destination` | `4` x 64 | `DESTINATION_MISMATCH` |
| `not_found` | `5` x 64 | `TRANSACTION_NOT_FOUND` |

## Malformed payload and replay fixtures (Issue #356)

`backend/src/sandbox/malformed-payload-fixtures.ts` provides deterministic
webhook inputs for rejection and replay tests. They are consumed by
`backend/tests/malformed-payload-replay.test.ts`:

```bash
cd backend
node --import tsx --test tests/malformed-payload-replay.test.ts
```

| Fixture | Expected result |
| ------- | --------------- |
| Missing provider | `400 WEBHOOK_EVENT_ID_INVALID` |
| Missing event id | `400 WEBHOOK_EVENT_ID_INVALID` |
| Oversized event id (256 chars) | `400 WEBHOOK_EVENT_ID_INVALID` |
| Malformed JSON body | `401 WEBHOOK_SIGNATURE_INVALID` |
| Missing signature header | `401 WEBHOOK_SIGNATURE_INVALID` |
| Forged signature | `401 WEBHOOK_SIGNATURE_INVALID` |
| Stale timestamp replay | `401 WEBHOOK_SIGNATURE_INVALID` |
| Duplicate delivery | accepted, `duplicate: true`, handler runs once |
| Same event id, different payload | `422 WEBHOOK_EVENT_ID_CONFLICT` |
| In-flight event id | `409 WEBHOOK_EVENT_IN_PROGRESS` |
| Event-id record older than seven days | `410 WEBHOOK_EVENT_ID_EXPIRED` |

Recovery and rollback:

- Handler failures release the idempotency lock, so a provider retry is
  processed normally. Tests assert the handler runs again and returns a fresh
  response.
- An in-flight lock resolves after the holder completes or releases it; a
  retry then succeeds. Do not delete records manually.
- Expired records are intentionally retained for seven days. A webhook older
  than that must be reconciled from the provider's event log instead of
  replayed.
- Signature and timestamp checks run before the store is touched, so rejected
  payloads leave no idempotency state behind.

## Limitations

- Only the transactions above exist; any other hash is not found.
- Streaming (`streamPayments`) and account lookups are not simulated.
- The sandbox does not start a server by itself. Tests and scripts wire the
  adapters in directly.
