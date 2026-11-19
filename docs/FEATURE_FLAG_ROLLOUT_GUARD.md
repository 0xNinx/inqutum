# Feature-flag rollout guard (#256)

Code: `backend/src/config/rollout-guard.ts`. Tests: `backend/tests/rollout-guard.test.ts`.
Builds on [FEATURE_FLAGS.md](FEATURE_FLAGS.md) and [ADMIN_CONFIG_AUDIT.md](ADMIN_CONFIG_AUDIT.md).

A plain flag is on or off for the whole process. The guard adds a **scoped, monitored rollout with automatic rollback and verification**. While no rollout is active, every flag behaves exactly as before.

## Lifecycle

```
start ──► active ──(guardrail breach)──► rolled_back            (verified)
              │                    └──► rollback_unverified     (a check failed)
              ├──(manual rollback)──► rolled_back / rollback_unverified
              └──(complete)────────► completed → promote via env var
```

| Step | Route (admin bearer token) | Notes |
|------|---------------------------|-------|
| Start | `POST /api/ops/rollouts/:flag` `{scope:{percentage, allowList?}, guardrail?, reason}` | Refused unless the baseline is `false`. |
| Signal | `POST /api/ops/rollouts/:flag/outcomes` `{ok, failed}` | Feed from synthetic journeys, smoke checks or dashboards. |
| Roll back | `POST /api/ops/rollouts/:flag/rollback` `{reason}` | Returns 500 if verification fails. |
| Verify | `POST /api/ops/rollouts/:flag/verify` | Re-runs the checks. 409 if inconsistent. |
| Complete | `POST /api/ops/rollouts/:flag/complete` | Then set the env var and restart. |
| List | `GET /api/ops/rollouts` | Shows the window, status and verification. |

**Scope.** The allow-list (seller public keys) always gets the flag. Other subjects get it when `sha256(flag:subject)` falls in the first `percentage` percent, which is deterministic and sticky. Callers with no subject get the baseline.

**Guardrail** (defaults): `minSamples: 20`, `maxFailureRate: 0.05`, `windowSize: 100`. Once at least `minSamples` outcomes are in the window and the failure rate exceeds `maxFailureRate`, the guard rolls back on its own and records a `CONFIG_CHANGED` event with `actor.type = "system"`.

**Wired call site.** `paymentAmountTolerance` is evaluated per seller: `amountsMatch(actual, expected, sellerPublicKey)` in `services/payment-verification.ts`.

## Rollback verification

After every rollback the guard checks four things and stores the result on the rollout:

| Check | Fails when |
|-------|-----------|
| `no_active_scope` | The rollout scope is still active. |
| `subjects_on_baseline` | Any allow-listed subject, or any of 64 fixed probe subjects spread across buckets, is still served the rolled-out value. |
| `effective_value_is_baseline` | The process value no longer equals the pre-rollout baseline, for example because someone set the env var or a runtime override to `true` during the rollout. |
| `rollback_evidence_recorded` | No rollback audit event id is recorded. |

If any check fails, the status is `rollback_unverified` and each check carries a plain explanation.

## Edge cases and failure modes

- **Audit store unavailable at start.** 503 `ROLLOUT_AUDIT_UNAVAILABLE`. Nothing starts.
- **Audit store unavailable at automatic rollback.** The rollout stays `active` and the next outcome retries the rollback. Use the kill switch below in the meantime.
- **Kill switch.** A runtime override of `false` (`PUT /api/ops/config/feature-flags/:flag`, audited) disables the flag for every subject, cohort included, immediately.
- **Flag already on.** 409 `ROLLOUT_BASELINE_ENABLED`. There is nothing to roll out, and rolling back would not return to `false`.
- **Env var changed mid-rollout.** Rollback reports `rollback_unverified` with `effective_value_is_baseline` and `subjects_on_baseline` failing. Restore the env var (or clear the override), restart if needed, then call `/verify`. The status becomes `rolled_back` once every check passes.
- **Too few samples.** No action until `minSamples` outcomes are in the window. That prevents rollback on one unlucky request.
- **Multiple instances.** Rollouts are process-local, like admin-config overrides. Start the same rollout on each instance, or feed outcomes to each. A restart drops the rollout and the env value applies again. That is itself a safe rollback.
- **Effects already applied.** Rolling back changes future decisions only. Invoices settled under the tolerance stay `PAID` (see FEATURE_FLAGS.md). Their `paymentTxHash` points at the exact on-chain amount.

## Recovery

1. `GET /api/ops/rollouts` and read `rollback.verification.checks`.
2. Fix what the failing check names: env var, runtime override, or audit store.
3. `POST /api/ops/rollouts/:flag/verify` until it returns 200.
4. As a last resort, restart the instance. All rollout state is dropped and the env value applies.

Reverting the feature is a code revert. `isFeatureEnabled` is unchanged, and with no rollout active `isEnabledFor` returns the same value.
