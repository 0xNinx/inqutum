/**
 * Privacy-safe invoice data export (issue #52).
 *
 *  - Schema: `quittance.invoice-export` with an explicit version. Only fields in
 *    EXPORT_FIELDS are ever emitted (allow-list), so customer/payer/seller
 *    personal data (names, emails) can never leak by adding a column upstream.
 *  - Authorization: an export is generated for, and downloadable by, exactly one
 *    wallet: the requester. Asking for another wallet's scope is denied, and
 *    another wallet's artifact id looks like it does not exist.
 *  - Retention: generated artifacts expire (default 24 h) and are purged; each
 *    requester keeps a bounded number of artifacts.
 *  - Size: generation pages through storage and stops at maxRecords, marking
 *    the export `truncated` so nothing is silently cut.
 *  - Cancellation: `create` accepts an optional AbortSignal, checked between
 *    storage pages, so a caller that disconnects or times out mid-export can
 *    stop in-flight work. No partial artifact is ever persisted — `this.
 *    artifacts.set` only runs after the full page loop completes, so a
 *    cancelled export leaves no stale/incomplete record to clean up.
 *  - Field-level authorization (#308): every field the service knows about has
 *    a classification and the grant it requires (EXPORT_FIELD_POLICY). A
 *    caller may ask for a subset of fields; asking for a field it is not
 *    granted is refused as a whole (never silently dropped), and personal
 *    fields are classified but never exportable. Omitting `fields` keeps the
 *    v1 output byte for byte.
 *  - Idempotent retries (#308): an `idempotencyKey` makes a repeated or
 *    concurrent request return the same artifact instead of generating (and
 *    evicting quota for) a duplicate.
 */

import { v4 as uuidv4 } from 'uuid';
import type { InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';
import { redactSensitiveText } from '../security/redaction';

export const EXPORT_SCHEMA_ID = 'quittance.invoice-export';
export const EXPORT_SCHEMA_VERSION = 1;

export const EXPORT_FIELDS = [
  'id',
  'memo',
  'status',
  'amount',
  'assetCode',
  'assetIssuer',
  'description',
  'createdAt',
  'expiresAt',
  'paidAt',
  'paymentTxHash',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];
export type ExportRecord = Record<ExportField, string | number | null>;

/** Schema version of an export whose caller chose its fields (#308). */
export const EXPORT_SCHEMA_VERSION_FIELD_SELECTION = 2;

export type ExportFieldClassification = 'identifier' | 'descriptive' | 'financial' | 'settlement' | 'counterparty' | 'personal';

/**
 * Grants a caller can hold. `owner` is what a seller exporting their own
 * invoices gets. `counterparty` covers payer identities and is not granted on
 * the public route (wallet identity is still caller-asserted there).
 */
export type ExportGrant = 'owner' | 'counterparty';

export interface ExportFieldPolicy {
  classification: ExportFieldClassification;
  /** Grant needed to export the field; null means it is never exportable. */
  requires: ExportGrant | null;
  value: (invoice: StoredInvoice) => string | number | null;
}

/**
 * Every field the export knows about, in output order. Unlisted invoice
 * columns are unknown to the export and are rejected with 400. Fails closed:
 * a new column is not exportable until it is classified here.
 */
export const EXPORT_FIELD_POLICY = {
  id: { classification: 'identifier', requires: 'owner', value: (i) => i.id },
  memo: { classification: 'identifier', requires: 'owner', value: (i) => (typeof i.memo === 'string' ? redactSensitiveText(i.memo) : i.memo) },
  status: { classification: 'settlement', requires: 'owner', value: (i) => i.status },
  amount: { classification: 'financial', requires: 'owner', value: (i) => i.amount },
  assetCode: { classification: 'financial', requires: 'owner', value: (i) => i.assetCode },
  assetIssuer: { classification: 'financial', requires: 'owner', value: (i) => i.assetIssuer ?? null },
  description: { classification: 'descriptive', requires: 'owner', value: (i) => (typeof i.description === 'string' ? redactSensitiveText(i.description) : null) },
  createdAt: { classification: 'settlement', requires: 'owner', value: (i) => iso(i.createdAt) },
  expiresAt: { classification: 'settlement', requires: 'owner', value: (i) => iso(i.expiresAt) },
  paidAt: { classification: 'settlement', requires: 'owner', value: (i) => iso(i.paidAt) },
  paymentTxHash: { classification: 'settlement', requires: 'owner', value: (i) => i.paymentTxHash ?? null },
  payerPublicKey: { classification: 'counterparty', requires: 'counterparty', value: (i) => i.payerPublicKey ?? null },
  sellerName: { classification: 'personal', requires: null, value: () => null },
  sellerEmail: { classification: 'personal', requires: null, value: () => null },
  customerName: { classification: 'personal', requires: null, value: () => null },
  customerEmail: { classification: 'personal', requires: null, value: () => null },
  payerName: { classification: 'personal', requires: null, value: () => null },
  payerEmail: { classification: 'personal', requires: null, value: () => null },
} as const satisfies Record<string, ExportFieldPolicy>;

export type ExportPolicyField = keyof typeof EXPORT_FIELD_POLICY;

export interface ExportAccess {
  grants: readonly ExportGrant[];
}

/** What the public export route grants a requester for their own invoices. */
export const OWNER_ACCESS: ExportAccess = { grants: ['owner'] };

export const MAX_SELECTED_FIELDS = 32;

export type ExportFormat = 'json' | 'csv';

export interface ExportRequest {
  format: ExportFormat;
  status?: string;
  from?: Date;
  to?: Date;
  /** Fields to include. Omit for the default v1 field set. */
  fields?: readonly string[];
  /** Repeating a request with the same key returns the same artifact. */
  idempotencyKey?: string;
}

export interface ExportMetadata {
  schema: typeof EXPORT_SCHEMA_ID;
  schemaVersion: number;
  exportId: string;
  generatedAt: string;
  /** After this instant the artifact is deleted and can no longer be downloaded. */
  expiresAt: string;
  scope: { sellerPublicKey: string };
  filters: { status: string | null; from: string | null; to: string | null };
  recordCount: number;
  /** True when the record cap was hit; narrow the filters to get the rest. */
  truncated: boolean;
  fields: readonly string[];
  /** Present only when the caller selected fields (schemaVersion 2). */
  fieldClassifications?: Record<string, ExportFieldClassification>;
}

export interface ExportArtifact {
  meta: ExportMetadata;
  format: ExportFormat;
  contentType: string;
  body: string;
  owner: string;
}

export type ExportLookup =
  | { state: 'ok'; artifact: ExportArtifact }
  | { state: 'not_found' }
  | { state: 'expired' };

export interface ExportServiceOptions {
  now?: () => Date;
  retentionMs?: number;
  maxRecords?: number;
  pageSize?: number;
  maxArtifactsPerRequester?: number;
}

export class ExportForbiddenError extends Error {
  constructor(message = 'You can only export your own invoices') {
    super(message);
    this.name = 'ExportForbiddenError';
  }
}

export class ExportCancelledError extends Error {
  constructor(message = 'Export was cancelled before it completed') {
    super(message);
    this.name = 'ExportCancelledError';
  }
}

export class ExportFieldError extends Error {
  readonly code = 'INVALID_EXPORT_FIELDS' as const;

  constructor(message: string, readonly fields: string[] = []) {
    super(message);
    this.name = 'ExportFieldError';
  }
}

/** The caller asked for fields it may not see. Nothing is generated. */
export class ExportFieldForbiddenError extends Error {
  readonly code = 'EXPORT_FIELD_FORBIDDEN' as const;

  constructor(readonly denied: Array<{ field: string; classification: ExportFieldClassification; reason: 'never_exportable' | 'missing_grant'; requires: ExportGrant | null }>) {
    super(`Not authorized to export: ${denied.map((d) => d.field).join(', ')}`);
    this.name = 'ExportFieldForbiddenError';
  }
}

/** The idempotency key was already used for a different export request. */
export class ExportIdempotencyConflictError extends Error {
  readonly code = 'EXPORT_IDEMPOTENCY_CONFLICT' as const;

  constructor() {
    super('This idempotency key was already used for a different export request');
    this.name = 'ExportIdempotencyConflictError';
  }
}

const isPolicyField = (field: string): field is ExportPolicyField => Object.prototype.hasOwnProperty.call(EXPORT_FIELD_POLICY, field);

/**
 * Resolve a field selection against the caller's grants. Returns the fields in
 * policy order (stable output regardless of request order), or throws. All
 * denials are reported together so the caller can fix the request in one go.
 */
export function authorizeExportFields(requested: readonly string[] | undefined, access: ExportAccess): ExportPolicyField[] | null {
  if (requested === undefined) return null;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_SELECTED_FIELDS) {
    throw new ExportFieldError(`fields must list 1-${MAX_SELECTED_FIELDS} field names`);
  }
  const unknown = requested.filter((f) => typeof f !== 'string' || !isPolicyField(f));
  if (unknown.length > 0) throw new ExportFieldError(`Unknown export fields: ${unknown.map(String).join(', ')}`, unknown.map(String));

  const wanted = new Set(requested as ExportPolicyField[]);
  const denied: ExportFieldForbiddenError['denied'] = [];
  for (const field of wanted) {
    const policy: ExportFieldPolicy = EXPORT_FIELD_POLICY[field];
    if (policy.requires === null) denied.push({ field, classification: policy.classification, reason: 'never_exportable', requires: null });
    else if (!access.grants.includes(policy.requires)) denied.push({ field, classification: policy.classification, reason: 'missing_grant', requires: policy.requires });
  }
  if (denied.length > 0) throw new ExportFieldForbiddenError(denied);
  return (Object.keys(EXPORT_FIELD_POLICY) as ExportPolicyField[]).filter((f) => wanted.has(f));
}

export class ExportConfigurationError extends Error {
  constructor(field: keyof Pick<ExportServiceOptions, 'retentionMs' | 'maxRecords' | 'pageSize' | 'maxArtifactsPerRequester'>) {
    super(`${field} must be a positive safe integer`);
    this.name = 'ExportConfigurationError';
  }
}

const DEFAULTS = {
  retentionMs: 24 * 60 * 60 * 1000,
  maxRecords: 10_000,
  pageSize: 500,
  maxArtifactsPerRequester: 20,
};

const MAX_EXPIRED_TOMBSTONES = 1_000;

/** Cells starting with these are interpreted as formulas by spreadsheet apps. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const iso = (d: Date | string | undefined): string | null => (d ? new Date(d).toISOString() : null);

function positiveInt(
  field: keyof Pick<ExportServiceOptions, 'retentionMs' | 'maxRecords' | 'pageSize' | 'maxArtifactsPerRequester'>,
  value: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ExportConfigurationError(field);
  return value;
}

export function toExportRecord(invoice: StoredInvoice): ExportRecord {
  return projectExportRecord(invoice, EXPORT_FIELDS) as ExportRecord;
}

/** Only the named fields, each through its policy extractor. */
export function projectExportRecord(invoice: StoredInvoice, fields: readonly ExportPolicyField[]): Record<string, string | number | null> {
  const record: Record<string, string | number | null> = {};
  for (const field of fields) record[field] = (EXPORT_FIELD_POLICY[field] as ExportFieldPolicy).value(invoice);
  return record;
}

export class ExportService {
  private artifacts = new Map<string, ExportArtifact>();
  /** Remembers who an expired id belonged to so the owner gets 410 instead of 404. Bounded. */
  private expiredIds = new Map<string, string>();
  /** `${owner}\u0000${key}` -> request fingerprint and the export id or in-flight generation. */
  private idempotency = new Map<string, { fingerprint: string; exportId?: string; pending?: Promise<ExportArtifact> }>();
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly pageSize: number;
  private readonly maxArtifacts: number;

  constructor(private readonly storage: InvoiceStorage, options: ExportServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs = positiveInt('retentionMs', options.retentionMs ?? DEFAULTS.retentionMs);
    this.maxRecords = positiveInt('maxRecords', options.maxRecords ?? DEFAULTS.maxRecords);
    this.pageSize = positiveInt('pageSize', options.pageSize ?? DEFAULTS.pageSize);
    this.maxArtifacts = positiveInt('maxArtifactsPerRequester', options.maxArtifactsPerRequester ?? DEFAULTS.maxArtifactsPerRequester);
  }

  /**
   * @param requester wallet asking for the export
   * @param scope wallet whose data is requested; defaults to the requester and
   *              must equal it, otherwise the export is denied
   * @param signal optional AbortSignal; checked between storage pages so a
   *               caller that disconnects or times out can cancel a large
   *               export in flight. Throws ExportCancelledError on abort.
   * @param access grants for field-level authorization; defaults to the
   *               owner's grants
   */
  async create(
    requester: string,
    request: ExportRequest,
    scope: string = requester,
    signal?: AbortSignal,
    access: ExportAccess = OWNER_ACCESS
  ): Promise<ExportArtifact> {
    if (scope !== requester) throw new ExportForbiddenError();
    // Authorization happens before any storage read, so a denied request costs nothing.
    const selected = authorizeExportFields(request.fields, access);
    this.purgeExpired();

    const key = request.idempotencyKey;
    if (key === undefined) return this.generate(requester, request, selected, signal);
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw new ExportFieldError('idempotencyKey must be 1-200 characters');
    }
    const slot = `${requester}\u0000${key}`;
    const fingerprint = JSON.stringify([
      request.format,
      request.status ?? null,
      iso(request.from),
      iso(request.to),
      selected,
    ]);
    const seen = this.idempotency.get(slot);
    if (seen) {
      if (seen.fingerprint !== fingerprint) throw new ExportIdempotencyConflictError();
      // Concurrent retry: share the generation already in flight.
      if (seen.pending) return seen.pending;
      const existing = seen.exportId ? this.artifacts.get(seen.exportId) : undefined;
      if (existing) return existing;
      // The earlier artifact expired or was evicted: generate a fresh one under the same key.
    }
    const pending = this.generate(requester, request, selected, signal);
    this.idempotency.set(slot, { fingerprint, pending });
    try {
      const artifact = await pending;
      this.idempotency.set(slot, { fingerprint, exportId: artifact.meta.exportId });
      return artifact;
    } catch (error) {
      // A failed or cancelled attempt leaves no record, so a retry can run.
      this.idempotency.delete(slot);
      throw error;
    } finally {
      while (this.idempotency.size > MAX_EXPIRED_TOMBSTONES) {
        this.idempotency.delete(this.idempotency.keys().next().value as string);
      }
    }
  }

  private async generate(
    requester: string,
    request: ExportRequest,
    selected: ExportPolicyField[] | null,
    signal: AbortSignal | undefined
  ): Promise<ExportArtifact> {
    const fields: readonly ExportPolicyField[] = selected ?? EXPORT_FIELDS;

    const records: Array<Record<string, string | number | null>> = [];
    let truncated = false;
    // Keyset paging (createdAt, id): stable when invoices are inserted or
    // deleted while the export runs, unlike offset paging which shifts rows.
    let after: { createdAt: Date; id: string } | undefined;
    const seenIds = new Set<string>();
    while (!truncated) {
      if (signal?.aborted) throw new ExportCancelledError();
      const page = await this.storage.getInvoicesBySeller(requester, request.status, this.pageSize, 0, after);
      if (signal?.aborted) throw new ExportCancelledError();
      const tail = page[page.length - 1];
      if (tail) after = { createdAt: new Date(new Date(tail.createdAt).getTime()), id: tail.id };
      const before = seenIds.size;
      for (const invoice of page) {
        if (seenIds.has(invoice.id)) continue;
        seenIds.add(invoice.id);
        // Defence in depth: never emit a row that is not the requester's.
        if (invoice.sellerPublicKey !== requester) continue;
        const created = new Date(invoice.createdAt).getTime();
        if (request.from && created < request.from.getTime()) continue;
        if (request.to && created > request.to.getTime()) continue;
        if (records.length >= this.maxRecords) {
          truncated = true;
          break;
        }
        records.push(projectExportRecord(invoice, fields));
      }
      if (page.length < this.pageSize || seenIds.size === before) break;
    }

    const generatedAt = this.now();
    const meta: ExportMetadata = {
      schema: EXPORT_SCHEMA_ID,
      schemaVersion: selected ? EXPORT_SCHEMA_VERSION_FIELD_SELECTION : EXPORT_SCHEMA_VERSION,
      exportId: uuidv4(),
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + this.retentionMs).toISOString(),
      scope: { sellerPublicKey: requester },
      filters: { status: request.status ?? null, from: iso(request.from), to: iso(request.to) },
      recordCount: records.length,
      truncated,
      fields,
      ...(selected
        ? { fieldClassifications: Object.fromEntries(selected.map((f) => [f, EXPORT_FIELD_POLICY[f].classification])) }
        : {}),
    };

    const artifact: ExportArtifact = {
      meta,
      format: request.format,
      contentType: request.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      body: request.format === 'csv' ? this.renderCsv(fields, records) : JSON.stringify({ ...meta, records }, null, 2),
      owner: requester,
    };
    this.artifacts.set(meta.exportId, artifact);
    this.enforceQuota(requester);
    return artifact;
  }

  /** Not-found and not-yours are indistinguishable on purpose. */
  get(requester: string, id: string): ExportLookup {
    this.purgeExpired();
    const artifact = this.artifacts.get(id);
    if (artifact && artifact.owner === requester) return { state: 'ok', artifact };
    if (!artifact && this.expiredIds.get(id) === requester) return { state: 'expired' };
    return { state: 'not_found' };
  }

  purgeExpired(): number {
    const nowMs = this.now().getTime();
    let purged = 0;
    for (const [id, artifact] of this.artifacts) {
      if (new Date(artifact.meta.expiresAt).getTime() <= nowMs) {
        this.artifacts.delete(id);
        this.expiredIds.set(id, artifact.owner);
        purged += 1;
      }
    }
    while (this.expiredIds.size > MAX_EXPIRED_TOMBSTONES) {
      this.expiredIds.delete(this.expiredIds.keys().next().value as string);
    }
    return purged;
  }

  size(): number {
    return this.artifacts.size;
  }

  private enforceQuota(owner: string): void {
    const mine = [...this.artifacts.values()].filter((a) => a.owner === owner);
    for (const old of mine.slice(0, Math.max(0, mine.length - this.maxArtifacts))) {
      this.artifacts.delete(old.meta.exportId);
    }
  }

  private renderCsv(fields: readonly string[], records: Array<Record<string, string | number | null>>): string {
    const header = fields.join(',');
    const rows = records.map((r) => fields.map((f) => csvCell(r[f])).join(','));
    return [header, ...rows].join('\r\n') + '\r\n';
  }
}
