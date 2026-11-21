/**
 * Paginated affected-record preview for policy simulations (Issue #432).
 *
 * `runMaintainerPolicySimulation` already evaluates every affected record and
 * workflow in one pass, but returns all examples up to `maxExamples` in a
 * single response. For large datasets the full list is too big to review in
 * one shot. This module layers a keyset-paginated view on top of the simulation
 * result so a maintainer can step through affected records page by page without
 * re-running the simulation each time.
 *
 * Design choices
 * ──────────────
 * • The simulation is re-run per request against the same record set rather
 *   than stored in a server-side cache. That keeps the preview in sync with
 *   any in-flight record changes and avoids a cache-invalidation surface.
 * • The cursor is HMAC-signed with a digest of the proposal input so a
 *   cursor from one proposal cannot page a different proposal. It also
 *   includes a dataset digest (same as the read-only verification hash used
 *   by the simulation engine) so a cursor is invalidated when the underlying
 *   data changes between pages.
 * • Pagination is applied only to `affectedRecords` (the invoice-level view).
 *   `affectedWorkflows` and `affectedSellers` summaries are always returned in
 *   full; they are small relative to the record list.
 * • The module is strictly read-only: it never writes to storage.
 *
 * See docs/POLICY_SIMULATION_PREVIEW.md.
 */

import * as crypto from 'crypto';
import {
  runMaintainerPolicySimulation,
  POLICY_SIMULATION_SCHEMA_VERSION,
  type AffectedRecordPreview,
  type AffectedWorkflowPreview,
  type AffectedSellerSummary,
  type MaintainerPolicySimulationRequest,
  type MaintainerPolicySimulationResult,
  type SimulationActor,
  type SimulationRecordSelection,
  type SimulationFixtureName,
} from './policy-simulation';
import { DEFAULT_POLICY, type BusinessPolicy } from './policy';
import type { StoredInvoice } from '../storage/invoice-storage';
import type { Job } from '../jobs/job-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PREVIEW_PAGE_SIZE = 20;
export const MAX_PREVIEW_PAGE_SIZE = 100;
export const PREVIEW_CURSOR_VERSION = 1;

/** Minimum secret length for HMAC cursor signing (bytes). */
const MIN_CURSOR_SECRET_LENGTH = 32;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class PolicyPreviewError extends Error {
  readonly httpStatus: number;

  constructor(
    public readonly code:
      | 'INVALID_PREVIEW_REQUEST'
      | 'INVALID_PREVIEW_CURSOR'
      | 'PREVIEW_STORAGE_UNAVAILABLE',
    message: string,
    httpStatus = 400,
  ) {
    super(message);
    this.name = 'PolicyPreviewError';
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * An opaque, tamper-evident cursor that binds a page position to the specific
 * proposal and dataset it was computed against.
 *
 * Fields encoded in the cursor body (base64url JSON):
 *  v        — version (PREVIEW_CURSOR_VERSION)
 *  offset   — 0-based index of the first record on the next page
 *  proposal — SHA-256 of the canonical proposal JSON
 *  data     — SHA-256 of the dataset (invoices + workflows), same as inputDigestHex
 */
interface PreviewCursorPayload {
  v: typeof PREVIEW_CURSOR_VERSION;
  offset: number;
  proposal: string;
  data: string;
}

function hmacCursor(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

export function encodePreviewCursor(
  offset: number,
  proposalDigest: string,
  dataDigest: string,
  secret: string,
): string {
  const payload: PreviewCursorPayload = {
    v: PREVIEW_CURSOR_VERSION,
    offset,
    proposal: proposalDigest,
    data: dataDigest,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = hmacCursor(secret, body);
  return `${body}.${sig}`;
}

export function decodePreviewCursor(
  cursor: string,
  proposalDigest: string,
  dataDigest: string,
  secret: string,
): number {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024) {
    throw new PolicyPreviewError('INVALID_PREVIEW_CURSOR', 'Cursor is malformed; restart from the first page');
  }
  const dotIndex = cursor.lastIndexOf('.');
  if (dotIndex < 1 || dotIndex === cursor.length - 1) {
    throw new PolicyPreviewError('INVALID_PREVIEW_CURSOR', 'Cursor is malformed; restart from the first page');
  }
  const body = cursor.slice(0, dotIndex);
  const sig = cursor.slice(dotIndex + 1);

  // Constant-time comparison to prevent timing attacks.
  const expected = Buffer.from(hmacCursor(secret, body));
  const given = Buffer.from(sig);
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(expected, given)
  ) {
    throw new PolicyPreviewError('INVALID_PREVIEW_CURSOR', 'Cursor signature is invalid; restart from the first page');
  }

  let payload: PreviewCursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new PolicyPreviewError('INVALID_PREVIEW_CURSOR', 'Cursor payload is malformed; restart from the first page');
  }

  if (
    payload.v !== PREVIEW_CURSOR_VERSION ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0 ||
    typeof payload.proposal !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new PolicyPreviewError('INVALID_PREVIEW_CURSOR', 'Cursor payload is invalid; restart from the first page');
  }

  if (payload.proposal !== proposalDigest) {
    throw new PolicyPreviewError(
      'INVALID_PREVIEW_CURSOR',
      'Cursor belongs to a different proposal; restart from the first page',
    );
  }
  if (payload.data !== dataDigest) {
    throw new PolicyPreviewError(
      'INVALID_PREVIEW_CURSOR',
      'Underlying data has changed since this cursor was issued; restart from the first page',
    );
  }

  return payload.offset;
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface PolicySimulationPreviewRequest {
  actor: SimulationActor;
  proposedPolicy: unknown;
  currentPolicy?: BusinessPolicy;
  invoices?: readonly StoredInvoice[];
  workflows?: readonly Job[];
  selection?: SimulationRecordSelection;
  fixtureName?: SimulationFixtureName;
  /** Page size for affected records. Default: 20. Max: 100. */
  pageSize?: number;
  /**
   * Opaque cursor from a previous page. Omit for the first page.
   * The cursor is bound to the proposal and the dataset; it is invalidated
   * if either changes between pages.
   */
  cursor?: string | null;
  now?: Date;
}

/** Summary counts extracted from the full simulation result. */
export interface PolicySimulationSummary {
  schemaVersion: typeof POLICY_SIMULATION_SCHEMA_VERSION;
  simulatedAt: string;
  actor: { id: string; role: string };
  sourceMode: MaintainerPolicySimulationResult['sourceMode'];
  riskLevel: MaintainerPolicySimulationResult['riskLevel'];
  readOnlyVerified: boolean;
  inputDigestHex: string;
  counts: MaintainerPolicySimulationResult['counts'];
  outcomesByCode: Record<string, number>;
  riskWarnings: MaintainerPolicySimulationResult['riskWarnings'];
  expectedSideEffects: MaintainerPolicySimulationResult['expectedSideEffects'];
  rollbackConstraints: MaintainerPolicySimulationResult['rollbackConstraints'];
  /** All affected workflows (not paginated; typically small). */
  affectedWorkflows: AffectedWorkflowPreview[];
  /** All affected sellers (not paginated; typically small). */
  affectedSellers: AffectedSellerSummary[];
}

export interface PolicySimulationPreviewPage {
  summary: PolicySimulationSummary;
  /** The paginated slice of affected records. */
  records: AffectedRecordPreview[];
  pagination: {
    pageSize: number;
    offset: number;
    hasMore: boolean;
    /** Opaque cursor to pass for the next page. Null on the last page. */
    nextCursor: string | null;
    totalAffectedRecords: number;
  };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Runs a maintainer policy simulation and returns a single paginated page of
 * affected records together with the full summary.
 *
 * The `cursorSecret` must be at least 32 characters long and secret; treat it
 * like a signing key (store it in env, not in source). When omitted, cursors
 * are disabled and only the first page is ever accessible (safe for unit tests
 * and environments without a configured secret).
 *
 * @throws {PolicySimulationPermissionError}  actor is not maintainer/admin
 * @throws {PolicySimulationValidationError}  proposed policy is invalid
 * @throws {PolicyPreviewError}               cursor or pagination input is invalid
 */
export function runPolicySimulationPreview(
  request: PolicySimulationPreviewRequest,
  cursorSecret?: string,
): PolicySimulationPreviewPage {
  // Validate cursor-signing secret early so callers get a clear error.
  const signingEnabled =
    typeof cursorSecret === 'string' && cursorSecret.length >= MIN_CURSOR_SECRET_LENGTH;

  // Validate pagination inputs before running the (potentially expensive) simulation.
  const rawPageSize = request.pageSize ?? DEFAULT_PREVIEW_PAGE_SIZE;
  if (!Number.isInteger(rawPageSize) || rawPageSize < 1 || rawPageSize > MAX_PREVIEW_PAGE_SIZE) {
    throw new PolicyPreviewError(
      'INVALID_PREVIEW_REQUEST',
      `pageSize must be an integer between 1 and ${MAX_PREVIEW_PAGE_SIZE}`,
    );
  }
  const pageSize = rawPageSize;

  // Run the full simulation with maxExamples set to the full dataset size so
  // we always get every affected record (pagination is applied by this module).
  const simulationRequest: MaintainerPolicySimulationRequest = {
    actor: request.actor,
    proposedPolicy: request.proposedPolicy,
    currentPolicy: request.currentPolicy,
    invoices: request.invoices,
    workflows: request.workflows,
    selection: request.selection,
    fixtureName: request.fixtureName,
    maxExamples: 10_000, // generous upper bound; the engine caps at the actual count
    now: request.now,
  };

  // This throws PolicySimulationPermissionError / PolicySimulationValidationError
  // on bad actor / policy input — we let those propagate.
  const full = runMaintainerPolicySimulation(simulationRequest);
  const allRecords = full.examples.affectedRecords; // already de-duplicated by simulation engine
  const totalAffected = allRecords.length;

  // Build proposal and data digests for cursor binding.
  const proposalDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(request.proposedPolicy))
    .digest('hex');
  const dataDigest = full.inputDigestHex;

  // Resolve cursor offset.
  let offset = 0;
  if (request.cursor) {
    if (!signingEnabled) {
      throw new PolicyPreviewError(
        'INVALID_PREVIEW_CURSOR',
        'Cursor-based pagination requires a cursorSecret of at least 32 characters',
      );
    }
    offset = decodePreviewCursor(request.cursor, proposalDigest, dataDigest, cursorSecret!);
  }

  if (offset > totalAffected) {
    throw new PolicyPreviewError(
      'INVALID_PREVIEW_CURSOR',
      'Cursor offset is beyond the end of the result set; restart from the first page',
    );
  }

  // Slice the page.
  const pageRecords = allRecords.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const hasMore = nextOffset < totalAffected;
  let nextCursor: string | null = null;
  if (hasMore && signingEnabled) {
    nextCursor = encodePreviewCursor(nextOffset, proposalDigest, dataDigest, cursorSecret!);
  }

  const summary: PolicySimulationSummary = {
    schemaVersion: full.schemaVersion,
    simulatedAt: full.simulatedAt,
    actor: full.actor,
    sourceMode: full.sourceMode,
    riskLevel: full.riskLevel,
    readOnlyVerified: full.readOnlyVerified,
    inputDigestHex: full.inputDigestHex,
    counts: full.counts,
    outcomesByCode: full.outcomesByCode,
    riskWarnings: full.riskWarnings,
    expectedSideEffects: full.expectedSideEffects,
    rollbackConstraints: full.rollbackConstraints,
    affectedWorkflows: full.examples.affectedWorkflows,
    affectedSellers: full.examples.affectedUsers,
  };

  return {
    summary,
    records: pageRecords,
    pagination: {
      pageSize,
      offset,
      hasMore,
      nextCursor,
      totalAffectedRecords: totalAffected,
    },
  };
}

// ---------------------------------------------------------------------------
// Request body parser (for HTTP handler use)
// ---------------------------------------------------------------------------

/**
 * Parses and validates a raw HTTP request body into a
 * `PolicySimulationPreviewRequest`. Throws `PolicyPreviewError` on bad input.
 */
export function parsePolicySimulationPreviewRequest(
  body: unknown,
  currentPolicy: BusinessPolicy = DEFAULT_POLICY,
): Omit<PolicySimulationPreviewRequest, 'invoices' | 'workflows'> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PolicyPreviewError('INVALID_PREVIEW_REQUEST', 'Request body must be a JSON object');
  }

  const raw = body as Record<string, unknown>;

  // Actor
  if (
    !raw.actor ||
    typeof raw.actor !== 'object' ||
    Array.isArray(raw.actor) ||
    typeof (raw.actor as Record<string, unknown>).id !== 'string' ||
    !(raw.actor as Record<string, unknown>).id
  ) {
    throw new PolicyPreviewError('INVALID_PREVIEW_REQUEST', 'actor.id is required');
  }
  const actorRaw = raw.actor as Record<string, unknown>;
  const actor: SimulationActor = {
    id: String(actorRaw.id),
    role: String(actorRaw.role ?? 'maintainer'),
  };

  // proposedPolicy presence check (content is validated by the simulation engine)
  if (raw.proposedPolicy === undefined) {
    throw new PolicyPreviewError('INVALID_PREVIEW_REQUEST', 'proposedPolicy is required');
  }

  // pageSize
  let pageSize = DEFAULT_PREVIEW_PAGE_SIZE;
  if (raw.pageSize !== undefined) {
    const n = Number(raw.pageSize);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PREVIEW_PAGE_SIZE) {
      throw new PolicyPreviewError(
        'INVALID_PREVIEW_REQUEST',
        `pageSize must be an integer between 1 and ${MAX_PREVIEW_PAGE_SIZE}`,
      );
    }
    pageSize = n;
  }

  // cursor
  const cursor = raw.cursor === undefined || raw.cursor === null ? null : String(raw.cursor);

  // fixtureName
  const VALID_FIXTURES: SimulationFixtureName[] = [
    'standard',
    'high-volume',
    'multi-asset',
    'active-workflows',
  ];
  let fixtureName: SimulationFixtureName | undefined;
  if (raw.fixtureName !== undefined) {
    if (!VALID_FIXTURES.includes(raw.fixtureName as SimulationFixtureName)) {
      throw new PolicyPreviewError(
        'INVALID_PREVIEW_REQUEST',
        `fixtureName must be one of: ${VALID_FIXTURES.join(', ')}`,
      );
    }
    fixtureName = raw.fixtureName as SimulationFixtureName;
  }

  // selection — pass through as-is; the simulation engine validates it
  const selection =
    raw.selection !== undefined &&
    raw.selection !== null &&
    typeof raw.selection === 'object' &&
    !Array.isArray(raw.selection)
      ? (raw.selection as SimulationRecordSelection)
      : undefined;

  return {
    actor,
    proposedPolicy: raw.proposedPolicy,
    currentPolicy,
    selection,
    fixtureName,
    pageSize,
    cursor,
  };
}
