/**
 * Duplicate detection and merge review workflow (#253).
 *
 * Detection must be reproducible (same data -> same candidates and ids, in any
 * input order); merges must be reviewable (four eyes, staleness), reversible
 * until finalized, and audited on every invoice they touch.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDuplicateCandidates,
  duplicateFingerprint,
  type DuplicateInput,
} from '../src/domain/duplicate-detection';
import { DuplicateMergeReviewService, MergeReviewError } from '../src/ops/duplicate-merge-review.service';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { MemoryStorage } from '../src/storage/memory-storage';
import type { CreateInvoiceInput } from '../src/utils/validation';

const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SELLER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

function inv(id: string, overrides: Partial<DuplicateInput> = {}): DuplicateInput {
  return {
    id,
    sellerPublicKey: SELLER,
    amount: 25,
    assetCode: 'XLM',
    customerEmail: 'buyer@example.com',
    description: 'Logo design',
    status: 'PENDING',
    createdAt: new Date(T0),
    ...overrides,
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('duplicate detection (#253)', () => {
  it('groups invoices that differ only in email case, whitespace and amount scale', () => {
    const a = inv('a');
    const b = inv('b', { customerEmail: '  BUYER@Example.com ', description: 'logo   DESIGN', amount: 25.0000000, createdAt: new Date(T0 + MINUTE) });
    assert.equal(duplicateFingerprint(a), duplicateFingerprint(b));

    const result = detectDuplicateCandidates([a, b]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].survivorId, 'a');
    assert.deepEqual(result.candidates[0].duplicateIds, ['b']);
  });

  it('is reproducible: identical candidates and ids for any input order', () => {
    const invoices: DuplicateInput[] = [];
    for (let i = 0; i < 40; i++) {
      invoices.push(inv(`inv-${String(i).padStart(3, '0')}`, {
        customerEmail: `c${i % 7}@example.com`,
        amount: 10 + (i % 3),
        createdAt: new Date(T0 + i * MINUTE),
      }));
    }
    const baseline = detectDuplicateCandidates(invoices);
    assert.ok(baseline.candidates.length > 0);
    for (const seed of [1, 7, 42, 1337]) {
      assert.deepEqual(detectDuplicateCandidates(seededShuffle(invoices, seed)), baseline);
    }
  });

  it('never fingerprints invoices without a customer email or description', () => {
    const result = detectDuplicateCandidates([
      inv('a', { customerEmail: undefined, description: undefined }),
      inv('b', { customerEmail: undefined, description: '   ' }),
    ]);
    assert.equal(result.skippedInsufficientSignal, 2);
    assert.equal(result.candidates.length, 0);
  });

  it('keeps different sellers, assets, issuers and amounts apart', () => {
    const result = detectDuplicateCandidates([
      inv('a'),
      inv('b', { sellerPublicKey: OTHER_SELLER }),
      inv('c', { assetCode: 'USDC', assetIssuer: OTHER_SELLER }),
      inv('d', { amount: 25.0000001 }),
    ]);
    assert.equal(result.candidates.length, 0);
  });

  it('only clusters invoices created within the window', () => {
    const result = detectDuplicateCandidates(
      [inv('a'), inv('b', { createdAt: new Date(T0 + 30 * MINUTE) })],
      { windowMs: 10 * MINUTE }
    );
    assert.equal(result.candidates.length, 0);
  });

  it('prefers a PAID survivor and never proposes merging inert invoices', () => {
    const result = detectDuplicateCandidates([
      inv('a', { status: 'CANCELLED' }),
      inv('b', { status: 'PENDING', createdAt: new Date(T0 + MINUTE) }),
      inv('c', { status: 'PAID', createdAt: new Date(T0 + 2 * MINUTE) }),
      inv('d', { status: 'EXPIRED', createdAt: new Date(T0 + 3 * MINUTE) }),
    ]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].survivorId, 'c');
    assert.deepEqual(result.candidates[0].duplicateIds, ['b']);
    assert.deepEqual(result.candidates[0].memberIds, ['a', 'b', 'c', 'd']);
  });

  it('reports two PAID invoices as a conflict instead of a merge', () => {
    const result = detectDuplicateCandidates([
      inv('a', { status: 'PAID' }),
      inv('b', { status: 'PAID', createdAt: new Date(T0 + MINUTE) }),
      inv('c', { createdAt: new Date(T0 + 2 * MINUTE) }),
    ]);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.conflicts, [
      { fingerprint: duplicateFingerprint(inv('a'))!, memberIds: ['a', 'b', 'c'], reason: 'multiple_settled' },
    ]);
  });
});

describe('merge review workflow (#253)', () => {
  const PROPOSER = { id: 'maintainer-alice' };
  const REVIEWER = { id: 'maintainer-bob' };

  let storage: MemoryInvoiceStorage;
  let audit: MemoryAuditStore;
  let service: DuplicateMergeReviewService;

  beforeEach(() => {
    storage = new MemoryInvoiceStorage(new InvoiceMemoryService(new MemoryStorage(), { ttlMs: 0 }));
    audit = new MemoryAuditStore();
    service = new DuplicateMergeReviewService({ storage, audit, now: () => new Date(T0) });
  });

  async function seedDuplicates(count = 2) {
    const input = {
      sellerPublicKey: SELLER,
      amount: 40,
      assetCode: 'XLM',
      customerEmail: 'buyer@example.com',
      description: 'Consulting',
      expiresInDays: 7,
    } as CreateInvoiceInput;
    for (let i = 0; i < count; i++) await storage.createInvoice(input);
    const scan = detectDuplicateCandidates(await storage.getAllInvoices());
    assert.equal(scan.candidates.length, 1);
    return scan.candidates[0];
  }

  it('propose -> approve records a reversible merge without touching invoices', async () => {
    const candidate = await seedDuplicates(3);
    const proposal = await service.propose(candidate, PROPOSER);
    assert.equal(proposal.status, 'PROPOSED');

    const applied = await service.approve(proposal.proposalId, REVIEWER);
    assert.equal(applied.status, 'APPLIED');
    for (const id of candidate.duplicateIds) {
      assert.equal(service.retiredInto(id), candidate.survivorId);
      assert.equal((await storage.getInvoiceById(id))!.status, 'PENDING');
    }

    const reverted = await service.revert(proposal.proposalId, REVIEWER, 'customer confirmed two orders');
    assert.equal(reverted.status, 'REVERTED');
    for (const id of candidate.duplicateIds) assert.equal(service.retiredInto(id), null);
    assert.deepEqual(reverted.history.map((h) => h.status), ['PROPOSED', 'APPLIED', 'REVERTED']);
  });

  it('rejects self-approval (four eyes)', async () => {
    const proposal = await service.propose(await seedDuplicates(), PROPOSER);
    await assert.rejects(service.approve(proposal.proposalId, PROPOSER), (e: MergeReviewError) => e.code === 'SELF_APPROVAL');
    assert.equal(service.getProposal(proposal.proposalId)!.status, 'PROPOSED');
  });

  it('refuses overlapping proposals for the same invoice', async () => {
    const candidate = await seedDuplicates();
    await service.propose(candidate, PROPOSER);
    await assert.rejects(service.propose(candidate, REVIEWER), (e: MergeReviewError) => e.code === 'INVOICE_IN_ACTIVE_MERGE');
  });

  it('allows a fresh proposal after a rejection', async () => {
    const candidate = await seedDuplicates();
    const first = await service.propose(candidate, PROPOSER);
    await service.reject(first.proposalId, REVIEWER, 'not sure yet');
    const second = await service.propose(candidate, PROPOSER);
    assert.notEqual(second.proposalId, first.proposalId);
    assert.equal(second.candidateId, first.candidateId);
  });

  it('marks a proposal STALE when a duplicate changes before approval', async () => {
    const candidate = await seedDuplicates();
    const proposal = await service.propose(candidate, PROPOSER);
    await storage.markAsPaid(candidate.duplicateIds[0], 'tx-dup', SELLER);

    await assert.rejects(service.approve(proposal.proposalId, REVIEWER), (e: MergeReviewError) => e.code === 'STALE_CANDIDATE');
    assert.equal(service.getProposal(proposal.proposalId)!.status, 'STALE');
  });

  it('finalize cancels duplicates with the reviewed version and is not revertible', async () => {
    const candidate = await seedDuplicates(3);
    const proposal = await service.propose(candidate, PROPOSER);
    await service.approve(proposal.proposalId, REVIEWER);

    const finalized = await service.finalize(proposal.proposalId, REVIEWER);
    assert.equal(finalized.status, 'FINALIZED');
    for (const id of candidate.duplicateIds) {
      assert.equal(finalized.finalizeOutcomes![id], 'cancelled');
      assert.equal((await storage.getInvoiceById(id))!.status, 'CANCELLED');
    }
    assert.equal((await storage.getInvoiceById(candidate.survivorId))!.status, 'PENDING');
    await assert.rejects(service.revert(proposal.proposalId, REVIEWER, 'oops'), (e: MergeReviewError) => e.code === 'INVALID_TRANSITION');
  });

  it('finalize never cancels a duplicate the customer paid after approval', async () => {
    const candidate = await seedDuplicates();
    const proposal = await service.propose(candidate, PROPOSER);
    await service.approve(proposal.proposalId, REVIEWER);
    await storage.markAsPaid(candidate.duplicateIds[0], 'tx-late', SELLER);

    const finalized = await service.finalize(proposal.proposalId, REVIEWER);
    assert.equal(finalized.finalizeOutcomes![candidate.duplicateIds[0]], 'skipped_paid');
    assert.equal((await storage.getInvoiceById(candidate.duplicateIds[0]))!.status, 'PAID');
  });

  it('finalize stops on a version conflict and can be retried once the conflict resolves', async () => {
    const candidate = await seedDuplicates();
    const proposal = await service.propose(candidate, PROPOSER);
    await service.approve(proposal.proposalId, REVIEWER);

    const dupId = candidate.duplicateIds[0];
    const original = storage.cancelInvoice.bind(storage);
    storage.cancelInvoice = async () => {
      const { ConflictError } = await import('../src/concurrency/optimistic-lock');
      throw new ConflictError(2, 1);
    };
    const blocked = await service.finalize(proposal.proposalId, REVIEWER);
    assert.equal(blocked.status, 'APPLIED');
    assert.equal(blocked.finalizeOutcomes![dupId], 'conflict');

    storage.cancelInvoice = original;
    const finalized = await service.finalize(proposal.proposalId, REVIEWER);
    assert.equal(finalized.status, 'FINALIZED');
    assert.equal(finalized.finalizeOutcomes![dupId], 'cancelled');
  });

  it('writes a correlated audit event on every involved invoice for each transition', async () => {
    const candidate = await seedDuplicates();
    const proposal = await service.propose(candidate, PROPOSER);
    await service.approve(proposal.proposalId, REVIEWER);
    await service.finalize(proposal.proposalId, REVIEWER);

    for (const id of [candidate.survivorId, ...candidate.duplicateIds]) {
      const actions = audit.getEventsByEntity(id).map((e) => e.action).reverse();
      assert.deepEqual(actions, ['DUPLICATE_MERGE_PROPOSED', 'DUPLICATE_MERGE_APPROVED', 'DUPLICATE_MERGE_FINALIZED']);
      for (const event of audit.getEventsByEntity(id)) {
        assert.equal(event.correlationId, proposal.proposalId);
        assert.equal(event.metadata!.survivorId, candidate.survivorId);
      }
    }
    assert.equal(audit.verifyChain().valid, true);
  });

  it('lets exactly one of two concurrent reviewers decide a proposal', async () => {
    const proposal = await service.propose(await seedDuplicates(), PROPOSER);
    const results = await Promise.allSettled([
      service.approve(proposal.proposalId, REVIEWER),
      service.approve(proposal.proposalId, { id: 'maintainer-carol' }),
      service.reject(proposal.proposalId, { id: 'maintainer-dave' }, 'racing'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) {
      if (r.status === 'rejected') assert.equal((r.reason as MergeReviewError).code, 'INVALID_TRANSITION');
    }
  });
});
