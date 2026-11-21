# Stale Authorization Cleanup & Renewal (#199)

Delegations, approvals and API-access grants expire. This module makes sure
expired grants stop working, cleans them up through an audited job, and renews
them only through a two-person, audited flow.

Source: `backend/src/domain/authorization-lifecycle.ts` · Tests: `backend/tests/authorization-lifecycle.test.ts`

## States

```
active ──(expiresAt passes)──> expired ──(cleanup, after grace)──> cleaned
  │                              │
  │                              └──(request + confirm)──> renewed ──> new active grant
  └──(revoke)──> revoked
```

| State | Stored? | Allows actions? | Renewable? |
| --- | --- | --- | --- |
| `active` | yes | yes | yes |
| `expired` | no. Derived from `expiresAt` at check time | **no** | yes, until cleaned |
| `cleaned` | yes (tombstone, row kept) | no | no. Issue a new grant |
| `renewed` | yes (superseded) | no. The successor grant does | no |
| `revoked` | yes | no | no |

**Expiry is evaluated at check time.** A grant whose `expiresAt` has passed
denies immediately, even if the cleanup job has not run yet. Cleanup is
housekeeping, not a security control.

## Protecting an action

```ts
lifecycle.assertAllowed(subjectId, 'invoice.cancel', { type: 'organization', id: orgId });
// throws AuthorizationLifecycleError AUTHORIZATION_DENIED (403) with reason
// EXPIRED | RENEWED | REVOKED | CLEANED | NO_GRANT
```

Denials caused by a stale grant are audited (`AUTHORIZATION_DENIED`). A plain
`NO_GRANT` is not, so probing cannot flood the audit trail.

## Finding stale authorizations

`findStale()` is read-only. It returns:

- `expired`: past `expiresAt` but still stored `active`, with
  `eligibleForCleanup` once the grace period (default 24 h) has passed;
- `expiringSoon`: active grants inside the renewal window (default 7 days);
- counts per state.

```bash
cd backend
npm run auth:stale            # report + dry-run cleanup over the seed dataset
npm run auth:stale -- --apply # apply in memory and print the audit events written
```

## Cleanup job

- `cleanup({ actor, dryRun })` is a **dry run unless `dryRun: false`** is passed.
- Applying it sets `status: 'cleaned'` and `cleanedAt`, cancels any pending renewal
  request, and writes one `AUTHORIZATION_CLEANED` audit event (before/after state)
  per grant. It is idempotent.
- Only the system job (`role: 'SYSTEM'`) or an OWNER/ADMIN may run it.
- Background job type `authorizations.cleanup-stale` (`AUTHORIZATION_CLEANUP_JOB`).
  Wire it with
  `registerJobHandlers(worker, { ..., cleanupStaleAuthorizations: createAuthorizationCleanupHandler(lifecycle) })`.
  Enqueuing the job is the opt-in, so it applies unless the payload says
  `{ dryRun: true }`. Optional `graceMs` overrides the grace period.

## Renewal (two-step, audited)

1. **Request.** The subject, the grantor, or an org OWNER/ADMIN calls
   `requestRenewal(grantId, { actor, reason, ttlMs? })`. A reason is required.
   The TTL is capped per kind (delegation 90 d, approval 7 d, API access 30 d).
   Only one pending request is allowed per grant. Requests expire after 3 days.
   Audited as `AUTHORIZATION_RENEWAL_REQUESTED`.
2. **Confirm.** A **different** OWNER/ADMIN calls
   `confirmRenewal(requestId, { actor, confirmation: 'RENEW <grantId>' })`.
   The subject and the requester cannot confirm (`RENEWAL_SELF_CONFIRMATION`).
   The old grant becomes `renewed` with `renewedToId`. A new grant is issued
   with `renewedFromId`, `grantedBy = confirmer` and a fresh `issuedAt`/`expiresAt`.
   Audited as `AUTHORIZATION_RENEWED`, with the requester, the new grant id and
   the new expiry.

`rejectRenewal` is audited as `AUTHORIZATION_RENEWAL_REJECTED`. `revoke`
(grantor or OWNER/ADMIN) is audited as `AUTHORIZATION_REVOKED` and cancels any
pending renewal.

Renewal never extends a grant in place. Each period of access is its own
record, so "who could do what, when" can always be reconstructed.

## Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `AUTHORIZATION_DENIED` | 403 | Protected action without an active grant |
| `AUTHORIZATION_FORBIDDEN` | 403 | Actor lacks the role for grant/revoke/cleanup/renew |
| `RENEWAL_SELF_CONFIRMATION` | 403 | Subject or requester tried to confirm |
| `RENEWAL_CONFIRMATION_MISMATCH` | 400 | Wrong confirmation phrase |
| `AUTHORIZATION_INVALID_INPUT` | 400 | Missing reason, TTL outside policy, unknown kind |
| `AUTHORIZATION_NOT_RENEWABLE` | 409 | Grant is revoked, cleaned or already renewed |
| `RENEWAL_ALREADY_PENDING` / `RENEWAL_NOT_PENDING` | 409 | Duplicate request / replayed decision |
| `AUTHORIZATION_INVALID_STATE` | 409 | Revoking a grant that is not active/expired |
| `RENEWAL_REQUEST_EXPIRED` | 410 | Confirmation window elapsed |
| `AUTHORIZATION_NOT_FOUND` / `RENEWAL_REQUEST_NOT_FOUND` | 404 | Unknown id |

## Audit actions added

`AUTHORIZATION_GRANTED`, `AUTHORIZATION_REVOKED`, `AUTHORIZATION_CLEANED`,
`AUTHORIZATION_RENEWAL_REQUESTED`, `AUTHORIZATION_RENEWAL_REJECTED`,
`AUTHORIZATION_RENEWED`, `AUTHORIZATION_DENIED`. All use audit scope
`entityType: 'authorization'`. Events go through the hash-chained
`MemoryAuditStore`, and the tests check that `verifyChain()` still passes.
