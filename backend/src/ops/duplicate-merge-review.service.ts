/**
 * Merge review workflow for duplicate invoices (#253).
 *
 * `domain/duplicate-detection.ts` finds candidates; this service turns a
 * candidate into a reviewed, audited, and — where the ledger allows it —
 * reversible decision.
 *
 *   PROPOSED --approve--> APPLIED --finalize--> FINALIZED   (irreversible)
 *      |                     |
 *      +--reject--> REJECTED +--revert--> REVERTED
 *      |
 *      +--(data moved on)--> STALE
 *
 * Applying a merge does **not** touch the invoices. It records that the
 * duplicates are retired in favour of the survivor, which is fully reversible
 * with `revert`. Only `finalize` mutates storage: it cancels the PENDING
 * duplicates through the normal `cancelInvoice` path with the version the
 * reviewer saw, so a duplicate that changed after review is never cancelled
 * blind. Cancellation is the one step that cannot be undone, which is why it is
 * a separate, explicit, audited call.
 *
 * Guarantees:
 *   - Four eyes: the proposer cannot approve their own proposal.
 *   - No overlapping merges: an invoice is in at most one active proposal.
 *   - Staleness: approval re-reads every invoice and refuses if a duplicate is
 *     no longer PENDING at the version captured at proposal time.
 *   - A PAID invoice is never cancelled. A duplicate the customer paid before
 *     finalize is reported (`skipped_paid`) for a refund, not hidden.
 *   - Every transition writes an audit event for the survivor and for each
 *     duplicate, correlated by proposal id.
 */

import { auditStore as defaultAuditStore, type AuditAction, type MemoryAuditStore } from '../audit/audit-service';
import { ConflictError } from '../concurrency/optimistic-lock';
import { duplicateFingerprint, type DuplicateCandidate } from '../domain/duplicate-detection';
import type { InvoiceStorage, StoredInvoice } from '../storage/invoice-storage';

export type MergeStatus = 'PROPOSED' | 'APPLIED' | 'REJECTED' | 'REVERTED' | 'FINALIZED' | 'STALE';

export type MergeErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'SELF_APPROVAL'
  | 'NOT_MERGEABLE'
  | 'STALE_CANDIDATE'
  | 'INVOICE_IN_ACTIVE_MERGE'
  | 'FINALIZE_IN_PROGRESS';

export class MergeReviewError extends Error {
  constructor(readonly code: MergeErrorCode, message: string) {
    super(message);
    this.name = 'MergeReviewError';
  }
}

export interface MergeActor {
  id: string;
  type?: 'maintainer' | 'system';
}

export type FinalizeOutcome = 'cancelled' | 'already_cancelled' | 'skipped_paid' | 'skipped_expired' | 'conflict' | 'missing';

export interface MergeHistoryEntry {
  at: string;
  status: MergeStatus;
  actorId: string;
  reason?: string;
}

export interface MergeProposal {
  proposalId: string;
  candidateId: string;
  fingerprint: string;
  survivorId: string;
  duplicateIds: string[];
  /** Invoice versions seen at proposal time. Finalize cancels with these. */
  versions: Record<string, number>;
  status: MergeStatus;
  proposedBy: string;
  reviewedBy?: string;
  finalizeOutcomes?: Record<string, FinalizeOutcome>;
  history: MergeHistoryEntry[];
}

type MergeStorage = Pick<InvoiceStorage, 'getInvoiceById' | 'cancelInvoice'>;

export interface MergeReviewOptions {
  storage: MergeStorage;
  audit?: Pick<MemoryAuditStore, 'recordEvent'>;
  now?: () => Date;
}

const ACTIVE: ReadonlySet<MergeStatus> = new Set(['PROPOSED', 'APPLIED']);

function copy(proposal: MergeProposal): MergeProposal {
  return structuredClone(proposal);
}

export class DuplicateMergeReviewService {
  private readonly proposals = new Map<string, MergeProposal>();
  private readonly finalizing = new Set<string>();
  private readonly storage: MergeStorage;
  private readonly audit: Pick<MemoryAuditStore, 'recordEvent'>;
  private readonly now: () => Date;
  private sequence = 0;

  constructor(options: MergeReviewOptions) {
    this.storage = options.storage;
    this.audit = options.audit ?? defaultAuditStore;
    this.now = options.now ?? (() => new Date());
  }

  async propose(candidate: DuplicateCandidate, actor: MergeActor, reason?: string): Promise<MergeProposal> {
    const invoices = await this.load([candidate.survivorId, ...candidate.duplicateIds]);
    this.assertMergeable(candidate, invoices);

    // Checked after the awaits so two concurrent proposals cannot both pass.
    for (const id of [candidate.survivorId, ...candidate.duplicateIds]) {
      const active = this.activeProposalFor(id);
      if (active) {
        throw new MergeReviewError(
          'INVOICE_IN_ACTIVE_MERGE',
          `Invoice ${id} is already part of ${active.status} proposal ${active.proposalId}.`
        );
      }
    }

    const proposal: MergeProposal = {
      proposalId: `mrg_${++this.sequence}_${candidate.candidateId}`,
      candidateId: candidate.candidateId,
      fingerprint: candidate.fingerprint,
      survivorId: candidate.survivorId,
      duplicateIds: [...candidate.duplicateIds],
      versions: Object.fromEntries(invoices.map((invoice) => [invoice!.id, invoice!.version ?? 1])),
      status: 'PROPOSED',
      proposedBy: actor.id,
      history: [],
    };
    this.proposals.set(proposal.proposalId, proposal);
    this.transition(proposal, 'PROPOSED', 'DUPLICATE_MERGE_PROPOSED', actor, reason ?? candidate.reason);
    return copy(proposal);
  }

  /** Records the merge. Invoices are untouched, so this is reversible with `revert`. */
  async approve(proposalId: string, reviewer: MergeActor, reason?: string): Promise<MergeProposal> {
    const proposal = this.require(proposalId);
    this.assertStatus(proposal, 'PROPOSED', 'approve');
    if (reviewer.id === proposal.proposedBy) {
      throw new MergeReviewError('SELF_APPROVAL', 'A merge must be approved by someone other than its proposer.');
    }

    const invoices = await this.load([proposal.survivorId, ...proposal.duplicateIds]);
    // Re-check after the await: a concurrent approve/reject may have won.
    this.assertStatus(proposal, 'PROPOSED', 'approve');

    const staleReason = this.staleness(proposal, invoices);
    if (staleReason) {
      this.transition(proposal, 'STALE', 'DUPLICATE_MERGE_REJECTED', reviewer, staleReason);
      throw new MergeReviewError('STALE_CANDIDATE', staleReason);
    }

    proposal.reviewedBy = reviewer.id;
    this.transition(proposal, 'APPLIED', 'DUPLICATE_MERGE_APPROVED', reviewer, reason);
    return copy(proposal);
  }

  async reject(proposalId: string, reviewer: MergeActor, reason: string): Promise<MergeProposal> {
    const proposal = this.require(proposalId);
    this.assertStatus(proposal, 'PROPOSED', 'reject');
    proposal.reviewedBy = reviewer.id;
    this.transition(proposal, 'REJECTED', 'DUPLICATE_MERGE_REJECTED', reviewer, reason);
    return copy(proposal);
  }

  async revert(proposalId: string, actor: MergeActor, reason: string): Promise<MergeProposal> {
    const proposal = this.require(proposalId);
    if (proposal.status === 'FINALIZED') {
      throw new MergeReviewError(
        'INVALID_TRANSITION',
        `Proposal ${proposalId} is FINALIZED: its duplicates were cancelled and cannot be reinstated. Create a new invoice instead.`
      );
    }
    if (this.finalizing.has(proposalId)) {
      throw new MergeReviewError('FINALIZE_IN_PROGRESS', `Proposal ${proposalId} is being finalized.`);
    }
    this.assertStatus(proposal, 'APPLIED', 'revert');
    this.transition(proposal, 'REVERTED', 'DUPLICATE_MERGE_REVERTED', actor, reason);
    return copy(proposal);
  }

  /**
   * Cancels the duplicates. Irreversible. Safe to retry: invoices already
   * cancelled by an earlier attempt are skipped, and the proposal only reaches
   * FINALIZED once every duplicate has a terminal outcome.
   */
  async finalize(proposalId: string, actor: MergeActor): Promise<MergeProposal> {
    const proposal = this.require(proposalId);
    this.assertStatus(proposal, 'APPLIED', 'finalize');
    if (this.finalizing.has(proposalId)) {
      throw new MergeReviewError('FINALIZE_IN_PROGRESS', `Proposal ${proposalId} is already being finalized.`);
    }

    this.finalizing.add(proposalId);
    try {
      const outcomes: Record<string, FinalizeOutcome> = { ...proposal.finalizeOutcomes };
      for (const id of proposal.duplicateIds) {
        if (outcomes[id] && outcomes[id] !== 'conflict') continue;
        outcomes[id] = await this.cancelDuplicate(id, proposal.versions[id]);
      }
      proposal.finalizeOutcomes = outcomes;

      const blocked = Object.entries(outcomes).filter(([, outcome]) => outcome === 'conflict');
      if (blocked.length > 0) {
        this.record(proposal, 'DUPLICATE_MERGE_FINALIZED', actor, 'APPLIED', 'APPLIED',
          `finalize blocked by concurrent changes to ${blocked.map(([id]) => id).join(', ')}; revert and re-propose`);
        return copy(proposal);
      }

      this.transition(proposal, 'FINALIZED', 'DUPLICATE_MERGE_FINALIZED', actor, undefined);
      return copy(proposal);
    } finally {
      this.finalizing.delete(proposalId);
    }
  }

  getProposal(proposalId: string): MergeProposal | null {
    const proposal = this.proposals.get(proposalId);
    return proposal ? copy(proposal) : null;
  }

  listProposals(status?: MergeStatus): MergeProposal[] {
    return [...this.proposals.values()].filter((p) => !status || p.status === status).map(copy);
  }

  /** The survivor an invoice was merged into, or null if it is not a retired duplicate. */
  retiredInto(invoiceId: string): string | null {
    for (const proposal of this.proposals.values()) {
      if ((proposal.status === 'APPLIED' || proposal.status === 'FINALIZED') && proposal.duplicateIds.includes(invoiceId)) {
        return proposal.survivorId;
      }
    }
    return null;
  }

  private async cancelDuplicate(id: string, version: number): Promise<FinalizeOutcome> {
    const invoice = await this.storage.getInvoiceById(id);
    if (!invoice) return 'missing';
    if (invoice.status === 'PAID') return 'skipped_paid';
    if (invoice.status === 'EXPIRED') return 'skipped_expired';
    if (invoice.status === 'CANCELLED') return 'already_cancelled';
    try {
      await this.storage.cancelInvoice(id, version);
      return 'cancelled';
    } catch (error) {
      if (error instanceof ConflictError) return 'conflict';
      throw error;
    }
  }

  private async load(ids: string[]): Promise<Array<StoredInvoice | null>> {
    return Promise.all(ids.map((id) => this.storage.getInvoiceById(id)));
  }

  private assertMergeable(candidate: DuplicateCandidate, invoices: Array<StoredInvoice | null>): void {
    if (candidate.duplicateIds.length === 0 || candidate.duplicateIds.includes(candidate.survivorId)) {
      throw new MergeReviewError('NOT_MERGEABLE', 'A candidate needs a survivor and at least one distinct duplicate.');
    }
    const [survivor, ...duplicates] = invoices;
    if (!survivor || (survivor.status !== 'PAID' && survivor.status !== 'PENDING')) {
      throw new MergeReviewError('NOT_MERGEABLE', `Survivor ${candidate.survivorId} is missing or no longer live.`);
    }
    for (const [index, invoice] of invoices.entries()) {
      const id = index === 0 ? candidate.survivorId : candidate.duplicateIds[index - 1];
      if (!invoice || duplicateFingerprint(invoice) !== candidate.fingerprint) {
        throw new MergeReviewError('NOT_MERGEABLE', `Invoice ${id} no longer matches the candidate fingerprint.`);
      }
    }
    for (const duplicate of duplicates) {
      if (duplicate!.status !== 'PENDING') {
        throw new MergeReviewError('NOT_MERGEABLE', `Duplicate ${duplicate!.id} is ${duplicate!.status}, not PENDING.`);
      }
    }
  }

  private staleness(proposal: MergeProposal, invoices: Array<StoredInvoice | null>): string | null {
    const [survivor, ...duplicates] = invoices;
    if (!survivor || (survivor.status !== 'PAID' && survivor.status !== 'PENDING')) {
      return `survivor ${proposal.survivorId} is no longer live`;
    }
    for (const [index, duplicate] of duplicates.entries()) {
      const id = proposal.duplicateIds[index];
      if (!duplicate) return `duplicate ${id} no longer exists`;
      if (duplicate.status !== 'PENDING') return `duplicate ${id} is now ${duplicate.status}`;
      if ((duplicate.version ?? 1) !== proposal.versions[id]) {
        return `duplicate ${id} changed since proposal (version ${proposal.versions[id]} -> ${duplicate.version ?? 1})`;
      }
    }
    return null;
  }

  private activeProposalFor(invoiceId: string): MergeProposal | null {
    for (const proposal of this.proposals.values()) {
      if (ACTIVE.has(proposal.status) && (proposal.survivorId === invoiceId || proposal.duplicateIds.includes(invoiceId))) {
        return proposal;
      }
    }
    return null;
  }

  private require(proposalId: string): MergeProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new MergeReviewError('NOT_FOUND', `Merge proposal ${proposalId} not found.`);
    return proposal;
  }

  private assertStatus(proposal: MergeProposal, expected: MergeStatus, action: string): void {
    if (proposal.status !== expected) {
      throw new MergeReviewError(
        'INVALID_TRANSITION',
        `Cannot ${action} proposal ${proposal.proposalId}: it is ${proposal.status}, expected ${expected}.`
      );
    }
  }

  private transition(
    proposal: MergeProposal,
    to: MergeStatus,
    action: AuditAction,
    actor: MergeActor,
    reason: string | undefined
  ): void {
    const from = proposal.history.length === 0 ? null : proposal.status;
    proposal.status = to;
    proposal.history.push({ at: this.now().toISOString(), status: to, actorId: actor.id, reason });
    this.record(proposal, action, actor, from, to, reason);
  }

  private record(
    proposal: MergeProposal,
    action: AuditAction,
    actor: MergeActor,
    from: MergeStatus | null,
    to: MergeStatus,
    reason: string | undefined
  ): void {
    const timestamp = this.now().toISOString();
    for (const entityId of [proposal.survivorId, ...proposal.duplicateIds]) {
      this.audit.recordEvent({
        action,
        timestamp,
        actor: { type: actor.type ?? 'maintainer', id: actor.id },
        scope: { entityType: 'invoice', entityId },
        reason,
        beforeState: from ? { mergeStatus: from } : null,
        afterState: { mergeStatus: to },
        metadata: {
          proposalId: proposal.proposalId,
          candidateId: proposal.candidateId,
          survivorId: proposal.survivorId,
          duplicateIds: proposal.duplicateIds,
          role: entityId === proposal.survivorId ? 'survivor' : 'duplicate',
          ...(proposal.finalizeOutcomes ? { finalizeOutcomes: proposal.finalizeOutcomes } : {}),
        },
        correlationId: proposal.proposalId,
      });
    }
  }
}
