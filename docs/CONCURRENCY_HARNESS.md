# Multi-Actor Concurrency Harness

A seeded, deterministic harness for testing race-prone writes with many
concurrent actors. Complements [CONCURRENCY.md](CONCURRENCY.md), which
describes the locking and optimistic-version mechanisms it exercises.

- **Harness:** `backend/src/concurrency/multi-actor-harness.ts`
- **Scenarios:** `backend/tests/multi-actor-concurrency.test.ts`

## Why

`Promise.all([a(), b()])` only ever exercises the one interleaving the event
loop happens to choose, and it chooses the same one every run. Real races
happen when an actor reads, waits on something (Horizon, the network, a user),
and then writes.

## How it works

```ts
const report = await runConcurrentActors(
  [
    {
      id: 'payer-1',
      retry: { maxAttempts: 5, shouldRetry: (e) => e instanceof ConflictError },
      async run(ctx) {
        const seen = await storage.getInvoiceById(id);
        await ctx.pause();              // where real code awaits I/O
        return storage.cancelInvoice(id, seen!.version);
      },
    },
    // ...more actors
  ],
  { seed: 42 }
);
```

- `ctx.pause()` yields a number of **microtask** ticks drawn from the actor's
  own seeded PRNG. Different seeds → different interleavings.
- Same seed → identical interleaving and identical `report.trace`, so a failing
  seed is a reproducible bug report. `forEachSeed` prefixes failures with
  `[seed N]`.
- `retry` models client retry storms. The harness handles the retries, so
  `report.totalAttempts`, `retry` trace events and `errorCodes` can be asserted.
- Actor errors become outcomes, never thrown, so one actor's failure does not
  hide what the others did.

## Scenarios covered

| Scenario | Invariant |
| --- | --- |
| 10 payers race on one invoice | exactly one settles; version = 2; every lock released |
| one tx hash, two invoices | at most one invoice carries the hash |
| cancel vs. pay with the same expected version | exactly one write wins; losers see `CONFLICT` or "already processed" |
| 12 writers, read-modify-write with OCC + retry | all succeed, no lost update, version = 1 + writers |
| same storm without a version guard | updates **are** lost on some seed — proves the harness finds real races |
| 25 clients retrying against a settled invoice | zero further writes, tx hash unchanged |
| racing approve / reject / finalize / revert on a merge (#253) | one consistent end state; duplicate cancelled at most once; audit chain valid |

Each runs across 30 seeds (≈1 s total).

## Edge cases and limits

- **Determinism needs in-memory dependencies.** Real timers, sockets or
  Postgres reintroduce scheduling the harness does not control. The harness
  still works there, but a seed no longer pins the interleaving.
- **Microtask-only pauses** cannot interleave with code that is entirely
  synchronous between two awaits — which is correct: JavaScript cannot
  interleave there either.
- **Coverage is probabilistic.** 30 seeds explore many but not all
  interleavings. When a race is fixed, add the failing seed to the scenario.

## Recovery when a scenario fails

1. Note the seed from the failure message.
2. Re-run with only that seed (`forEachSeed([N], …)`) and inspect
   `report.trace` — it lists every start, retry, error and note in order.
3. Fix the code under test, not the harness; keep the seed in the suite.

No runtime code depends on the harness, so it has nothing to roll back.
