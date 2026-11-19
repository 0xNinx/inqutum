/**
 * Multi-actor concurrency harness for race-prone mutations (#243).
 *
 * `Promise.all` over a handful of calls only ever exercises one interleaving:
 * the one the event loop happens to pick, which is the same one every run. Real
 * races come from actors that read, wait on something (Horizon, the network, a
 * user), and then write. This harness makes those waits explicit and seeded:
 *
 *   - Each actor receives `ctx.pause()`. Every call yields for a number of
 *     microtask ticks drawn from that actor's seeded PRNG, so different seeds
 *     produce different interleavings of the same scenario.
 *   - The same seed always produces the same interleaving and the same trace,
 *     so a failing seed is a reproducible bug report, not a flake.
 *   - Retries are part of the harness, not the scenario: a `RetryPolicy`
 *     decides which errors are retried and how often, which is how retry
 *     storms (many actors hammering the same row after conflicts) are modelled.
 *
 * Only microtasks are used — no timers — so a scenario over in-memory storage
 * runs in milliseconds and is fully deterministic. Scenarios that touch real
 * I/O can still use the harness, but lose the determinism guarantee.
 */

export interface ActorContext {
  actorId: string;
  /** 1-based attempt number; > 1 means this is a retry. */
  attempt: number;
  /** Yield a seeded number of microtask ticks. Put one wherever a real call would await I/O. */
  pause(): Promise<void>;
  /** This actor's seeded PRNG, in [0, 1). */
  random(): number;
  /** Append a note to the shared trace. */
  note(detail: string): void;
}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  shouldRetry(error: unknown, attempt: number): boolean;
}

export interface ActorSpec<T> {
  id: string;
  run(ctx: ActorContext): Promise<T>;
  retry?: RetryPolicy;
}

export type TraceEvent = {
  seq: number;
  actorId: string;
  attempt: number;
  event: 'start' | 'ok' | 'error' | 'retry' | 'note';
  detail?: string;
};

export interface ActorOutcome<T> {
  actorId: string;
  ok: boolean;
  value?: T;
  error?: unknown;
  /** `code` if the error has one, else its name. */
  errorCode?: string;
  attempts: number;
}

export interface HarnessReport<T> {
  seed: number;
  outcomes: ActorOutcome<T>[];
  trace: TraceEvent[];
  succeeded: number;
  failed: number;
  totalAttempts: number;
  /** Count of failed outcomes per error code. */
  errorCodes: Record<string, number>;
}

export interface HarnessOptions {
  seed: number;
  /** Upper bound (exclusive) on ticks per pause. Default 8. */
  maxPauseTicks?: number;
}

/** mulberry32: tiny, fast, good enough to explore interleavings. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'UNKNOWN';
}

async function yieldTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/**
 * Starts every actor in the same tick and waits for all of them. Actor
 * failures are captured as outcomes, never thrown, so one actor's error does
 * not hide what the others did.
 */
export async function runConcurrentActors<T>(
  actors: readonly ActorSpec<T>[],
  options: HarnessOptions
): Promise<HarnessReport<T>> {
  const maxPauseTicks = Math.max(1, options.maxPauseTicks ?? 8);
  const trace: TraceEvent[] = [];
  let seq = 0;
  const push = (event: Omit<TraceEvent, 'seq'>) => trace.push({ seq: seq++, ...event });

  const runActor = async (spec: ActorSpec<T>, index: number): Promise<ActorOutcome<T>> => {
    // Per-actor streams keep one actor's draws independent of how often others pause.
    const random = seededRandom((options.seed * 0x9e3779b1 + index * 0x85ebca6b) >>> 0);
    const maxAttempts = Math.max(1, spec.retry?.maxAttempts ?? 1);
    await yieldTicks(Math.floor(random() * maxPauseTicks));

    for (let attempt = 1; ; attempt++) {
      const ctx: ActorContext = {
        actorId: spec.id,
        attempt,
        pause: () => yieldTicks(Math.floor(random() * maxPauseTicks)),
        random,
        note: (detail) => push({ actorId: spec.id, attempt, event: 'note', detail }),
      };
      push({ actorId: spec.id, attempt, event: 'start' });
      try {
        const value = await spec.run(ctx);
        push({ actorId: spec.id, attempt, event: 'ok' });
        return { actorId: spec.id, ok: true, value, attempts: attempt };
      } catch (error) {
        const code = errorCode(error);
        const retry = attempt < maxAttempts && (spec.retry?.shouldRetry(error, attempt) ?? false);
        push({ actorId: spec.id, attempt, event: retry ? 'retry' : 'error', detail: code });
        if (!retry) return { actorId: spec.id, ok: false, error, errorCode: code, attempts: attempt };
        await yieldTicks(Math.floor(random() * maxPauseTicks));
      }
    }
  };

  const outcomes = await Promise.all(actors.map((spec, index) => runActor(spec, index)));
  const errorCodes: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (!outcome.ok) errorCodes[outcome.errorCode!] = (errorCodes[outcome.errorCode!] ?? 0) + 1;
  }

  return {
    seed: options.seed,
    outcomes,
    trace,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    totalAttempts: outcomes.reduce((sum, o) => sum + o.attempts, 0),
    errorCodes,
  };
}

/**
 * Runs a scenario once per seed. `check` should throw (e.g. via `assert`) when
 * an invariant breaks; the seed is attached to the error so the failing
 * interleaving can be replayed exactly.
 */
export async function forEachSeed(
  seeds: readonly number[],
  scenario: (seed: number) => Promise<void>
): Promise<void> {
  for (const seed of seeds) {
    try {
      await scenario(seed);
    } catch (error) {
      if (error instanceof Error) error.message = `[seed ${seed}] ${error.message}`;
      throw error;
    }
  }
}

export function seedRange(count: number, start = 1): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}
