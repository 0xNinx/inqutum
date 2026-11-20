/**
 * Tamper-evident chronological ledger for privileged and financial events (#250).
 *
 * The general audit trail (`audit-service.ts`) is a bounded ring buffer that
 * also holds routine activity. This ledger keeps only the events whose loss or
 * alteration matters to a dispute or an incident review, and holds them to a
 * stricter contract:
 *
 *  - Hash chain. Every entry stores the previous entry's hash and its own
 *    SHA-256 hash over the canonical serialization of every other field, so
 *    changing, inserting, deleting or reordering any entry breaks verification.
 *  - Gap-free sequence. `sequence` starts at 1 and increments by exactly one,
 *    so a deleted entry is reported by number, not just as "hash mismatch".
 *  - Chronological. `recordedAt` never goes backwards. When the wall clock
 *    steps back (NTP correction, VM resume) the entry reuses the previous
 *    timestamp and records the skew in `clockSkewMs` instead of failing.
 *  - Anchored pruning. Pruning drops the oldest entries but keeps an anchor
 *    (sequence + hash of the last dropped entry), so the retained suffix and
 *    every export of it still verify. A plain ring buffer loses this.
 *  - Exportable and verifiable offline. `export()` returns the entries with the
 *    anchor and head; `verifyLedgerExport()` needs nothing but that document.
 *    Comparing the head with one recorded elsewhere also catches truncation.
 *  - Fail closed. If self-verification finds a broken chain the ledger is
 *    marked compromised and refuses appends until an operator reseals it,
 *    which writes a LEDGER_RESEALED entry that states what was found. History
 *    is never rewritten.
 *
 * Appends are synchronous: hash, check and push happen without an `await`, so
 * concurrent requests in one process can never interleave inside an append.
 * Durability is process-local, like the audit trail. See docs/EVENT_LEDGER.md.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../security/canonical-serialization';
import { sanitizeForLogging } from '../observability/telemetry';
import type { AuditAction, AuditEvent } from './audit-service';

export const LEDGER_SCHEMA_ID = 'inqutum.event-ledger';
export const LEDGER_SCHEMA_VERSION = 1;
/** previousHash of entry 1. Fixed so independent verifiers agree on the start. */
export const LEDGER_GENESIS_HASH = '0'.repeat(64);

export type LedgerCategory = 'financial' | 'privileged';

/** Audit actions that belong in the ledger. Anything else stays in the audit trail only. */
export const LEDGER_ACTION_CATEGORIES: Partial<Record<AuditAction, LedgerCategory>> = {
  INVOICE_CREATED: 'financial',
  INVOICE_CANCELLED: 'financial',
  INVOICE_EXPIRED: 'financial',
  PAYMENT_VERIFIED: 'financial',
  PAYMENT_SIMULATED: 'financial',
  PROOF_EXPORTED: 'privileged',
  MAINTAINER_ACTION: 'privileged',
  IMPERSONATION_STARTED: 'privileged',
  IMPERSONATION_ENDED: 'privileged',
  IMPERSONATION_REVOKED: 'privileged',
  IMPERSONATION_EXPIRED: 'privileged',
  IMPERSONATION_ACTION_ALLOWED: 'privileged',
  IMPERSONATION_ACTION_BLOCKED: 'privileged',
  CAPABILITY_ISSUED: 'privileged',
  CONFIG_CHANGED: 'privileged',
};

export interface LedgerEntryInput {
  category: LedgerCategory;
  /** Audit action, or a ledger-internal action such as LEDGER_RESEALED. */
  action: string;
  actor: { type: string; id: string };
  subject: { type: string; id: string };
  /** Sanitized before hashing; secrets never enter the chain. */
  payload?: Record<string, unknown>;
  /** Id of the audit event this entry mirrors, when there is one. */
  sourceEventId?: string;
  correlationId?: string;
}

export interface LedgerEntry {
  sequence: number;
  recordedAt: string;
  /** Present only when the clock went backwards and `recordedAt` was held. */
  clockSkewMs?: number;
  category: LedgerCategory;
  action: string;
  actor: { type: string; id: string };
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
  sourceEventId: string | null;
  correlationId: string | null;
  previousHash: string;
  hash: string;
}

export interface LedgerAnchor {
  /** Sequence of the last entry before the first one included (0 at genesis). */
  sequence: number;
  hash: string;
}

export interface LedgerExport {
  schema: typeof LEDGER_SCHEMA_ID;
  schemaVersion: number;
  exportedAt: string;
  anchor: LedgerAnchor;
  head: LedgerAnchor;
  entryCount: number;
  entries: LedgerEntry[];
}

export type LedgerFailureReason =
  | 'schema'
  | 'sequence_gap'
  | 'previous_hash'
  | 'entry_hash'
  | 'time_regression'
  | 'head_mismatch'
  | 'count_mismatch';

export interface LedgerVerification {
  valid: boolean;
  checked: number;
  head: LedgerAnchor;
  failure?: { sequence: number | null; reason: LedgerFailureReason; detail: string };
}

export interface LedgerStatus {
  compromised: boolean;
  size: number;
  /** Audit events waiting for `drainDeferred()`. */
  deferred: number;
  /** Audit events that overflowed the deferral queue; still in the audit trail. */
  deferredDropped: number;
  anchor: LedgerAnchor;
  head: LedgerAnchor;
  failure?: LedgerVerification['failure'];
}

export class LedgerIntegrityError extends Error {
  readonly code = 'LEDGER_COMPROMISED' as const;
  readonly httpStatus = 503;

  constructor(readonly verification: LedgerVerification) {
    super(
      `Ledger failed verification at sequence ${verification.failure?.sequence ?? '?'} (${verification.failure?.reason}); ` +
        'appends are refused until an operator reseals it'
    );
    this.name = 'LedgerIntegrityError';
  }
}

export class LedgerCapacityError extends Error {
  readonly code = 'LEDGER_FULL' as const;
  readonly httpStatus = 503;

  constructor(capacity: number) {
    super(`Ledger holds ${capacity} entries; prune it with an exported anchor before appending more`);
    this.name = 'LedgerCapacityError';
  }
}

/** Audit events held while the ledger cannot accept them. */
const MAX_DEFERRED = 10_000;

export interface EventLedgerOptions {
  now?: () => Date;
  /** Appends beyond this fail closed rather than silently dropping evidence. */
  maxEntries?: number;
}

type HashedFields = Omit<LedgerEntry, 'hash'>;

export function hashLedgerEntry(entry: HashedFields): string {
  return createHash('sha256').update(canonicalize(entry)).digest('hex');
}

const without = <T extends { hash: string }>({ hash: _hash, ...rest }: T): Omit<T, 'hash'> => rest;

/**
 * Verify a run of entries that starts after `anchor`. Shared by the live
 * ledger and the offline verifier so both apply exactly the same rules. O(n).
 */
export function verifyEntries(entries: readonly LedgerEntry[], anchor: LedgerAnchor): LedgerVerification {
  let previous = anchor;
  let previousTime = -Infinity;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fail = (reason: LedgerFailureReason, detail: string): LedgerVerification => ({
      valid: false,
      checked: i + 1,
      head: previous,
      failure: { sequence: Number.isSafeInteger(entry?.sequence) ? entry.sequence : null, reason, detail },
    });
    if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
      return fail('schema', `entry at position ${i} is not a ledger entry`);
    }
    if (entry.sequence !== previous.sequence + 1) {
      return fail('sequence_gap', `expected sequence ${previous.sequence + 1}, found ${entry.sequence}`);
    }
    if (entry.previousHash !== previous.hash) {
      return fail('previous_hash', `previousHash does not match entry ${previous.sequence}`);
    }
    if (entry.hash !== hashLedgerEntry(without(entry))) {
      return fail('entry_hash', 'entry content does not match its hash');
    }
    const time = Date.parse(entry.recordedAt);
    if (!Number.isFinite(time) || time < previousTime) {
      return fail('time_regression', `recordedAt ${entry.recordedAt} is earlier than the previous entry`);
    }
    previousTime = time;
    previous = { sequence: entry.sequence, hash: entry.hash };
  }
  return { valid: true, checked: entries.length, head: previous };
}

/**
 * Verify an exported ledger with no access to the live process. Pass
 * `expectedHead` (published or stored elsewhere) to detect tail truncation,
 * which a self-consistent chain cannot reveal on its own.
 */
export function verifyLedgerExport(doc: unknown, expected: { expectedHead?: LedgerAnchor } = {}): LedgerVerification {
  const empty: LedgerAnchor = { sequence: 0, hash: LEDGER_GENESIS_HASH };
  const schemaFailure = (detail: string): LedgerVerification => ({
    valid: false,
    checked: 0,
    head: empty,
    failure: { sequence: null, reason: 'schema', detail },
  });
  if (!doc || typeof doc !== 'object') return schemaFailure('export is not an object');
  const d = doc as Partial<LedgerExport>;
  if (d.schema !== LEDGER_SCHEMA_ID || d.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    return schemaFailure(`unsupported schema ${String(d.schema)} v${String(d.schemaVersion)}`);
  }
  if (!Array.isArray(d.entries) || !d.anchor || !d.head) return schemaFailure('export is missing entries, anchor or head');
  if (!Number.isSafeInteger(d.anchor.sequence) || d.anchor.sequence < 0 || typeof d.anchor.hash !== 'string') {
    return schemaFailure('anchor is malformed');
  }

  const result = verifyEntries(d.entries, d.anchor);
  if (!result.valid) return result;
  if (d.entryCount !== d.entries.length) {
    return { ...result, valid: false, failure: { sequence: null, reason: 'count_mismatch', detail: `entryCount ${d.entryCount} but ${d.entries.length} entries` } };
  }
  if (d.head.sequence !== result.head.sequence || d.head.hash !== result.head.hash) {
    return { ...result, valid: false, failure: { sequence: result.head.sequence, reason: 'head_mismatch', detail: 'declared head does not match the last entry' } };
  }
  const want = expected.expectedHead;
  if (want && (want.sequence !== result.head.sequence || want.hash !== result.head.hash)) {
    return {
      ...result,
      valid: false,
      failure: {
        sequence: result.head.sequence,
        reason: 'head_mismatch',
        detail: `expected head ${want.sequence}, export ends at ${result.head.sequence} (truncated or forked)`,
      },
    };
  }
  return result;
}

export class EventLedger {
  private entries: LedgerEntry[] = [];
  private anchor: LedgerAnchor = { sequence: 0, hash: LEDGER_GENESIS_HASH };
  private lastTimeMs = -Infinity;
  private compromised: LedgerVerification | null = null;
  private deferred: AuditEvent[] = [];
  private deferredDropped = 0;
  private readonly now: () => Date;
  private readonly maxEntries: number;

  constructor(options: EventLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxEntries = options.maxEntries ?? 100_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('maxEntries must be a positive safe integer');
    }
  }

  /** O(1). Throws LedgerIntegrityError / LedgerCapacityError without changing state. */
  append(input: LedgerEntryInput): LedgerEntry {
    if (this.compromised) throw new LedgerIntegrityError(this.compromised);
    if (this.entries.length >= this.maxEntries) throw new LedgerCapacityError(this.maxEntries);
    return this.push(input);
  }

  /** Mirror an audit event, if its action belongs in the ledger. Returns null otherwise. */
  appendAuditEvent(event: AuditEvent, backfilled = false): LedgerEntry | null {
    const category = LEDGER_ACTION_CATEGORIES[event.action];
    if (!category) return null;
    return this.append({
      category,
      action: event.action,
      actor: { type: event.actor.type, id: event.actor.id },
      subject: { type: event.scope.entityType, id: event.scope.entityId },
      payload: {
        reason: event.reason ?? null,
        beforeState: event.beforeState ?? null,
        afterState: event.afterState ?? null,
        metadata: event.metadata ?? null,
        auditHash: event.hash ?? null,
        ...(backfilled ? { backfilled: true, originalTimestamp: event.timestamp } : {}),
      },
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  /**
   * Never-throwing variant used by the audit store. The audit event has
   * already happened (a payment may be settled on-chain), so a ledger that is
   * compromised or full must not fail the request. The event is deferred
   * instead and appended by `drainDeferred()` once the ledger is healthy.
   * Bounded: past `MAX_DEFERRED`, events are counted as dropped (they remain
   * in the audit trail and are reported by `status()`).
   */
  mirrorAuditEvent(event: AuditEvent): LedgerEntry | null {
    if (!LEDGER_ACTION_CATEGORIES[event.action]) return null;
    if (this.deferred.length === 0) {
      try {
        return this.appendAuditEvent(event);
      } catch {
        // fall through to deferral
      }
    }
    // Keep arrival order: once anything is deferred, later events queue behind it.
    if (this.deferred.length < MAX_DEFERRED) this.deferred.push(event);
    else this.deferredDropped += 1;
    return null;
  }

  /**
   * Append deferred events in arrival order. Each is marked `backfilled` with
   * its original timestamp, since its `recordedAt` is the time it entered the
   * ledger. Stops (keeping the rest) at the first failure; safe to retry.
   */
  drainDeferred(): { appended: number; remaining: number; dropped: number } {
    let appended = 0;
    while (this.deferred.length > 0) {
      const event = this.deferred[0];
      try {
        this.appendAuditEvent(event, true);
      } catch {
        break;
      }
      this.deferred.shift();
      appended += 1;
    }
    return { appended, remaining: this.deferred.length, dropped: this.deferredDropped };
  }

  head(): LedgerAnchor {
    const last = this.entries.at(-1);
    return last ? { sequence: last.sequence, hash: last.hash } : { ...this.anchor };
  }

  /** O(n). Marks the ledger compromised on failure so no entry is chained onto bad history. */
  verify(): LedgerVerification {
    const result = verifyEntries(this.entries, this.anchor);
    if (!result.valid) this.compromised = result;
    return result;
  }

  status(): LedgerStatus {
    return {
      compromised: this.compromised !== null,
      size: this.entries.length,
      deferred: this.deferred.length,
      deferredDropped: this.deferredDropped,
      anchor: { ...this.anchor },
      head: this.head(),
      ...(this.compromised?.failure ? { failure: this.compromised.failure } : {}),
    };
  }

  /**
   * Export entries `fromSequence..toSequence` (inclusive, defaults to all
   * retained). The anchor is the entry just before the range, so a partial
   * export verifies on its own. Entries are deep-copied: editing an export
   * can never change the ledger.
   */
  export(range: { fromSequence?: number; toSequence?: number } = {}): LedgerExport {
    const first = this.anchor.sequence + 1;
    // Clamped to head + 1 so a range past the end is an empty export anchored at the head.
    const from = Math.min(Math.max(range.fromSequence ?? first, first), this.head().sequence + 1);
    const to = Math.min(range.toSequence ?? this.head().sequence, this.head().sequence);
    const slice = this.entries.slice(from - first, Math.max(from - first, to - first + 1));
    const anchor = from === first ? { ...this.anchor } : { sequence: from - 1, hash: this.entries[from - first - 1].hash };
    const entries: LedgerEntry[] = JSON.parse(JSON.stringify(slice));
    const last = entries.at(-1);
    return {
      schema: LEDGER_SCHEMA_ID,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      exportedAt: this.now().toISOString(),
      anchor,
      head: last ? { sequence: last.sequence, hash: last.hash } : { ...anchor },
      entryCount: entries.length,
      entries,
    };
  }

  /** NDJSON: a header line (everything but the entries), then one entry per line. */
  exportNdjson(range: { fromSequence?: number; toSequence?: number } = {}): string {
    const { entries, ...header } = this.export(range);
    return [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }

  /**
   * Drop entries up to and including `throughSequence`, keeping the anchor.
   * Callers must export (and store) that range first; pruning a compromised
   * ledger is refused so evidence of tampering cannot be pruned away.
   */
  prune(throughSequence: number): { pruned: number; anchor: LedgerAnchor } {
    if (this.compromised) throw new LedgerIntegrityError(this.compromised);
    const first = this.anchor.sequence + 1;
    const count = Math.min(Math.max(0, throughSequence - first + 1), this.entries.length);
    if (count > 0) {
      const lastDropped = this.entries[count - 1];
      this.anchor = { sequence: lastDropped.sequence, hash: lastDropped.hash };
      this.entries = this.entries.slice(count);
    }
    return { pruned: count, anchor: { ...this.anchor } };
  }

  /**
   * Recovery after a failed verification. The damaged entries stay where they
   * are (they are the evidence); a LEDGER_RESEALED entry is chained onto the
   * current tail recording who resealed, why, and what verification found.
   * Verification of an export of the full ledger keeps failing at the original
   * break, which is intended: an export from the reseal onward verifies.
   */
  reseal(input: { actorId: string; reason: string }): LedgerEntry {
    if (!this.compromised) throw new Error('Ledger is not compromised; nothing to reseal');
    if (!input.actorId || input.reason.trim().length < 10) {
      throw new Error('reseal needs an actorId and a reason of at least 10 characters');
    }
    const finding = this.compromised.failure;
    this.compromised = null;
    return this.push({
      category: 'privileged',
      action: 'LEDGER_RESEALED',
      actor: { type: 'maintainer', id: input.actorId },
      subject: { type: 'ledger', id: LEDGER_SCHEMA_ID },
      payload: { reason: input.reason.trim(), finding: finding ?? null },
    });
  }

  size(): number {
    return this.entries.length;
  }

  /** Tests only. */
  clear(): void {
    this.entries = [];
    this.anchor = { sequence: 0, hash: LEDGER_GENESIS_HASH };
    this.lastTimeMs = -Infinity;
    this.compromised = null;
    this.deferred = [];
    this.deferredDropped = 0;
  }

  /** Tests only: direct access to stored entries to simulate tampering. */
  unsafeEntriesForTesting(): LedgerEntry[] {
    return this.entries;
  }

  private push(input: LedgerEntryInput): LedgerEntry {
    const previous = this.head();
    const wallMs = this.now().getTime();
    const timeMs = Math.max(wallMs, this.lastTimeMs);
    const fields: HashedFields = {
      sequence: previous.sequence + 1,
      recordedAt: new Date(timeMs).toISOString(),
      ...(wallMs < this.lastTimeMs ? { clockSkewMs: this.lastTimeMs - wallMs } : {}),
      category: input.category,
      action: input.action,
      actor: { type: input.actor.type, id: input.actor.id },
      subject: { type: input.subject.type, id: input.subject.id },
      payload: input.payload ? (sanitizeForLogging(input.payload) as Record<string, unknown>) : {},
      sourceEventId: input.sourceEventId ?? null,
      correlationId: input.correlationId ?? null,
      previousHash: previous.hash,
    };
    // Round-trip through JSON so the stored entry hashes the same after export
    // (drops undefined, normalizes nested values).
    const normalized: HashedFields = JSON.parse(JSON.stringify(fields));
    const entry: LedgerEntry = { ...normalized, hash: hashLedgerEntry(normalized) };
    this.entries.push(entry);
    this.lastTimeMs = timeMs;
    return entry;
  }
}

/** Process ledger, fed by the process audit store (see audit-service.ts). */
export const eventLedger = new EventLedger();
