# Feature rollout guardrails and emergency disablement (#309)

Staged, percentage-based rollouts for the flags in
[FEATURE_FLAGS.md](FEATURE_FLAGS.md), with guardrails against unsafe ramps and
a kill switch that always works. Code: `backend/src/config/feature-rollout.ts`,
`backend/src/config/feature-flags.ts`. Tests: `backend/tests/feature-rollout.test.ts`,
`backend/tests/governance-routes.test.ts`.

## How a flag is evaluated

```
kill switch engaged      -> safe default (always off today)
else runtime override    -> override value            (ADMIN_CONFIG_AUDIT.md)
else rollout configured  -> stable bucket < percentage
else                     -> environment / safe default (unchanged behaviour)
```

- A flag that has never had a rollout behaves exactly as before. Existing
  callers of `isFeatureEnabled(flag)` need no change.
- `isFeatureEnabledFor(flag, subjectKey)` buckets a subject (a wallet or an
  invoice id) with `sha256(flag:subject) mod 10000`. The same subject keeps its
  bucket, so ramping up only adds subjects and never turns one back off.
- Subject-less `isFeatureEnabled(flag)` treats a partial rollout as **off**:
  only 100% enables it there.
- Once a rollout is configured it takes over from the environment. To hand
  control back, end it with `percentage: null`, which is only allowed when the
  rollout already equals the environment value (0% or 100%).

## Guardrails

| Guardrail | Default | Error |
| --- | --- | --- |
| Max increase per step | 25 points | `422 ROLLOUT_STEP_TOO_LARGE` |
| Soak time before the next increase | 15 min | `409 ROLLOUT_SOAK_INCOMPLETE` |
| Error-rate trip | > 5% over the last 500 outcomes, at least 50 samples | Kill switch engages automatically. Increases get `409 ROLLOUT_GUARDRAIL_BREACHED`. |
| Optimistic concurrency | `expectedVersion` must match | `409 ROLLOUT_VERSION_CONFLICT` |
| Kill switch engaged | Ramps refused | `409 ROLLOUT_KILLED` |

Decreases (rollbacks) are never limited by step size or soak time. Every
change resets the health window, so each stage is judged on its own traffic.

Code that runs behind a flag reports its outcomes:

```ts
featureRollout.recordOutcome('paymentAmountTolerance', { ok: verification.ok });
```

> Not wired into any code path in this slice. `paymentAmountTolerance` is
> evaluated without a subject today, so it only turns on at 100%. Wiring
> `isFeatureEnabledFor` and `recordOutcome` into a call site is a follow-up for
> the team that owns that path.

## Who may do what

| Action | Roles | HTTP |
| --- | --- | --- |
| Read state | any admin | `GET /api/ops/rollouts` |
| Ramp, or end a rollout | `maintainer` (capability `config.feature_flag.rollout`) | `PUT /api/ops/rollouts/:flag` |
| Emergency disable | `maintainer`, `operator`, `system` (guardrail) | `POST /api/ops/rollouts/:flag/emergency-disable` (admin token only) |
| Clear the kill switch | `maintainer` (capability) | `DELETE /api/ops/rollouts/:flag/kill-switch` |

Emergency disable deliberately needs no capability and no version. A
conflicting change or a slow approval must never delay stopping a feature.

## Runbook

**Ramp**

```bash
TOKEN=$(curl -s -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"action":"config.feature_flag.rollout","target":"paymentAmountTolerance","subject":"alice"}' \
  $API/api/ops/capabilities | jq -r .data.token)
curl -s -X PUT -H "Authorization: Bearer $T" -H "X-Capability-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"percentage":10,"expectedVersion":0,"reason":"Stage 1: testnet sellers","requestId":"ramp-1"}' \
  $API/api/ops/rollouts/paymentAmountTolerance
```

**Stop now** (anyone on call with the admin token)

```bash
curl -s -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"actorId":"oncall-bob","reason":"Incident 51: wrong settlements"}' \
  $API/api/ops/rollouts/paymentAmountTolerance/emergency-disable
```

Pressing it again is harmless (`changed: false`). Then make the stop durable by
setting the environment variable off, as in [FEATURE_FLAGS.md](FEATURE_FLAGS.md).
A restart clears the in-memory kill switch, and the environment applies again.

**Re-enable after the incident**: `DELETE /api/ops/rollouts/:flag/kill-switch`
with the current `expectedVersion` and a reason. The rollout restarts at **0%**
and must be ramped again through the guardrails.

## Failure, retry and edge cases

| Case | Behaviour |
| --- | --- |
| Audit store down during a ramp or clear | Refused with `503 ROLLOUT_AUDIT_UNAVAILABLE`. Nothing is applied. Retry later. |
| Audit store down during an emergency disable | **The disable still applies.** Evidence is queued (`pendingEvidence` in `GET /api/ops/rollouts`). Retry with `POST /api/ops/rollouts/evidence/flush`. Clearing the kill switch is refused while evidence is pending. |
| Same request sent twice (network retry) | With the same `requestId`, the second call returns the first result with `replayed: true` and applies nothing. A stale `expectedVersion` on the retry is not a conflict. |
| `requestId` reused for a different change | `409 ROLLOUT_REQUEST_REUSED`. |
| Failed request retried with the same `requestId` | Failures are not remembered, so it is re-evaluated. |
| Many concurrent identical requests | Exactly one applies. All changes are synchronous within the process. |
| Process restart | Rollout state, kill switches and pending evidence are in memory and lost, like runtime overrides. The environment applies again. Make emergency stops durable in the environment. |
| Multiple instances | State is per process. Run the emergency disable against every instance, or rely on the environment change plus restart. A shared store is a follow-up. |

Every ramp, clear and disable writes a `CONFIG_CHANGED` audit event
(`scope.entityId: rollouts.<flag>`, `metadata.change`). That event is also
mirrored into the tamper-evident ledger ([EVENT_LEDGER.md](EVENT_LEDGER.md)).

## Migration and rollback

No migration. The new state starts empty, so existing flags evaluate exactly as
before until someone configures a rollout. To roll the feature back, end each
rollout (`percentage: null`) or restart the process. Removing the
`/ops/rollouts` routes and the new branches in `isFeatureEnabled` restores the
previous code path.
