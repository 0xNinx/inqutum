/**
 * Contributor-safe seed fixtures for complex edge cases (issue #201).
 *
 * One deterministic dataset covering the core workflows end to end: users and
 * organizations, invoices, settlements, delegated authorizations, SLA
 * workflows, background jobs, external references and audit history. The
 * dependency graph (#203), authorization lifecycle (#199) and post-rollback
 * verification (#209) all run against this dataset, so one fixture exercises
 * every module.
 *
 * Safety and determinism rules:
 *  - Every timestamp is an offset from a single `anchor`. With the default
 *    anchor the dataset is byte-for-byte identical on every machine.
 *  - Ids are fixed literals; transaction hashes are sha256 of a fixed label.
 *  - Public keys are throwaway testnet strkeys already committed elsewhere in
 *    the repo (db/seed.sql, sandbox/fixtures.ts). No secret keys exist here.
 *  - Email addresses use the reserved `.test` TLD (RFC 2606).
 *  - `validateSeedDataset` rejects anything that looks like a secret, so a
 *    careless edit cannot commit credentials.
 *
 * See docs/SEED_FIXTURES.md.
 */
import { createHash } from 'crypto';
import type { InvoiceStatus, StoredInvoice } from '../storage/invoice-storage';
import { INVOICE_STATUSES } from '../storage/invoice-storage';
import type { CollaborationRole } from '../domain/invitation';
import type { JobStatus } from '../jobs/job-types';
import type { AuthorizationGrant } from '../domain/authorization-lifecycle';
import { SECRET_KEY_PATTERN } from '../security/redaction';
import { SANDBOX_PAYER, SANDBOX_SELLER } from './fixtures';

export const SEED_DATASET_VERSION = 1;
/** Fixed reference time. Pass a different anchor to shift the whole dataset. */
export const DEFAULT_SEED_ANCHOR = '2026-01-15T12:00:00.000Z';

/** Throwaway testnet public keys reused from db/seed.sql. */
export const SEED_SELLER_A = 'GAYWLLX32JT5MOLN5TAF3OGFLJBNSTDVAOQONW7QVEUC352TCGRBJYHP';
export const SEED_SELLER_B = 'GCBAENYI5GN7X7J5ANCI3TMRTAWCRYAVJN3Q5OPZMUXULO5SYIVJQ6AV';

export interface SeedUser {
  id: string;
  displayName: string;
  email: string;
  publicKey?: string;
  organizationId: string;
  role: CollaborationRole;
  status: 'active' | 'suspended';
}

export interface SeedOrganization {
  id: string;
  name: string;
  ownerId: string;
}

export type SettlementStatus = 'confirmed' | 'failed' | 'pending';

export interface SeedSettlement {
  id: string;
  invoiceId: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: number;
  assetCode: string;
  status: SettlementStatus;
  failureReason?: string;
  observedAt: Date;
}

/** Seeded grants use the lifecycle module's shape so they load into it directly. */
export type SeedAuthorization = AuthorizationGrant;

export interface SeedWorkflow {
  id: string;
  invoiceId: string;
  kind: 'payment_follow_up' | 'settlement_review' | 'receipt_delivery';
  state: 'open' | 'manual_review' | 'completed';
  ownerId: string;
  openedAt: Date;
  slaDueAt: Date;
  completedAt?: Date;
}

export interface SeedJob {
  id: string;
  type: string;
  status: JobStatus;
  invoiceId?: string;
  attempts: number;
  payloadVersion: number;
  createdAt: Date;
  completedAt?: Date;
  lastError?: string;
}

export interface SeedExternalReference {
  id: string;
  kind: 'stellar_tx' | 'email_delivery' | 'webhook_delivery';
  resourceType: 'invoice' | 'settlement';
  resourceId: string;
  reference: string;
  status: 'pending' | 'confirmed' | 'delivered' | 'failed' | 'rejected';
  createdAt: Date;
}

export interface SeedAuditEvent {
  id: string;
  at: Date;
  action: string;
  actorId: string;
  entityType: 'invoice' | 'authorization' | 'user' | 'settlement';
  entityId: string;
}

export interface SeedDataset {
  version: typeof SEED_DATASET_VERSION;
  anchor: Date;
  organizations: SeedOrganization[];
  users: SeedUser[];
  invoices: StoredInvoice[];
  settlements: SeedSettlement[];
  authorizations: SeedAuthorization[];
  workflows: SeedWorkflow[];
  jobs: SeedJob[];
  externalReferences: SeedExternalReference[];
  auditEvents: SeedAuditEvent[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Deterministic 64-hex "transaction hash". Never a real network hash. */
export function seedTxHash(label: string): string {
  return createHash('sha256').update(`inqutum-seed:${label}`).digest('hex');
}

/** Invoice/job/settlement ids are UUIDs so the SQL export fits the Postgres schema. */
const uuid = (group: string, n: number) => `5eed0000-0000-4000-8${group}-${String(n).padStart(12, '0')}`;

export const SEED_IDS = {
  orgA: 'seed-org-a',
  orgB: 'seed-org-b',
  owner: 'seed-user-owner',
  admin: 'seed-user-admin',
  collaborator: 'seed-user-collab-revoked',
  sellerB: 'seed-user-seller-b',
  payer: 'seed-user-payer',
  suspended: 'seed-user-suspended',
  invPending: uuid('001', 1),
  invPaid: uuid('001', 2),
  invFailedSettlement: uuid('001', 3),
  invExpired: uuid('001', 4),
  invCancelled: uuid('001', 5),
  invHistorical: uuid('001', 6),
  invDuplicateA: uuid('001', 7),
  invDuplicateB: uuid('001', 8),
  settlePaid: uuid('002', 1),
  settleFailed: uuid('002', 2),
  settleHistorical: uuid('002', 3),
  authAdminDelegation: 'seed-auth-admin-delegation',
  authCollabRevoked: 'seed-auth-collab-revoked',
  authApiExpired: 'seed-auth-api-expired',
  authApprovalExpiring: 'seed-auth-approval-expiring',
  authHistoricalCleaned: 'seed-auth-historical-cleaned',
  authRenewedOld: 'seed-auth-renewed-old',
  authRenewedNew: 'seed-auth-renewed-new',
  wfOverdue: 'seed-wf-follow-up-overdue',
  wfPaid: 'seed-wf-receipt-complete',
  wfFailedSettlement: 'seed-wf-settlement-review',
  jobVerifyPaid: uuid('003', 1),
  jobVerifyDead: uuid('003', 2),
  jobReceiptEmail: uuid('003', 3),
  jobExpirySweep: uuid('003', 4),
  xrefTxPaid: 'seed-xref-tx-paid',
  xrefTxFailed: 'seed-xref-tx-failed',
  xrefReceiptEmail: 'seed-xref-email-receipt',
  xrefWebhookFailed: 'seed-xref-webhook-failed',
  xrefTxHistorical: 'seed-xref-tx-historical',
} as const;

/**
 * Builds the dataset. Pure: the same anchor always produces deeply equal output,
 * and each call returns fresh objects so callers may mutate their copy.
 */
export function buildSeedDataset(anchor: Date | string = DEFAULT_SEED_ANCHOR): SeedDataset {
  const base = new Date(anchor).getTime();
  if (!Number.isFinite(base)) throw new Error(`Invalid seed anchor: ${String(anchor)}`);
  const at = (offsetMs: number) => new Date(base + offsetMs);
  const id = SEED_IDS;

  const invoice = (
    fields: Pick<StoredInvoice, 'id' | 'memo' | 'amount' | 'status' | 'createdAt' | 'expiresAt'> & Partial<StoredInvoice>,
    organizationId: string
  ): StoredInvoice => ({
    sellerPublicKey: organizationId === id.orgA ? SEED_SELLER_A : SEED_SELLER_B,
    sellerName: organizationId === id.orgA ? 'Seed Seller A' : 'Seed Seller B',
    sellerEmail: organizationId === id.orgA ? 'seller.a@inqutum.test' : 'seller.b@inqutum.test',
    assetCode: 'XLM',
    customerName: 'Seed Customer',
    customerEmail: 'customer@inqutum.test',
    _schemaVersion: '1.0.0',
    version: 1,
    ...fields,
    metadata: { source: 'seed', organizationId, ...(fields.metadata ?? {}) },
  });

  const paidTx = seedTxHash('settlement-paid');
  const failedTx = seedTxHash('settlement-underpaid');
  const historicalTx = seedTxHash('settlement-historical-2024');

  const invoices: StoredInvoice[] = [
    invoice({ id: id.invPending, userId: id.owner, memo: 'INV-SEED-PENDING', amount: 120, status: 'PENDING', description: 'Open invoice with an overdue follow-up workflow', createdAt: at(-2 * DAY), expiresAt: at(5 * DAY) }, id.orgA),
    invoice({
      id: id.invPaid, userId: id.owner, memo: 'INV-SEED-PAID', amount: 75.5, status: 'PAID', description: 'Settled invoice with receipt delivered',
      createdAt: at(-3 * DAY), expiresAt: at(4 * DAY), paidAt: at(-1 * DAY), paymentTxHash: paidTx, payerPublicKey: SANDBOX_PAYER, payerName: 'Seed Payer', payerEmail: 'payer@inqutum.test', version: 2,
    }, id.orgA),
    invoice({ id: id.invFailedSettlement, userId: id.owner, memo: 'INV-SEED-FAILED-SETTLE', amount: 300, status: 'PENDING', description: 'Underpaid settlement awaiting manual review', createdAt: at(-1 * DAY), expiresAt: at(3 * DAY) }, id.orgA),
    invoice({ id: id.invExpired, userId: id.owner, memo: 'INV-SEED-EXPIRED', amount: 40, status: 'EXPIRED', description: 'Lapsed without payment', createdAt: at(-9 * DAY), expiresAt: at(-2 * DAY), version: 2 }, id.orgA),
    invoice({ id: id.invCancelled, userId: id.collaborator, memo: 'INV-SEED-CANCELLED', amount: 55, status: 'CANCELLED', description: 'Cancelled by a collaborator whose access was later revoked', createdAt: at(-6 * DAY), expiresAt: at(1 * DAY), version: 2 }, id.orgA),
    invoice({
      id: id.invHistorical, userId: id.sellerB, memo: 'INV-SEED-HIST-2024', amount: 999.9999999, status: 'PAID', description: 'Historical record from before schema versioning',
      createdAt: at(-730 * DAY), expiresAt: at(-723 * DAY), paidAt: at(-729 * DAY), paymentTxHash: historicalTx, payerPublicKey: SANDBOX_PAYER, version: 2,
      _schemaVersion: undefined, metadata: { archived: true },
    }, id.orgB),
    invoice({ id: id.invDuplicateA, userId: id.sellerB, memo: 'INV-SEED-DUP-A', amount: 10, status: 'PENDING', description: 'Suspected duplicate (points at DUP-B)', createdAt: at(-4 * HOUR), expiresAt: at(6 * DAY), metadata: { duplicateOf: id.invDuplicateB } }, id.orgB),
    invoice({ id: id.invDuplicateB, userId: id.sellerB, memo: 'INV-SEED-DUP-B', amount: 10, status: 'PENDING', description: 'Suspected duplicate (points at DUP-A)', createdAt: at(-3 * HOUR), expiresAt: at(6 * DAY), metadata: { duplicateOf: id.invDuplicateA } }, id.orgB),
  ];
  // Drop the explicit undefined so JSON/deep-equal output stays tidy.
  for (const inv of invoices) if (inv._schemaVersion === undefined) delete inv._schemaVersion;

  return {
    version: SEED_DATASET_VERSION,
    anchor: at(0),
    organizations: [
      { id: id.orgA, name: 'Seed Organization A', ownerId: id.owner },
      { id: id.orgB, name: 'Seed Organization B', ownerId: id.sellerB },
    ],
    users: [
      { id: id.owner, displayName: 'Seed Owner', email: 'owner@inqutum.test', publicKey: SEED_SELLER_A, organizationId: id.orgA, role: 'OWNER', status: 'active' },
      { id: id.admin, displayName: 'Seed Admin', email: 'admin@inqutum.test', organizationId: id.orgA, role: 'ADMIN', status: 'active' },
      { id: id.collaborator, displayName: 'Revoked Collaborator', email: 'collab@inqutum.test', organizationId: id.orgA, role: 'COLLABORATOR', status: 'active' },
      { id: id.sellerB, displayName: 'Seed Seller B', email: 'seller.b@inqutum.test', publicKey: SEED_SELLER_B, organizationId: id.orgB, role: 'OWNER', status: 'active' },
      { id: id.payer, displayName: 'Seed Payer', email: 'payer@inqutum.test', publicKey: SANDBOX_PAYER, organizationId: id.orgA, role: 'VIEWER', status: 'active' },
      { id: id.suspended, displayName: 'Suspended Viewer', email: 'suspended@inqutum.test', publicKey: SANDBOX_SELLER, organizationId: id.orgB, role: 'VIEWER', status: 'suspended' },
    ],
    invoices,
    settlements: [
      { id: id.settlePaid, invoiceId: id.invPaid, txHash: paidTx, fromAddress: SANDBOX_PAYER, toAddress: SEED_SELLER_A, amount: 75.5, assetCode: 'XLM', status: 'confirmed', observedAt: at(-1 * DAY) },
      { id: id.settleFailed, invoiceId: id.invFailedSettlement, txHash: failedTx, fromAddress: SANDBOX_PAYER, toAddress: SEED_SELLER_A, amount: 120, assetCode: 'XLM', status: 'failed', failureReason: 'UNDERPAID', observedAt: at(-6 * HOUR) },
      { id: id.settleHistorical, invoiceId: id.invHistorical, txHash: historicalTx, fromAddress: SANDBOX_PAYER, toAddress: SEED_SELLER_B, amount: 999.9999999, assetCode: 'XLM', status: 'confirmed', observedAt: at(-729 * DAY) },
    ],
    authorizations: [
      { id: id.authAdminDelegation, kind: 'delegation', subjectId: id.admin, grantedBy: id.owner, scope: { action: 'invoice.cancel', resourceType: 'organization', resourceId: id.orgA }, status: 'active', issuedAt: at(-10 * DAY), expiresAt: at(20 * DAY) },
      { id: id.authCollabRevoked, kind: 'delegation', subjectId: id.collaborator, grantedBy: id.owner, scope: { action: 'invoice.create', resourceType: 'organization', resourceId: id.orgA }, status: 'revoked', issuedAt: at(-20 * DAY), expiresAt: at(10 * DAY), revokedAt: at(-2 * DAY), revokedBy: id.owner },
      // Stored as active but already past expiry: the stale-cleanup target.
      { id: id.authApiExpired, kind: 'api_access', subjectId: id.sellerB, grantedBy: id.sellerB, scope: { action: 'invoice.read', resourceType: 'organization', resourceId: id.orgB }, status: 'active', issuedAt: at(-40 * DAY), expiresAt: at(-1 * DAY) },
      // Still valid but inside the renewal window.
      { id: id.authApprovalExpiring, kind: 'approval', subjectId: id.admin, grantedBy: id.owner, scope: { action: 'job.requeue_dead', resourceType: 'invoice', resourceId: id.invFailedSettlement }, status: 'active', issuedAt: at(-6 * DAY), expiresAt: at(1 * DAY) },
      { id: id.authHistoricalCleaned, kind: 'delegation', subjectId: id.suspended, grantedBy: id.sellerB, scope: { action: 'invoice.read', resourceType: 'organization', resourceId: id.orgB }, status: 'cleaned', issuedAt: at(-500 * DAY), expiresAt: at(-400 * DAY), cleanedAt: at(-390 * DAY) },
      { id: id.authRenewedOld, kind: 'delegation', subjectId: id.admin, grantedBy: id.owner, scope: { action: 'invoice.read', resourceType: 'organization', resourceId: id.orgA }, status: 'renewed', issuedAt: at(-60 * DAY), expiresAt: at(-30 * DAY), renewedToId: id.authRenewedNew },
      { id: id.authRenewedNew, kind: 'delegation', subjectId: id.admin, grantedBy: id.owner, scope: { action: 'invoice.read', resourceType: 'organization', resourceId: id.orgA }, status: 'active', issuedAt: at(-31 * DAY), expiresAt: at(59 * DAY), renewedFromId: id.authRenewedOld },
    ],
    workflows: [
      { id: id.wfOverdue, invoiceId: id.invPending, kind: 'payment_follow_up', state: 'open', ownerId: id.admin, openedAt: at(-2 * DAY), slaDueAt: at(-2 * HOUR) },
      { id: id.wfPaid, invoiceId: id.invPaid, kind: 'receipt_delivery', state: 'completed', ownerId: id.owner, openedAt: at(-1 * DAY), slaDueAt: at(-1 * DAY + 4 * HOUR), completedAt: at(-1 * DAY + 5 * MINUTE) },
      { id: id.wfFailedSettlement, invoiceId: id.invFailedSettlement, kind: 'settlement_review', state: 'manual_review', ownerId: id.admin, openedAt: at(-6 * HOUR), slaDueAt: at(18 * HOUR) },
    ],
    jobs: [
      { id: id.jobVerifyPaid, type: 'payments.verify', status: 'succeeded', invoiceId: id.invPaid, attempts: 1, payloadVersion: 1, createdAt: at(-1 * DAY - 2 * MINUTE), completedAt: at(-1 * DAY) },
      { id: id.jobVerifyDead, type: 'payments.verify', status: 'dead', invoiceId: id.invFailedSettlement, attempts: 5, payloadVersion: 1, createdAt: at(-6 * HOUR), completedAt: at(-5 * HOUR), lastError: 'UNDERPAID: received 120 XLM, expected 300 XLM' },
      { id: id.jobReceiptEmail, type: 'notifications.receipt', status: 'succeeded', invoiceId: id.invPaid, attempts: 1, payloadVersion: 1, createdAt: at(-1 * DAY), completedAt: at(-1 * DAY + MINUTE) },
      { id: id.jobExpirySweep, type: 'invoices.expire-pending', status: 'succeeded', attempts: 1, payloadVersion: 1, createdAt: at(-2 * DAY), completedAt: at(-2 * DAY + MINUTE) },
    ],
    externalReferences: [
      { id: id.xrefTxPaid, kind: 'stellar_tx', resourceType: 'settlement', resourceId: id.settlePaid, reference: paidTx, status: 'confirmed', createdAt: at(-1 * DAY) },
      { id: id.xrefTxFailed, kind: 'stellar_tx', resourceType: 'settlement', resourceId: id.settleFailed, reference: failedTx, status: 'rejected', createdAt: at(-6 * HOUR) },
      { id: id.xrefReceiptEmail, kind: 'email_delivery', resourceType: 'invoice', resourceId: id.invPaid, reference: 'seed-email-receipt-0001', status: 'delivered', createdAt: at(-1 * DAY + MINUTE) },
      { id: id.xrefWebhookFailed, kind: 'webhook_delivery', resourceType: 'invoice', resourceId: id.invFailedSettlement, reference: 'seed-webhook-0001', status: 'failed', createdAt: at(-5 * HOUR) },
      { id: id.xrefTxHistorical, kind: 'stellar_tx', resourceType: 'settlement', resourceId: id.settleHistorical, reference: historicalTx, status: 'confirmed', createdAt: at(-729 * DAY) },
    ],
    auditEvents: [
      { id: 'seed-audit-001', at: at(-730 * DAY), action: 'INVOICE_CREATED', actorId: id.sellerB, entityType: 'invoice', entityId: id.invHistorical },
      { id: 'seed-audit-002', at: at(-729 * DAY), action: 'PAYMENT_VERIFIED', actorId: 'system', entityType: 'invoice', entityId: id.invHistorical },
      { id: 'seed-audit-003', at: at(-6 * DAY), action: 'INVOICE_CREATED', actorId: id.collaborator, entityType: 'invoice', entityId: id.invCancelled },
      { id: 'seed-audit-004', at: at(-5 * DAY), action: 'INVOICE_CANCELLED', actorId: id.collaborator, entityType: 'invoice', entityId: id.invCancelled },
      { id: 'seed-audit-005', at: at(-2 * DAY), action: 'AUTHORIZATION_REVOKED', actorId: id.owner, entityType: 'authorization', entityId: id.authCollabRevoked },
      { id: 'seed-audit-006', at: at(-2 * DAY), action: 'INVOICE_EXPIRED', actorId: 'system', entityType: 'invoice', entityId: id.invExpired },
      { id: 'seed-audit-007', at: at(-1 * DAY), action: 'PAYMENT_VERIFIED', actorId: 'system', entityType: 'invoice', entityId: id.invPaid },
      { id: 'seed-audit-008', at: at(-31 * DAY), action: 'AUTHORIZATION_RENEWED', actorId: id.owner, entityType: 'authorization', entityId: id.authRenewedNew },
    ],
  };
}

// ---------------------------------------------------------------------------
// Consistency validation
// ---------------------------------------------------------------------------

export interface SeedIssue {
  code: string;
  path: string;
  message: string;
}

export interface SeedValidationResult {
  ok: boolean;
  issues: SeedIssue[];
  counts: Record<string, number>;
}

const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const SAFE_EMAIL = /^[a-z0-9._+-]+@[a-z0-9.-]+\.(test|example)$/i;
const SECRET_HINT = /(password|secret|api[_-]?key|private[_-]?key|bearer\s)/i;

/**
 * Checks that the dataset is internally consistent and safe to commit.
 * Returns every issue rather than stopping at the first, so a broken edit
 * reports all of its consequences at once.
 */
export function validateSeedDataset(ds: SeedDataset): SeedValidationResult {
  const issues: SeedIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const anchor = ds.anchor.getTime();

  // Ids are unique across the whole dataset so graph node keys never collide.
  const seen = new Map<string, string>();
  const collections = ['organizations', 'users', 'invoices', 'settlements', 'authorizations', 'workflows', 'jobs', 'externalReferences', 'auditEvents'] as const;
  for (const name of collections) {
    (ds[name] as Array<{ id: string }>).forEach((row, i) => {
      if (seen.has(row.id)) add('DUPLICATE_ID', `${name}[${i}]`, `id ${row.id} already used by ${seen.get(row.id)}`);
      seen.set(row.id, `${name}[${i}]`);
    });
  }

  const orgs = new Map(ds.organizations.map((o) => [o.id, o]));
  const users = new Map(ds.users.map((u) => [u.id, u]));
  const invoices = new Map(ds.invoices.map((i) => [i.id, i]));
  const settlements = new Map(ds.settlements.map((s) => [s.id, s]));
  const auths = new Map(ds.authorizations.map((a) => [a.id, a]));
  const isActor = (actorId: string) => actorId === 'system' || users.has(actorId);

  ds.organizations.forEach((o, i) => {
    if (!users.has(o.ownerId)) add('MISSING_REFERENCE', `organizations[${i}].ownerId`, `unknown user ${o.ownerId}`);
    else if (users.get(o.ownerId)!.role !== 'OWNER') add('OWNER_ROLE_MISMATCH', `organizations[${i}]`, `${o.ownerId} owns ${o.id} but is not OWNER`);
  });

  ds.users.forEach((u, i) => {
    if (!orgs.has(u.organizationId)) add('MISSING_REFERENCE', `users[${i}].organizationId`, `unknown organization ${u.organizationId}`);
    if (!SAFE_EMAIL.test(u.email)) add('UNSAFE_EMAIL', `users[${i}].email`, `${u.email} must use a reserved .test/.example domain`);
    if (u.publicKey && !PUBLIC_KEY.test(u.publicKey)) add('INVALID_PUBLIC_KEY', `users[${i}].publicKey`, 'not a Stellar public key');
  });

  const memos = new Set<string>();
  ds.invoices.forEach((inv, i) => {
    const p = `invoices[${i}]`;
    if (memos.has(inv.memo)) add('DUPLICATE_MEMO', p, `memo ${inv.memo} is not unique`);
    memos.add(inv.memo);
    if (!INVOICE_STATUSES.includes(inv.status as InvoiceStatus)) add('INVALID_STATUS', p, `unknown status ${inv.status}`);
    if (!PUBLIC_KEY.test(inv.sellerPublicKey)) add('INVALID_PUBLIC_KEY', `${p}.sellerPublicKey`, 'not a Stellar public key');
    if (inv.expiresAt <= inv.createdAt) add('INVALID_TIMELINE', p, 'expiresAt must be after createdAt');
    if (inv.createdAt.getTime() > anchor) add('FUTURE_RECORD', p, 'createdAt is after the anchor');
    for (const email of [inv.sellerEmail, inv.customerEmail, inv.payerEmail]) {
      if (email && !SAFE_EMAIL.test(email)) add('UNSAFE_EMAIL', p, `${email} must use a reserved .test/.example domain`);
    }
    const orgId = inv.metadata?.organizationId;
    if (!orgs.has(orgId)) add('MISSING_REFERENCE', `${p}.metadata.organizationId`, `unknown organization ${orgId}`);
    if (inv.userId && !users.has(inv.userId)) add('MISSING_REFERENCE', `${p}.userId`, `unknown user ${inv.userId}`);
    const dup = inv.metadata?.duplicateOf;
    if (dup && !invoices.has(dup)) add('MISSING_REFERENCE', `${p}.metadata.duplicateOf`, `unknown invoice ${dup}`);

    if (inv.status === 'PAID') {
      if (!inv.paymentTxHash || !TX_HASH.test(inv.paymentTxHash)) add('PAID_WITHOUT_TX', p, 'PAID invoice needs a 64-hex paymentTxHash');
      if (!inv.paidAt || !inv.payerPublicKey) add('PAID_WITHOUT_PAYER', p, 'PAID invoice needs paidAt and payerPublicKey');
      if (inv.paidAt && inv.paidAt > inv.expiresAt) add('PAID_AFTER_EXPIRY', p, 'paidAt is after expiresAt');
      const confirmed = ds.settlements.find((s) => s.invoiceId === inv.id && s.status === 'confirmed');
      if (!confirmed || confirmed.txHash !== inv.paymentTxHash) add('PAID_WITHOUT_SETTLEMENT', p, 'PAID invoice needs a confirmed settlement with the same tx hash');
    } else if (inv.paymentTxHash || inv.paidAt) {
      add('UNPAID_WITH_PAYMENT', p, `${inv.status} invoice must not carry payment fields`);
    }
    // Lazy expiry would immediately flip these, so the seed would not load as written.
    if (inv.status === 'PENDING' && inv.expiresAt.getTime() <= anchor) add('PENDING_PAST_EXPIRY', p, 'PENDING invoice is already past expiresAt');
    if (inv.status === 'EXPIRED' && inv.expiresAt.getTime() > anchor) add('EXPIRED_BEFORE_EXPIRY', p, 'EXPIRED invoice has expiresAt in the future');
  });

  ds.settlements.forEach((s, i) => {
    const p = `settlements[${i}]`;
    const inv = invoices.get(s.invoiceId);
    if (!inv) add('MISSING_REFERENCE', `${p}.invoiceId`, `unknown invoice ${s.invoiceId}`);
    if (!TX_HASH.test(s.txHash)) add('INVALID_TX_HASH', p, 'txHash must be 64 lowercase hex');
    if (s.status === 'failed' && !s.failureReason) add('FAILED_WITHOUT_REASON', p, 'failed settlement needs failureReason');
    if (s.status === 'confirmed' && inv && inv.status !== 'PAID') add('CONFIRMED_ON_UNPAID', p, `confirmed settlement but invoice is ${inv.status}`);
    if (s.status === 'failed' && inv?.paymentTxHash === s.txHash) add('FAILED_MARKED_PAID', p, 'invoice records a failed settlement as its payment');
    if (inv && s.toAddress !== inv.sellerPublicKey) add('WRONG_DESTINATION', p, 'settlement destination is not the invoice seller');
  });

  ds.authorizations.forEach((a, i) => {
    const p = `authorizations[${i}]`;
    if (!users.has(a.subjectId)) add('MISSING_REFERENCE', `${p}.subjectId`, `unknown user ${a.subjectId}`);
    if (!users.has(a.grantedBy)) add('MISSING_REFERENCE', `${p}.grantedBy`, `unknown user ${a.grantedBy}`);
    const target = a.scope.resourceType === 'organization' ? orgs.has(a.scope.resourceId) : invoices.has(a.scope.resourceId);
    if (!target) add('MISSING_REFERENCE', `${p}.scope.resourceId`, `unknown ${a.scope.resourceType} ${a.scope.resourceId}`);
    if (a.expiresAt <= a.issuedAt) add('INVALID_TIMELINE', p, 'expiresAt must be after issuedAt');
    if (a.status === 'revoked' && (!a.revokedAt || !a.revokedBy)) add('REVOKED_WITHOUT_ACTOR', p, 'revoked grant needs revokedAt and revokedBy');
    if (a.status === 'cleaned' && (!a.cleanedAt || a.cleanedAt < a.expiresAt)) add('CLEANED_BEFORE_EXPIRY', p, 'cleaned grant needs cleanedAt at or after expiresAt');
    if (a.status === 'renewed') {
      const next = a.renewedToId ? auths.get(a.renewedToId) : undefined;
      if (!next) add('MISSING_REFERENCE', `${p}.renewedToId`, 'renewed grant must point at its successor');
      else if (next.renewedFromId !== a.id) add('BROKEN_RENEWAL_CHAIN', p, `${next.id} does not point back at ${a.id}`);
    }
    if (a.renewedFromId) {
      const prev = auths.get(a.renewedFromId);
      if (!prev) add('MISSING_REFERENCE', `${p}.renewedFromId`, `unknown authorization ${a.renewedFromId}`);
      else if (prev.status !== 'renewed' || prev.renewedToId !== a.id) add('BROKEN_RENEWAL_CHAIN', p, `${prev.id} is not marked renewed into ${a.id}`);
    }
  });

  ds.workflows.forEach((w, i) => {
    const p = `workflows[${i}]`;
    if (!invoices.has(w.invoiceId)) add('MISSING_REFERENCE', `${p}.invoiceId`, `unknown invoice ${w.invoiceId}`);
    if (!users.has(w.ownerId)) add('MISSING_REFERENCE', `${p}.ownerId`, `unknown user ${w.ownerId}`);
    if (w.slaDueAt <= w.openedAt) add('INVALID_TIMELINE', p, 'slaDueAt must be after openedAt');
    if ((w.state === 'completed') !== Boolean(w.completedAt)) add('COMPLETION_MISMATCH', p, 'completedAt must be set exactly when state is completed');
  });

  ds.jobs.forEach((j, i) => {
    const p = `jobs[${i}]`;
    if (j.invoiceId && !invoices.has(j.invoiceId)) add('MISSING_REFERENCE', `${p}.invoiceId`, `unknown invoice ${j.invoiceId}`);
    if (j.status === 'dead' && !j.lastError) add('DEAD_WITHOUT_ERROR', p, 'dead job needs lastError');
    if ((j.status === 'succeeded' || j.status === 'dead') && !j.completedAt) add('TERMINAL_WITHOUT_COMPLETION', p, `${j.status} job needs completedAt`);
    if (j.attempts < (j.status === 'queued' ? 0 : 1)) add('INVALID_ATTEMPTS', p, 'attempts too low for status');
  });

  ds.externalReferences.forEach((x, i) => {
    const p = `externalReferences[${i}]`;
    const exists = x.resourceType === 'invoice' ? invoices.has(x.resourceId) : settlements.has(x.resourceId);
    if (!exists) add('MISSING_REFERENCE', `${p}.resourceId`, `unknown ${x.resourceType} ${x.resourceId}`);
    if (x.kind === 'stellar_tx') {
      const s = settlements.get(x.resourceId);
      if (s && s.txHash !== x.reference) add('REFERENCE_MISMATCH', p, 'stellar_tx reference differs from settlement txHash');
    }
  });

  ds.auditEvents.forEach((e, i) => {
    const p = `auditEvents[${i}]`;
    const lookup = { invoice: invoices, authorization: auths, user: users, settlement: settlements }[e.entityType];
    if (!lookup.has(e.entityId)) add('MISSING_REFERENCE', `${p}.entityId`, `unknown ${e.entityType} ${e.entityId}`);
    if (!isActor(e.actorId)) add('MISSING_REFERENCE', `${p}.actorId`, `unknown actor ${e.actorId}`);
    if (e.at.getTime() > anchor) add('FUTURE_RECORD', p, 'audit event is after the anchor');
  });

  // Safety net: nothing secret-shaped anywhere in the serialized dataset.
  const serialized = JSON.stringify(ds);
  if (new RegExp(SECRET_KEY_PATTERN.source).test(serialized)) add('SECRET_MATERIAL', '$', 'dataset contains a Stellar secret seed');
  if (SECRET_HINT.test(serialized)) add('SECRET_MATERIAL', '$', 'dataset contains a credential-like field or value');

  const counts = Object.fromEntries(collections.map((c) => [c, ds[c].length]));
  return { ok: issues.length === 0, issues, counts };
}

// ---------------------------------------------------------------------------
// SQL export (loads into the tables db/schema.sql creates)
// ---------------------------------------------------------------------------

const sqlText = (v: unknown): string => {
  if (v === undefined || v === null) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const sqlJson = (v: unknown) => `${sqlText(JSON.stringify(v))}::jsonb`;

/**
 * Idempotent INSERTs (ON CONFLICT DO NOTHING) for the Postgres-backed parts of
 * the dataset: invoices, settlements (as `transactions`) and jobs. The other
 * collections have no table yet and live only in the in-memory fixture.
 */
export function seedDatasetToSql(ds: SeedDataset): string {
  const lines: string[] = ['-- Generated by `npm run seed:fixtures -- --sql`. Do not edit by hand.', 'BEGIN;'];
  for (const inv of ds.invoices) {
    lines.push(
      'INSERT INTO invoices (id, seller_public_key, seller_name, seller_email, amount, asset_code, asset_issuer, memo, description, customer_name, customer_email, status, payment_tx_hash, payer_public_key, payer_name, payer_email, created_at, paid_at, expires_at, metadata) VALUES (' +
        [inv.id, inv.sellerPublicKey, inv.sellerName, inv.sellerEmail, inv.amount, inv.assetCode, inv.assetIssuer, inv.memo, inv.description, inv.customerName, inv.customerEmail, inv.status, inv.paymentTxHash, inv.payerPublicKey, inv.payerName, inv.payerEmail, inv.createdAt, inv.paidAt, inv.expiresAt]
          .map(sqlText)
          .join(', ') +
        `, ${sqlJson(inv.metadata)}) ON CONFLICT DO NOTHING;`
    );
  }
  for (const s of ds.settlements) {
    lines.push(
      'INSERT INTO transactions (id, invoice_id, from_address, to_address, amount, asset_code, tx_hash, memo, processed_at, metadata) VALUES (' +
        [s.id, s.invoiceId, s.fromAddress, s.toAddress, s.amount, s.assetCode, s.txHash, ds.invoices.find((i) => i.id === s.invoiceId)?.memo, s.observedAt].map(sqlText).join(', ') +
        `, ${sqlJson({ source: 'seed', status: s.status, failureReason: s.failureReason ?? null })}) ON CONFLICT DO NOTHING;`
    );
  }
  for (const j of ds.jobs) {
    lines.push(
      'INSERT INTO jobs (id, type, payload, status, attempts, retry_policy, run_at, errors, created_at, updated_at, completed_at) VALUES (' +
        [sqlText(j.id), sqlText(j.type), sqlJson({ version: j.payloadVersion, data: j.invoiceId ? { invoiceId: j.invoiceId } : {} }), sqlText(j.status), String(j.attempts),
          sqlJson({ maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 300000 }), sqlText(j.createdAt),
          sqlJson(j.lastError ? [{ attempt: j.attempts, at: (j.completedAt ?? j.createdAt).toISOString(), message: j.lastError }] : []),
          sqlText(j.createdAt), sqlText(j.completedAt ?? j.createdAt), sqlText(j.completedAt)].join(', ') +
        ') ON CONFLICT DO NOTHING;'
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n') + '\n';
}

/** Deletes only the seeded rows (by id), in foreign-key-safe order. */
export function seedResetSql(ds: SeedDataset): string {
  const list = (ids: string[]) => ids.map(sqlText).join(', ');
  const invoiceIds = list(ds.invoices.map((i) => i.id));
  return [
    '-- Generated by `npm run seed:fixtures -- --reset-sql`. Removes seeded rows only.',
    'BEGIN;',
    `DELETE FROM jobs WHERE id IN (${list(ds.jobs.map((j) => j.id))});`,
    `DELETE FROM transactions WHERE id IN (${list(ds.settlements.map((s) => s.id))});`,
    `DELETE FROM payment_events WHERE invoice_id IN (${invoiceIds});`,
    `DELETE FROM invoices WHERE id IN (${invoiceIds});`,
    'COMMIT;',
  ].join('\n') + '\n';
}
