# Tamper-evident event ledger (#250)

Privileged and financial events are written to a hash-chained, append-only
ledger next to the general audit trail. Code: `backend/src/audit/event-ledger.ts`.
Tests: `backend/tests/event-ledger.test.ts`, `backend/tests/governance-routes.test.ts`.

## What goes in

The process audit store (`auditStore`) mirrors every event whose action is in
`LEDGER_ACTION_CATEGORIES`:

| Category | Actions |
| --- | --- |
| `financial` | `INVOICE_CREATED`, `INVOICE_CANCELLED`, `INVOICE_EXPIRED`, `PAYMENT_VERIFIED`, `PAYMENT_SIMULATED` |
| `privileged` | `PROOF_EXPORTED`, `MAINTAINER_ACTION`, `IMPERSONATION_*`, `CAPABILITY_ISSUED`, `CONFIG_CHANGED` (includes rollout and kill-switch changes), `LEDGER_RESEALED` |

Routine events stay in the audit trail only. Payloads are passed through the
same secret sanitizer as the audit trail before they are hashed, so a secret
can never become part of the permanent chain.

## Entry format

```json
{
  "sequence": 42,
  "recordedAt": "2026-03-01T12:00:00.000Z",
  "clockSkewMs": 1200,
  "category": "financial",
  "action": "PAYMENT_VERIFIED",
  "actor": { "type": "payer", "id": "G…" },
  "subject": { "type": "invoice", "id": "…" },
  "payload": { "reason": null, "beforeState": {}, "afterState": {}, "metadata": null, "auditHash": "…" },
  "sourceEventId": "audit event uuid",
  "correlationId": "req-…",
  "previousHash": "hash of entry 41",
  "hash": "sha256(canonical JSON of every field above)"
}
```

- `sequence` starts at 1 and increases by exactly one.
- Entry 1's `previousHash` is the genesis hash (`"0" × 64`).
- `hash` is SHA-256 over the canonical serialization (`security/canonical-serialization.ts`)
  of every other field. Any verifier that canonicalizes the same way gets the same hash.
- `recordedAt` never goes backwards. If the wall clock steps back, the entry
  reuses the previous timestamp and records `clockSkewMs`.
- `clockSkewMs` only appears when it is needed. Backfilled entries carry
  `payload.backfilled: true` and `payload.originalTimestamp`.

## What verification detects

`verifyLedgerExport(doc, { expectedHead })` needs only the exported document:

| Tampering | Reported as |
| --- | --- |
| Edited field | `entry_hash` at that entry |
| Edited field, attacker recomputes that entry's hash | `previous_hash` at the next entry |
| Deleted entry | `sequence_gap` (or `previous_hash` if sequences were renumbered) |
| Inserted or reordered entry | `sequence_gap` |
| Backdated entry | `time_regression` (or a hash failure) |
| Wrong `head` / `entryCount` in the document | `head_mismatch` / `count_mismatch` |
| Truncated tail | `head_mismatch`, **only with `expectedHead`** |
| Foreign or malformed document | `schema` (never throws) |

A chain cut cleanly at the end is self-consistent, so **record the head
somewhere outside the process** (a ticket, a release note, a monitoring
system) and pass it as `expectedHead`.

## Operating it

All routes need the admin token (`Authorization: Bearer $JOBS_ADMIN_TOKEN`).

```bash
# Status: head, anchor, compromised flag, deferred count
curl -s -H "Authorization: Bearer $T" $API/api/ops/ledger | jq .data

# Verify the live chain
curl -s -H "Authorization: Bearer $T" $API/api/ops/ledger/verify | jq .data

# Archive a range (json or ndjson); a partial export carries its own anchor
curl -s -H "Authorization: Bearer $T" "$API/api/ops/ledger/export?toSequence=5000" > ledger-1-5000.json
```

Verify an archive offline:

```ts
import { verifyLedgerExport } from './src/audit/event-ledger';
const result = verifyLedgerExport(JSON.parse(fs.readFileSync('ledger-1-5000.json', 'utf8')), {
  expectedHead: { sequence: 5000, hash: '<head you recorded>' },
});
```

## Failure modes and recovery

| Situation | Behaviour | What to do |
| --- | --- | --- |
| Live chain fails verification | Ledger is marked **compromised**. Appends and pruning are refused. Audit writes still succeed: the mirrored events are **deferred**, not lost. | 1. Export the full ledger and keep it as evidence (the break stays visible in it). 2. Investigate. 3. `POST /api/ops/ledger/reseal {actorId, reason}`. This appends `LEDGER_RESEALED` with the finding and backfills deferred events in order. An export from the reseal sequence onward verifies. |
| Ledger full (`maxEntries`, default 100,000) | New events are deferred; nothing is evicted silently. | Export the oldest range, then `POST /api/ops/ledger/prune {throughSequence, confirmHash}`, where `confirmHash` is the archive's `head.hash`. Deferred events are backfilled after pruning. |
| Deferral queue overflows (10,000 events) | Further events are counted in `deferredDropped`. They are still in the audit trail (with `auditHash`). | Treat any non-zero `deferredDropped` as an incident. Reconcile from the audit trail export. |
| Wall clock goes backwards | Entry keeps the previous timestamp and records `clockSkewMs`. | None. Investigate NTP if it is frequent. |
| Process restart | The ledger, like the audit trail, is in memory and starts from genesis again. | Export before planned restarts and keep the archives. Each restart begins a new chain, which an archive's head identifies. |

Rollback: the ledger is additive. To disable it, construct `auditStore`
without `{ ledger }` in `audit-service.ts`. No schema, data or API that existed
before is changed. The only side effect on existing behaviour is a bug fix:
`MemoryAuditStore.verifyChain()` now stays valid after the ring buffer evicts
old events (it used to report a broken chain at the first eviction).

## Design notes

- **Synchronous append.** Hashing and pushing happen with no `await` in
  between, so concurrent requests in one process cannot interleave inside an
  append. Concurrency tests check that 200 interleaved appends give a gap-free,
  valid chain.
- **Never fails the caller.** By the time an audit event exists, the action
  (for example a settled on-chain payment) has already happened. Failing the
  request would not undo it, so the ledger defers instead and reports the
  backlog through `status()`.
- **History is never rewritten.** Reseal adds an entry and does not repair
  the old ones. Pruning keeps an anchor, so archives and the live ledger join
  exactly.
- **Durability** is out of scope for this slice. A Postgres-backed store
  should keep the same entry format and `verifyEntries` so archives stay
  compatible.
