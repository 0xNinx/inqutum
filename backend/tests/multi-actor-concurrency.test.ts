/**
 * Multi-actor concurrency harness scenarios (#243).
 *
 * Each scenario runs across many seeds; each seed is a different, exactly
 * reproducible interleaving of actors that read, pause (where real code would
 * await Horizon or the network), and write. A failure message names the seed.
 *
 * Covered: concurrent actors, duplicate submissions, stale versions, retry
 * storms, and the merge-review workflow from #253 under racing reviewers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  forEachSeed,
  runConcurrentActors,
  seedRange,
  type ActorSpec,
} from '../src/concurrency/multi-actor-harness';
import { ConflictError } from '../src/concurrency/optimistic-lock';
import { InvoiceLockManager } from '../src/concurrency/lock-manager';
import { MemoryStorage } from '../src/storage/memory-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { detectDuplicateCandidates } from '../src/domain/duplicate-detection';
import { DuplicateMergeReviewService } from '../src/ops/duplicate-merge-review.service';
import type { CreateInvoiceInput } from '../src/utils/validation';

const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYER = 'GCCCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SEEDS = seedRange(30);

const INPUT = {
  sellerPublicKey: SELLER,
  amount: 12,
  assetCode: 'XLM',
  customerEmail: 'buyer@example.com',
  description: 'Race',
  expiresInDays: 7,
} as CreateInvoiceInput;

function fixture() {
  const raw = new MemoryStorage();
  const storage = new MemoryInvoiceStorage(new InvoiceMemoryService(raw, { ttlMs: 0 }));
  return { raw, storage, locks: new InvoiceLockManager() };
}

/** Mirrors the verifyPayment handler: lock, re-read, (await Horizon), write. */
function payer(
  id: string,
  env: ReturnType<typeof fixture>,
  invoiceId: string,
  txHash: string,
  useVersion = false
): ActorSpec<unknown> {
  return {
    id,
    async run(ctx) {
      const before = await env.storage.getInvoiceById(invoiceId);
      await ctx.pause();
      const release = await env.locks.acquire(invoiceId);
      try {
        await ctx.pause(); // Horizon lookup
        return await env.storage.markAsPaid(invoiceId, txHash, PAYER, undefined, useVersion ? before!.version : undefined);
      } finally {
        release();
      }
    },
  };
}

describe('multi-actor harness (#243): determinism', () => {
  async function scenario(seed: number) {
    const env = fixture();
    const invoice = await env.storage.createInvoice(INPUT);
    const actors = Array.from({ length: 6 }, (_, i) => payer(`payer-${i}`, env, invoice.id, `tx-${i}`));
    return runConcurrentActors(actors, { seed });
  }

  it('replays the identical interleaving for the same seed', async () => {
    const a = await scenario(1234);
    const b = await scenario(1234);
    assert.deepEqual(a.trace, b.trace);
    assert.deepEqual(a.outcomes.map((o) => [o.actorId, o.ok]), b.outcomes.map((o) => [o.actorId, o.ok]));
  });

  it('explores different interleavings across seeds', async () => {
    const winners = new Set<string>();
    for (const seed of SEEDS) {
      const report = await scenario(seed);
      winners.add(report.outcomes.find((o) => o.ok)!.actorId);
    }
    assert.ok(winners.size > 1, `expected several distinct winners across seeds, got ${[...winners]}`);
  });
});

describe('multi-actor harness (#243): duplicate submissions', () => {
  it('exactly one of many concurrent payments settles an invoice', async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const env = fixture();
      const invoice = await env.storage.createInvoice(INPUT);
      const report = await runConcurrentActors(
        Array.from({ length: 10 }, (_, i) => payer(`payer-${i}`, env, invoice.id, `tx-${i}`)),
        { seed }
      );

      assert.equal(report.succeeded, 1);
      const winner = report.outcomes.find((o) => o.ok)!;
      const final = await env.storage.getInvoiceById(invoice.id);
      assert.equal(final!.status, 'PAID');
      assert.equal(final!.paymentTxHash, `tx-${winner.actorId.split('-')[1]}`);
      assert.equal(final!.version, 2, 'one write, one version bump');
      assert.equal(env.locks.activeLocks, 0, 'every lock released');
    });
  });

  it('the same transaction hash can settle at most one of two invoices', async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const env = fixture();
      const a = await env.storage.createInvoice(INPUT);
      const b = await env.storage.createInvoice(INPUT);
      const report = await runConcurrentActors(
        [payer('pay-a', env, a.id, 'tx-shared'), payer('pay-b', env, b.id, 'tx-shared')],
        { seed }
      );
      assert.equal(report.succeeded, 1);
      const paid = (await env.storage.getAllInvoices()).filter((i) => i.paymentTxHash === 'tx-shared');
      assert.equal(paid.length, 1);
    });
  });
});

describe('multi-actor harness (#243): stale versions', () => {
  it('cancel and pay racing on the same version: exactly one write wins', async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const env = fixture();
      const invoice = await env.storage.createInvoice(INPUT);
      const seller: ActorSpec<unknown> = {
        id: 'seller-cancel',
        async run(ctx) {
          const seen = await env.storage.getInvoiceById(invoice.id);
          await ctx.pause();
          return env.storage.cancelInvoice(invoice.id, seen!.version);
        },
      };
      const report = await runConcurrentActors(
        [seller, payer('payer', env, invoice.id, 'tx-1', true), payer('payer-2', env, invoice.id, 'tx-2', true)],
        { seed }
      );

      assert.equal(report.succeeded, 1);
      const winner = report.outcomes.find((o) => o.ok)!;
      const final = await env.storage.getInvoiceById(invoice.id);
      assert.equal(final!.status, winner.actorId === 'seller-cancel' ? 'CANCELLED' : 'PAID');
      assert.equal(final!.version, 2);
      for (const loser of report.outcomes.filter((o) => !o.ok)) {
        assert.ok(
          loser.error instanceof ConflictError || /already processed/.test(String((loser.error as Error).message)),
          `unexpected loser error: ${loser.errorCode}`
        );
      }
    });
  });
});

describe('multi-actor harness (#243): retry storms', () => {
  /** Read-modify-write that appends the actor id to a list. */
  function appender(id: string, raw: MemoryStorage, invoiceId: string, guarded: boolean): ActorSpec<unknown> {
    return {
      id,
      retry: { maxAttempts: 20, shouldRetry: (error) => error instanceof ConflictError },
      async run(ctx) {
        const seen = raw.getInvoiceById(invoiceId)!;
        const tags: string[] = [...(seen.metadata?.tags ?? [])];
        await ctx.pause();
        return raw.updateInvoice(invoiceId, { metadata: { tags: [...tags, id] } }, guarded ? seen.version : undefined);
      },
    };
  }

  it('OCC + retry converges with no lost updates', async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const env = fixture();
      const invoice = await env.storage.createInvoice(INPUT);
      const ids = Array.from({ length: 12 }, (_, i) => `writer-${i}`);
      const report = await runConcurrentActors(ids.map((id) => appender(id, env.raw, invoice.id, true)), { seed });

      assert.equal(report.succeeded, ids.length);
      const final = env.raw.getInvoiceById(invoice.id)!;
      assert.deepEqual([...final.metadata.tags].sort(), [...ids].sort(), 'every write survives exactly once');
      assert.equal(final.version, 1 + ids.length);
      assert.equal(report.totalAttempts - ids.length, report.trace.filter((t) => t.event === 'retry').length);
    });
  });

  it('without a version guard the same storm loses updates (the harness catches real races)', async () => {
    let lostOnSomeSeed = false;
    for (const seed of SEEDS) {
      const env = fixture();
      const invoice = await env.storage.createInvoice(INPUT);
      const ids = Array.from({ length: 12 }, (_, i) => `writer-${i}`);
      await runConcurrentActors(ids.map((id) => appender(id, env.raw, invoice.id, false)), { seed });
      if (env.raw.getInvoiceById(invoice.id)!.metadata.tags.length < ids.length) lostOnSomeSeed = true;
    }
    assert.ok(lostOnSomeSeed);
  });

  it('a storm of client retries against a settled invoice causes no further writes', async () => {
    await forEachSeed(SEEDS.slice(0, 10), async (seed) => {
      const env = fixture();
      const invoice = await env.storage.createInvoice(INPUT);
      await env.storage.markAsPaid(invoice.id, 'tx-original', PAYER);

      const report = await runConcurrentActors(
        Array.from({ length: 25 }, (_, i) => ({
          ...payer(`retry-${i}`, env, invoice.id, `tx-retry-${i}`),
          // Clients retry anything; the server must stay terminal regardless.
          retry: { maxAttempts: 4, shouldRetry: () => true },
        })),
        { seed }
      );

      assert.equal(report.succeeded, 0);
      assert.equal(report.totalAttempts, 25 * 4);
      const final = await env.storage.getInvoiceById(invoice.id);
      assert.equal(final!.paymentTxHash, 'tx-original');
      assert.equal(final!.version, 2);
    });
  });
});

describe('multi-actor harness (#243): merge review under racing reviewers', () => {
  it('approve/reject/finalize/revert storms leave one consistent outcome', async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const env = fixture();
      const audit = new MemoryAuditStore();
      const service = new DuplicateMergeReviewService({ storage: env.storage, audit });
      await env.storage.createInvoice(INPUT);
      await env.storage.createInvoice(INPUT);
      const [candidate] = detectDuplicateCandidates(await env.storage.getAllInvoices()).candidates;
      const { proposalId } = await service.propose(candidate, { id: 'alice' });

      const decide = await runConcurrentActors(
        [
          { id: 'approve-bob', run: () => service.approve(proposalId, { id: 'bob' }) },
          { id: 'approve-carol', run: () => service.approve(proposalId, { id: 'carol' }) },
          { id: 'reject-dave', run: () => service.reject(proposalId, { id: 'dave' }, 'race') },
        ],
        { seed }
      );
      assert.equal(decide.succeeded, 1);

      const after = await runConcurrentActors(
        [
          { id: 'finalize-1', run: () => service.finalize(proposalId, { id: 'bob' }) },
          { id: 'finalize-2', run: () => service.finalize(proposalId, { id: 'carol' }) },
          { id: 'revert-1', run: () => service.revert(proposalId, { id: 'erin' }, 'race') },
        ],
        { seed: seed + 1000 }
      );

      const proposal = service.getProposal(proposalId)!;
      const duplicate = await env.storage.getInvoiceById(candidate.duplicateIds[0]);
      if (proposal.status === 'FINALIZED') {
        assert.equal(duplicate!.status, 'CANCELLED');
        assert.equal(duplicate!.version, 2, 'cancelled exactly once');
      } else {
        assert.ok(['REJECTED', 'REVERTED'].includes(proposal.status), proposal.status);
        assert.equal(duplicate!.status, 'PENDING');
        assert.equal(service.retiredInto(duplicate!.id), null);
      }
      assert.ok(after.succeeded <= 1);
      assert.equal(audit.verifyChain().valid, true);
    });
  });
});
