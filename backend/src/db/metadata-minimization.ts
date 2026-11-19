/**
 * Data minimization review and retention enforcement for operational
 * metadata (#246).
 *
 * `invoices.metadata` is free-form JSONB. Imports, integrations and clients
 * put whatever they like in it: order references the seller needs forever,
 * but also IP addresses, user agents, request ids and, occasionally, things
 * that must never have been stored at all (tokens, card numbers). Row-level
 * retention (`retention.ts`) decides when a whole invoice may go; it says
 * nothing about the fields inside a row that outlive their purpose.
 *
 * Same split as row retention, for the same reason:
 *
 *   METADATA_FIELD_POLICY      what each known key is, how long it lives, why
 *   reviewMetadata()           pure: one metadata object in -> what to drop
 *   planMetadataMinimization() pure: many records in -> a reviewable plan
 *   runMetadataMinimization()  the only code that writes; dry run by default
 *
 * Rules, in order (first match wins):
 *
 *   1. Legal hold (`legal_hold` / `under_dispute` / `under_audit`) pins the
 *      whole object. Nothing is removed; prohibited keys are flagged for a
 *      human instead.
 *   2. `prohibited` keys (credentials, card data) are removed at any age and
 *      at any nesting depth. There is no legitimate reason to hold them.
 *   3. Keys with a window are removed once `created_at + window` has passed.
 *   4. Keys with no window (references, holds) are kept.
 *   5. Unknown keys are kept and reported as `unclassified`. Deleting data we
 *      have not classified would silently break integrations that read it;
 *      the report is how they get classified.
 */

import { hasLegalHold } from './retention';
import type { JobWorker } from '../jobs/worker';

export type MetadataCategory =
  | 'retention_hold'
  | 'business_reference'
  | 'operational'
  | 'network_identifier'
  | 'prohibited';

export interface MetadataFieldRule {
  category: MetadataCategory;
  /** Days after invoice creation. `null` keeps the key for the life of the row; 0 removes it on sight. */
  retainDays: number | null;
  rationale: string;
}

const CATEGORY_DEFAULTS: Record<MetadataCategory, MetadataFieldRule> = {
  retention_hold: {
    category: 'retention_hold',
    retainDays: null,
    rationale: 'Drives row retention and must survive until an operator clears it.',
  },
  business_reference: {
    category: 'business_reference',
    retainDays: null,
    rationale: 'Ties the invoice to the seller’s own records; needed for reconciliation as long as the invoice exists.',
  },
  operational: {
    category: 'operational',
    retainDays: 90,
    rationale: 'Useful for debugging an import or a client release; worthless after the 90-day support window.',
  },
  network_identifier: {
    category: 'network_identifier',
    retainDays: 30,
    rationale: 'Personal data (IP, device, location). Kept 30 days for abuse investigation, then removed.',
  },
  prohibited: {
    category: 'prohibited',
    retainDays: 0,
    rationale: 'Credentials and card data must never be stored. Removed at any age.',
  },
};

const KEYS_BY_CATEGORY: Record<MetadataCategory, readonly string[]> = {
  retention_hold: ['legal_hold', 'under_dispute', 'under_audit'],
  business_reference: ['order', 'order_id', 'reference', 'external_id', 'po_number', 'invoice_number', 'project'],
  operational: ['source', 'channel', 'import_batch', 'import_line', 'client_version', 'correlation_id', 'request_id'],
  network_identifier: ['ip', 'ip_address', 'user_agent', 'device_id', 'session_id', 'geo', 'location'],
  prohibited: [
    'password', 'secret', 'token', 'access_token', 'api_key', 'private_key', 'secret_key',
    'seed', 'mnemonic', 'authorization', 'card_number', 'pan', 'cvv', 'ssn',
  ],
};

/** Per-key overrides of the category default. */
const KEY_OVERRIDES: Record<string, Partial<MetadataFieldRule>> = {
  idempotency_key: {
    category: 'operational',
    retainDays: 30,
    rationale: 'Only meaningful while a client might still retry; 30 days is far beyond any retry window.',
  },
};

export const METADATA_FIELD_POLICY: Readonly<Record<string, MetadataFieldRule>> = Object.freeze(
  Object.fromEntries([
    ...(Object.entries(KEYS_BY_CATEGORY) as Array<[MetadataCategory, readonly string[]]>).flatMap(([category, keys]) =>
      keys.map((key) => [key, CATEGORY_DEFAULTS[category]] as const)
    ),
    ...Object.entries(KEY_OVERRIDES).map(([key, override]) => [
      key,
      { ...CATEGORY_DEFAULTS[override.category ?? 'operational'], ...override },
    ]),
  ])
);

/** `ipAddress`, `IP-Address` and `ip address` all classify as `ip_address`. */
export function normalizeMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

export function classifyMetadataKey(key: string): MetadataFieldRule | null {
  return METADATA_FIELD_POLICY[normalizeMetadataKey(key)] ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 8;

export type RemovalReason = 'prohibited' | 'retention_expired';

export interface MetadataRemoval {
  /** Dotted path, e.g. `integration.api_key`. Values are never reported. */
  path: string;
  category: MetadataCategory;
  reason: RemovalReason;
}

export interface MetadataReview {
  id: string;
  changed: boolean;
  /** Minimized object to write back. Equal to the input when nothing changed. */
  next: Record<string, unknown>;
  removed: MetadataRemoval[];
  /** Top-level keys no rule covers. Kept; listed so they can be classified. */
  unclassified: string[];
  /** Set when a hold pinned the object. */
  held: boolean;
  /** Prohibited paths left in place because of a hold. Escalate these. */
  prohibitedUnderHold: string[];
  /** Earliest instant a currently kept key becomes removable, or null. */
  nextReviewAt: string | null;
}

export interface MetadataRecord {
  id: string;
  /** Age anchor: the invoice `created_at`. */
  createdAt: string | Date;
  metadata: Record<string, unknown> | null | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes prohibited keys below the top level, recording each path. */
function stripNestedProhibited(value: unknown, path: string, removed: MetadataRemoval[], depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => stripNestedProhibited(item, `${path}[${index}]`, removed, depth + 1));
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = `${path}.${key}`;
    if (classifyMetadataKey(key)?.category === 'prohibited') {
      removed.push({ path: childPath, category: 'prohibited', reason: 'prohibited' });
      continue;
    }
    out[key] = stripNestedProhibited(value[key], childPath, removed, depth + 1);
  }
  return out;
}

function findProhibitedPaths(value: unknown, path: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findProhibitedPaths(item, `${path}[${i}]`, depth + 1));
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const childPath = path ? `${path}.${key}` : key;
      return classifyMetadataKey(key)?.category === 'prohibited'
        ? [childPath]
        : findProhibitedPaths(value[key], childPath, depth + 1);
    });
}

/**
 * Pure: the same record and clock always produce the same review. An
 * unparseable `createdAt` disables age-based removal (prohibited keys are
 * still removed): age we cannot prove is not age.
 */
export function reviewMetadata(record: MetadataRecord, now: Date = new Date()): MetadataReview {
  const input = isPlainObject(record.metadata) ? record.metadata : {};
  const base: MetadataReview = {
    id: record.id,
    changed: false,
    next: input,
    removed: [],
    unclassified: [],
    held: false,
    prohibitedUnderHold: [],
    nextReviewAt: null,
  };

  if (hasLegalHold(input)) {
    return { ...base, held: true, prohibitedUnderHold: findProhibitedPaths(input, '', 0) };
  }

  const anchor = new Date(record.createdAt).getTime();
  const ageKnown = Number.isFinite(anchor);
  const removed: MetadataRemoval[] = [];
  const unclassified: string[] = [];
  const next: Record<string, unknown> = {};
  let nextReview = Infinity;

  for (const key of Object.keys(input).sort()) {
    const rule = classifyMetadataKey(key);
    if (!rule) {
      unclassified.push(key);
      next[key] = stripNestedProhibited(input[key], key, removed, 1);
      continue;
    }
    if (rule.category === 'prohibited') {
      removed.push({ path: key, category: rule.category, reason: 'prohibited' });
      continue;
    }
    if (rule.retainDays !== null && ageKnown) {
      const expiresAt = anchor + rule.retainDays * DAY_MS;
      if (now.getTime() >= expiresAt) {
        removed.push({ path: key, category: rule.category, reason: 'retention_expired' });
        continue;
      }
      nextReview = Math.min(nextReview, expiresAt);
    }
    next[key] = stripNestedProhibited(input[key], key, removed, 1);
  }

  return {
    ...base,
    changed: removed.length > 0,
    next: removed.length > 0 ? next : input,
    removed,
    unclassified,
    nextReviewAt: Number.isFinite(nextReview) ? new Date(nextReview).toISOString() : null,
  };
}

export interface MetadataMinimizationPlan {
  generatedAt: string;
  reviewed: number;
  changes: MetadataReview[];
  held: string[];
  /** Records holding prohibited data that a hold stopped us removing. */
  escalations: Array<{ id: string; paths: string[] }>;
  removedByCategory: Partial<Record<MetadataCategory, number>>;
  /** Unknown keys and how many records carry each. Classify the frequent ones. */
  unclassifiedKeys: Record<string, number>;
}

/** Pure, order-independent summary of what a run would remove. */
export function planMetadataMinimization(
  records: readonly MetadataRecord[],
  now: Date = new Date()
): MetadataMinimizationPlan {
  const reviews = records.map((record) => reviewMetadata(record, now)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const removedByCategory: MetadataMinimizationPlan['removedByCategory'] = {};
  const unclassifiedKeys: Record<string, number> = {};

  for (const review of reviews) {
    for (const removal of review.removed) {
      removedByCategory[removal.category] = (removedByCategory[removal.category] ?? 0) + 1;
    }
    for (const key of review.unclassified) unclassifiedKeys[key] = (unclassifiedKeys[key] ?? 0) + 1;
  }

  return {
    generatedAt: now.toISOString(),
    reviewed: reviews.length,
    changes: reviews.filter((review) => review.changed),
    held: reviews.filter((review) => review.held).map((review) => review.id),
    escalations: reviews
      .filter((review) => review.prohibitedUnderHold.length > 0)
      .map((review) => ({ id: review.id, paths: review.prohibitedUnderHold })),
    removedByCategory,
    unclassifiedKeys,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface MetadataDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface MetadataRunOptions {
  dryRun?: boolean;
  now?: Date;
  /** Rows read per page. Bounds memory regardless of table size. */
  batchSize?: number;
  /** Stop after this many pages; the next run resumes from `lastId`. */
  maxBatches?: number;
  /** Resume after this invoice id (keyset cursor). */
  afterId?: string;
}

export interface MetadataRunResult {
  dryRun: boolean;
  reviewed: number;
  changed: number;
  updated: number;
  /** Rows whose metadata changed between read and write. Left alone; the next run re-reviews them. */
  skippedConcurrentChange: number;
  held: number;
  escalations: MetadataMinimizationPlan['escalations'];
  removedByCategory: MetadataMinimizationPlan['removedByCategory'];
  unclassifiedKeys: Record<string, number>;
  /** Keyset cursor of the last row read; pass back as `afterId` to resume. */
  lastId: string | null;
  complete: boolean;
}

export const METADATA_MINIMIZATION_JOB = 'metadata.minimize';
const DEFAULT_BATCH_SIZE = 500;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Pages through invoices with non-empty metadata in id order, reviews each
 * page, and — only when `dryRun` is false — writes the minimized object back
 * with a compare-and-set on the old value, so a concurrent edit is never
 * overwritten with a stale copy. Each UPDATE is atomic on its own; a run that
 * dies half way leaves every row either fully minimized or untouched, and
 * re-running converges.
 */
export async function runMetadataMinimization(
  db: MetadataDatabase,
  options: MetadataRunOptions = {}
): Promise<MetadataRunResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxBatches = options.maxBatches ?? Infinity;

  const result: MetadataRunResult = {
    dryRun,
    reviewed: 0,
    changed: 0,
    updated: 0,
    skippedConcurrentChange: 0,
    held: 0,
    escalations: [],
    removedByCategory: {},
    unclassifiedKeys: {},
    lastId: options.afterId ?? null,
    complete: false,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const { rows } = await db.query(
      `SELECT id, created_at, metadata FROM invoices
       WHERE metadata IS NOT NULL AND metadata <> '{}'::jsonb AND id > $1::uuid
       ORDER BY id ASC
       LIMIT $2`,
      [result.lastId ?? NIL_UUID, batchSize]
    );
    if (rows.length === 0) {
      result.complete = true;
      break;
    }

    const records: MetadataRecord[] = rows.map((row) => ({
      id: String(row.id),
      createdAt: row.created_at,
      metadata: row.metadata,
    }));
    const plan = planMetadataMinimization(records, now);
    const originals = new Map(records.map((record) => [record.id, record.metadata]));

    result.reviewed += plan.reviewed;
    result.changed += plan.changes.length;
    result.held += plan.held.length;
    result.escalations.push(...plan.escalations);
    for (const [category, count] of Object.entries(plan.removedByCategory)) {
      const key = category as MetadataCategory;
      result.removedByCategory[key] = (result.removedByCategory[key] ?? 0) + (count ?? 0);
    }
    for (const [key, count] of Object.entries(plan.unclassifiedKeys)) {
      result.unclassifiedKeys[key] = (result.unclassifiedKeys[key] ?? 0) + count;
    }

    if (!dryRun) {
      for (const change of plan.changes) {
        const { rowCount } = await db.query(
          `UPDATE invoices SET metadata = $2::jsonb WHERE id = $1 AND metadata = $3::jsonb`,
          [change.id, JSON.stringify(change.next), JSON.stringify(originals.get(change.id))]
        );
        if ((rowCount ?? 0) > 0) result.updated += 1;
        else result.skippedConcurrentChange += 1;
      }
    }

    result.lastId = String(rows[rows.length - 1].id);
    if (rows.length < batchSize) {
      result.complete = true;
      break;
    }
  }

  return result;
}

/** Dry run unless the payload says `{"dryRun": false}`. Safe to retry: runs are idempotent. */
export function registerMetadataMinimizationJob(worker: JobWorker, deps: { db: MetadataDatabase }): JobWorker {
  return worker.register(METADATA_MINIMIZATION_JOB, async (payload) => {
    const data = (payload?.data ?? {}) as Pick<MetadataRunOptions, 'dryRun' | 'batchSize' | 'maxBatches' | 'afterId'>;
    const result = await runMetadataMinimization(deps.db, data);
    return result as unknown as Record<string, unknown>;
  });
}
