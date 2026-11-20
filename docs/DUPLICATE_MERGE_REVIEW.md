# Duplicate Detection and Merge Review

Finds duplicate PENDING invoices (double-submitted forms, replayed imports)
and retires them through a reviewed, audited workflow.

- **Detection (pure):** `backend/src/domain/duplicate-detection.ts`
- **Workflow:** `backend/src/ops/duplicate-merge-review.service.ts`
- **Tests:** `backend/tests/duplicate-merge-review.test.ts`,
  `backend/tests/multi-actor-concurrency.test.ts` (racing reviewers)

## Detection

Two invoices are candidates when they share a **fingerprint** and were created
within `windowMs` (default 24 h) of a neighbour in the same group.

| Fingerprint field | Normalisation |
| --- | --- |
| `sellerPublicKey` | exact |
| `assetCode`, `assetIssuer` | exact (`XLM` when absent) |
| `amount` | fixed to 7 decimals (Stellar precision) |
| `customerEmail` | NFKC, trimmed, lowercased |
| `description` | NFKC, trimmed, whitespace collapsed, lowercased |

Detection is deterministic: no clock, no randomness, input order does not
matter, and `candidateId` is a content hash of fingerprint + survivor +
duplicates. The same data always yields the same candidates with the same ids.

**Survivor choice:** a `PAID` invoice if the cluster has one, otherwise the
oldest live invoice (ties broken by id). Only `PENDING` invoices are ever
proposed as duplicates; `EXPIRED` / `CANCELLED` members are listed in
`memberIds` but are already inert.

## Workflow

```
PROPOSED --approve--> APPLIED --finalize--> FINALIZED   (irreversible)
   |                     |
   +--reject--> REJECTED +--revert--> REVERTED
   |
   +--(data moved on)--> STALE
```

| Step | Touches invoices? | Reversible? | Guard |
| --- | --- | --- | --- |
| `propose` | no | – | every invoice re-read; fingerprint must still match; no invoice in another active proposal |
| `approve` | no | yes (`revert`) | reviewer ≠ proposer; duplicates must be `PENDING` at the proposed version, else `STALE` |
| `reject` | no | – | only from `PROPOSED` |
| `revert` | no | – | only from `APPLIED`, not while finalizing |
| `finalize` | **cancels duplicates** | **no** | cancels with the version captured at proposal (`cancelInvoice(id, version)`) |

`APPLIED` only records the merge (`retiredInto(id)` returns the survivor), so it
can be undone at no cost. Cancelling is the one destructive step and is a
separate, explicit call.

### Audit

Every transition writes one audit event **per involved invoice** (survivor and
each duplicate) with action `DUPLICATE_MERGE_*`, `correlationId` = proposal id,
`beforeState` / `afterState` = merge status, and the proposal, candidate,
survivor and finalize outcomes in `metadata`. Each invoice's timeline therefore
shows the whole merge history.

## Edge cases and failure modes

| Situation | Behaviour |
| --- | --- |
| No customer email **and** no description | Not fingerprinted (`skippedInsufficientSignal`). Same seller + same amount alone is a repeat charge, not a duplicate. |
| Two `PAID` invoices in one cluster | Reported in `conflicts` (`multiple_settled`), never proposed. The customer paid twice — this is a refund case for a human. |
| Duplicate paid between propose and approve | Approve marks the proposal `STALE` and throws `STALE_CANDIDATE`. |
| Duplicate paid between approve and finalize | Finalize records `skipped_paid` for it and never cancels it. Follow up with a refund. |
| Duplicate changed version before finalize | Outcome `conflict`; proposal stays `APPLIED`. Revert and re-propose from a fresh scan. |
| Finalize crashes or one cancel fails half way | Already-cancelled duplicates keep outcome `cancelled`; re-running `finalize` only processes the rest. |
| Two reviewers approve/reject concurrently | State is re-checked after every await; exactly one wins, the others get `INVALID_TRANSITION`. |
| Concurrent `finalize` calls | Second gets `FINALIZE_IN_PROGRESS`. |
| Process restart | Proposals are in memory. `PROPOSED`/`APPLIED` proposals are lost, which is safe (no invoice was touched); re-scan and re-propose. `FINALIZED` effects are in storage and in the audit trail. |

## Rollback / recovery

- **Before finalize:** `revert(proposalId, actor, reason)`. Nothing to restore.
- **After finalize:** cancelled invoices cannot be reinstated (`CANCELLED` is
  terminal by design). Create a new invoice for the customer; the audit trail
  (`DUPLICATE_MERGE_FINALIZED` with `finalizeOutcomes`) lists exactly which ids
  were cancelled.
- **Disabling the feature:** nothing calls the service automatically. Stop
  calling it; there is no schema change and no public API change to roll back.

## Compatibility

No HTTP routes, schemas or storage contracts changed. Five audit actions were
added to the `AuditAction` union; existing consumers that switch on action
ignore unknown values.
