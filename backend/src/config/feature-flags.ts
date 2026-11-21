import { createHash } from 'node:crypto';

type RuntimeEnvironment = Record<string, string | undefined>;

interface FlagDefinition {
  /** Environment variable that controls the flag. */
  env: string;
  /** Used when the variable is unset or unparseable. Always the lower-risk behaviour. */
  safeDefault: boolean;
  description: string;
}

/**
 * Every feature flag the server knows about. Flags are read from the
 * environment on each check, so flipping one needs a restart, not a rebuild.
 * Remove a flag (and its old code path) once its rollout is complete.
 */
export const FEATURE_FLAGS = {
  paymentAmountTolerance: {
    env: 'FEATURE_PAYMENT_AMOUNT_TOLERANCE',
    safeDefault: false,
    description:
      'Accept on-chain payments within ±1 stroop of the invoice amount. Off = exact stroop match.',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

const ON = new Set(['true', '1', 'on']);
const OFF = new Set(['false', '0', 'off']);

/**
 * Process-local runtime overrides. Written only by the audited admin config
 * service (config/admin-config.ts), never directly; lost on restart, when the
 * environment value applies again. See docs/ADMIN_CONFIG_AUDIT.md.
 */
const runtimeOverrides = new Map<FeatureFlag, boolean>();

export const featureFlagOverrides = {
  get: (flag: FeatureFlag): boolean | undefined => runtimeOverrides.get(flag),
  /** `null` clears the override. */
  set: (flag: FeatureFlag, value: boolean | null): void => {
    if (value === null) runtimeOverrides.delete(flag);
    else runtimeOverrides.set(flag, value);
  },
};

/**
 * Rollout state (#309), written only by the rollout controller
 * (config/feature-rollout.ts). Precedence when evaluating a flag:
 *
 *   kill switch (forces the safe default)
 *     > runtime override (admin-config.ts)
 *       > rollout percentage, when one is set
 *         > environment / safe default
 *
 * A flag that never had a rollout configured behaves exactly as before.
 */
const killSwitches = new Set<FeatureFlag>();
const rolloutPercentages = new Map<FeatureFlag, number>();

export const featureFlagKillSwitches = {
  isEngaged: (flag: FeatureFlag): boolean => killSwitches.has(flag),
  set: (flag: FeatureFlag, engaged: boolean): void => {
    if (engaged) killSwitches.add(flag);
    else killSwitches.delete(flag);
  },
};

export const featureFlagRollouts = {
  get: (flag: FeatureFlag): number | undefined => rolloutPercentages.get(flag),
  /** `null` removes the rollout so the environment value applies again. */
  set: (flag: FeatureFlag, percentage: number | null): void => {
    if (percentage === null) rolloutPercentages.delete(flag);
    else rolloutPercentages.set(flag, percentage);
  },
};

/**
 * Stable bucket in [0, 10000) for a subject (wallet, invoice id). The same
 * subject keeps its bucket as the percentage grows, so a ramp only ever adds
 * subjects and never flips an already-enabled one off.
 */
export function rolloutBucket(flag: FeatureFlag, subjectKey: string): number {
  return createHash('sha256').update(`${flag}:${subjectKey}`).digest().readUInt32BE(0) % 10_000;
}

/** The value the environment (or the safe default) gives a flag, ignoring runtime overrides. */
export function environmentFeatureValue(flag: FeatureFlag, env: RuntimeEnvironment = process.env): boolean {
  const definition: FlagDefinition = FEATURE_FLAGS[flag];
  const raw = env[definition.env]?.trim().toLowerCase();
  if (raw && ON.has(raw)) return true;
  if (raw && OFF.has(raw)) return false;
  return definition.safeDefault;
}

/**
 * Without a subject, a partial rollout counts as off: only 100% enables the
 * flag. Use `isFeatureEnabledFor` where a subject is available.
 */
export function isFeatureEnabled(flag: FeatureFlag, env: RuntimeEnvironment = process.env): boolean {
  if (killSwitches.has(flag)) return FEATURE_FLAGS[flag].safeDefault;
  const override = runtimeOverrides.get(flag);
  if (override !== undefined) return override;
  const percentage = rolloutPercentages.get(flag);
  if (percentage !== undefined) return percentage >= 100;
  return environmentFeatureValue(flag, env);
}

/** Like `isFeatureEnabled`, but a partial rollout enables the flag for a stable share of subjects. */
export function isFeatureEnabledFor(flag: FeatureFlag, subjectKey: string, env: RuntimeEnvironment = process.env): boolean {
  if (killSwitches.has(flag)) return FEATURE_FLAGS[flag].safeDefault;
  const override = runtimeOverrides.get(flag);
  if (override !== undefined) return override;
  const percentage = rolloutPercentages.get(flag);
  if (percentage !== undefined) return rolloutBucket(flag, subjectKey) < percentage * 100;
  return environmentFeatureValue(flag, env);
}

/** Effective state of every flag, reported by /api/health for rollout checks. */
export function featureFlagSnapshot(env: RuntimeEnvironment = process.env): Record<FeatureFlag, boolean> {
  return Object.fromEntries(
    (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map(flag => [flag, isFeatureEnabled(flag, env)])
  ) as Record<FeatureFlag, boolean>;
}
