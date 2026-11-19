/**
 * Deterministic duplicate invoice detection (#253).
 *
 * A seller who double-clicks "create", or an import that is replayed, leaves
 * two PENDING invoices asking the same customer for the same money. Either can
 * be paid, and if both are, the customer has paid twice. This module finds
 * those pairs; `ops/duplicate-merge-review.service.ts` decides what to do with
 * them.
 *
 * Detection is a **pure function** of the invoices it is given:
 *
 *   - no clock, no randomness, no storage access;
 *   - input order does not matter (everything is sorted on stable keys first);
 *   - candidate ids are content hashes, so the same data always yields the
 *     same ids and a proposal made yesterday can be matched against a scan
 *     made today.
 *
 * Two invoices are duplicate candidates when they share a fingerprint
 * (seller, asset, amount, normalised customer email, normalised description)
 * and were created within `windowMs` of each other. Invoices with neither a
 * customer email nor a description are never fingerprinted: "same seller,
 * same amount" alone is a tip jar, not a duplicate.
 */

import { createHash } from 'node:crypto';
import type { InvoiceStatus, StoredInvoice } from '../storage/invoice-storage';

export const DEFAULT_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fields the detector reads. Anything else on the invoice is ignored. */
export type DuplicateInput = Pick<
  StoredInvoice,
  'id' | 'sellerPublicKey' | 'amount' | 'assetCode' | 'assetIssuer' | 'customerEmail' | 'description' | 'status' | 'createdAt'
>;

export interface DuplicateCandidate {
  /** Content hash of fingerprint + members. Stable across scans. */
  candidateId: string;
  fingerprint: string;
  /** The invoice that remains authoritative after a merge. */
  survivorId: string;
  /** PENDING invoices that a merge would retire, oldest first. */
  duplicateIds: string[];
  /** Every invoice in the cluster, including inert EXPIRED / CANCELLED ones. */
  memberIds: string[];
  reason: string;
}

export interface DuplicateConflict {
  fingerprint: string;
  memberIds: string[];
  reason: 'multiple_settled';
}

export interface DuplicateScanResult {
  scanned: number;
  /** Invoices with no customer email and no description: not enough signal. */
  skippedInsufficientSignal: number;
  candidates: DuplicateCandidate[];
  /** Clusters a merge must not touch (e.g. two PAID invoices). Needs a human, not a merge. */
  conflicts: DuplicateConflict[];
}

export interface DetectOptions {
  windowMs?: number;
}

const STATUS_PREFERENCE: Record<InvoiceStatus, number> = {
  PAID: 0,
  PENDING: 1,
  EXPIRED: 2,
  CANCELLED: 3,
};

function normalizeText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareOldestFirst(a: DuplicateInput, b: DuplicateInput): number {
  return (
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Fingerprint used to group invoices, or null when the invoice carries too
 * little to tell a duplicate from a legitimate repeat charge.
 */
export function duplicateFingerprint(invoice: DuplicateInput): string | null {
  const email = normalizeText(invoice.customerEmail);
  const description = normalizeText(invoice.description);
  if (!email && !description) return null;

  // Stellar amounts carry 7 decimal places; fixing the scale keeps 10 and
  // 10.0000000 in the same bucket without float noise splitting them.
  const parts = [
    invoice.sellerPublicKey,
    invoice.assetCode || 'XLM',
    invoice.assetIssuer ?? '',
    Number(invoice.amount).toFixed(7),
    email,
    description,
  ];
  return sha256(parts.join('\u001f'));
}

/** Survivor: a settled invoice if there is one, else the oldest live one. */
function pickSurvivor(members: DuplicateInput[]): DuplicateInput {
  return [...members].sort(
    (a, b) => STATUS_PREFERENCE[a.status] - STATUS_PREFERENCE[b.status] || compareOldestFirst(a, b)
  )[0];
}

/** Splits a fingerprint group into clusters of invoices created within `windowMs` of a neighbour. */
function clusterByWindow(sorted: DuplicateInput[], windowMs: number): DuplicateInput[][] {
  const clusters: DuplicateInput[][] = [];
  let current: DuplicateInput[] = [];
  for (const invoice of sorted) {
    const previous = current.at(-1);
    if (previous && new Date(invoice.createdAt).getTime() - new Date(previous.createdAt).getTime() > windowMs) {
      clusters.push(current);
      current = [];
    }
    current.push(invoice);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Pure and order-independent: the same set of invoices always yields the same
 * candidates, in the same order, with the same ids. O(n log n).
 */
export function detectDuplicateCandidates(
  invoices: readonly DuplicateInput[],
  options: DetectOptions = {}
): DuplicateScanResult {
  const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
  const groups = new Map<string, DuplicateInput[]>();
  let skippedInsufficientSignal = 0;

  for (const invoice of invoices) {
    const fingerprint = duplicateFingerprint(invoice);
    if (!fingerprint) {
      skippedInsufficientSignal++;
      continue;
    }
    const group = groups.get(fingerprint);
    if (group) group.push(invoice);
    else groups.set(fingerprint, [invoice]);
  }

  const candidates: Array<DuplicateCandidate & { survivorCreatedAt: number }> = [];
  const conflicts: DuplicateConflict[] = [];

  for (const [fingerprint, group] of groups) {
    if (group.length < 2) continue;
    group.sort(compareOldestFirst);

    for (const cluster of clusterByWindow(group, windowMs)) {
      if (cluster.length < 2) continue;
      const memberIds = cluster.map((invoice) => invoice.id);

      if (cluster.filter((invoice) => invoice.status === 'PAID').length > 1) {
        conflicts.push({ fingerprint, memberIds, reason: 'multiple_settled' });
        continue;
      }

      const survivor = pickSurvivor(cluster);
      const duplicateIds = cluster
        .filter((invoice) => invoice.id !== survivor.id && invoice.status === 'PENDING')
        .map((invoice) => invoice.id);
      if (duplicateIds.length === 0) continue;

      candidates.push({
        candidateId: `dup_${sha256([fingerprint, survivor.id, ...duplicateIds].join('|')).slice(0, 24)}`,
        fingerprint,
        survivorId: survivor.id,
        duplicateIds,
        memberIds,
        reason:
          survivor.status === 'PAID'
            ? `${duplicateIds.length} PENDING invoice(s) duplicate an invoice that is already PAID`
            : `${duplicateIds.length} PENDING invoice(s) duplicate an older invoice within ${Math.round(windowMs / 60000)} min`,
        survivorCreatedAt: new Date(survivor.createdAt).getTime(),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.survivorCreatedAt - b.survivorCreatedAt || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0)
  );
  conflicts.sort((a, b) => (a.memberIds[0] < b.memberIds[0] ? -1 : a.memberIds[0] > b.memberIds[0] ? 1 : 0));

  return {
    scanned: invoices.length,
    skippedInsufficientSignal,
    candidates: candidates.map(({ survivorCreatedAt: _unused, ...candidate }) => candidate),
    conflicts,
  };
}
