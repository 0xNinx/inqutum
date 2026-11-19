/**
 * Resource budget tests for worst-case user, ledger and search workloads (#251).
 *
 * Every workload is high-cardinality on purpose and is checked against the
 * ceilings in `src/ops/resource-budgets.ts`. Query budgets are exact; CPU and
 * heap ceilings scale with RESOURCE_BUDGET_MULTIPLIER for slow runners.
 * Measurements are printed as test diagnostics so a trend is visible in CI logs.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  CountingQueryable,
  RESOURCE_BUDGETS,
  budgetMultiplier,
  checkBudget,
  measure,
  type BudgetName,
  type Measurement,
} from '../src/ops/resource-budgets';
import { MemoryStorage } from '../src/storage/memory-storage';
import { InvoiceMemoryService } from '../src/services/invoice-memory.service';
import { InvoiceService } from '../src/services/invoice.service';
import { MemoryAuditStore } from '../src/audit/audit-service';
import { PermissionAwareSearchIndex, type SearchActor } from '../src/services/search-index.service';
import { detectDuplicateCandidates } from '../src/domain/duplicate-detection';
import { planMetadataMinimization, runMetadataMinimization } from '../src/db/metadata-minimization';
import type { StoredInvoice } from '../src/storage/invoice-storage';

const INVOICES = 20_000;
const SELLERS = 2_000;
const WHALE_INVOICES = 5_000;
const WHALE = 'GWHALEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sellerKey = (n: number) => `G${String(n).padStart(55, 'S')}`;

function enforce(t: { diagnostic(message: string): void }, name: BudgetName, m: Measurement): void {
  t.diagnostic(
    `${name}: cpu=${m.cpuMs.toFixed(0)}ms wall=${m.wallMs.toFixed(0)}ms heap=+${m.heapGrowthMb.toFixed(1)}MB queries=${m.queries}`
  );
  assert.deepEqual(checkBudget(name, m), []);
}

describe('resource budgets (#251): budget table', () => {
  it('every budget has at least one ceiling and a rationale', () => {
    for (const [name, budget] of Object.entries(RESOURCE_BUDGETS)) {
      const b = budget as { maxCpuMs?: number; maxHeapGrowthMb?: number; maxQueries?: number; rationale: string };
      assert.ok(b.maxCpuMs ?? b.maxHeapGrowthMb ?? b.maxQueries, `${name} has no ceiling`);
      assert.ok(b.rationale.length > 20, `${name} needs a rationale`);
    }
  });

  it('flags violations and scales only time/memory ceilings', () => {
    const over: Measurement = { cpuMs: 1e6, wallMs: 1e6, heapGrowthMb: 1e6, queries: 3 };
    assert.equal(checkBudget('user.whale_seller_pagination', over).length, 2);
    assert.equal(checkBudget('db.get_invoice', over, 1000).length, 1, 'query ceilings never scale');
    assert.equal(budgetMultiplier({ RESOURCE_BUDGET_MULTIPLIER: '3' }), 3);
    assert.equal(budgetMultiplier({ RESOURCE_BUDGET_MULTIPLIER: 'nope' }), 1);
  });
});

describe('resource budgets (#251): worst-case workloads', () => {
  let raw: MemoryStorage;
  let invoices: StoredInvoice[];

  before(() => {
    raw = new MemoryStorage({ maxEntries: INVOICES * 2 });
    for (let i = 0; i < INVOICES; i++) {
      const whale = i < WHALE_INVOICES;
      raw.createInvoice({
        sellerPublicKey: whale ? WHALE : sellerKey(i % SELLERS),
        amount: 1 + (i % 50),
        assetCode: i % 5 === 0 ? 'USDC' : 'XLM',
        memo: `memo-${i}`,
        customerEmail: `customer-${i % 3_000}@example.com`,
        description: `Order ${i % 700}`,
        metadata: { order: `A-${i}`, ip: '203.0.113.7', source: 'api', note: i % 10 === 0 ? 'x' : undefined },
      });
    }
    invoices = raw.getAllInvoices();
    assert.equal(invoices.length, INVOICES);
  });

  it('user: paging and stats for a seller with 5k invoices among 20k', async (t) => {
    const service = new InvoiceMemoryService(raw);
    const { result, measurement } = await measure(async () => {
      let seen = 0;
      let after: { createdAt: Date; id: string } | undefined;
      for (let page = 0; page < 10; page++) {
        const rows = await service.getInvoicesBySeller(WHALE, undefined, 50, 0, after);
        seen += rows.length;
        const last = rows.at(-1)!;
        after = { createdAt: last.createdAt, id: last.id };
      }
      const [stats] = await service.getInvoiceStats(WHALE);
      return { seen, stats };
    });
    assert.equal(result.seen, 500);
    assert.equal(result.stats.total_invoices, WHALE_INVOICES);
    enforce(t, 'user.whale_seller_pagination', measurement);
  });

  it('ledger: 20k audit appends stay bounded and the chain verifies', async (t) => {
    const store = new MemoryAuditStore(5_000);
    const { result, measurement } = await measure(() => {
      for (let i = 0; i < INVOICES; i++) {
        store.recordEvent({
          action: i % 3 === 0 ? 'PAYMENT_VERIFIED' : 'INVOICE_CREATED',
          actor: { type: 'seller', id: sellerKey(i % SELLERS) },
          scope: { entityType: 'invoice', entityId: invoices[i].id },
          afterState: { status: 'PENDING', amount: invoices[i].amount },
        });
      }
      const lookups = invoices.slice(-200).map((inv) => store.getEventsByEntity(inv.id).length);
      return { size: store.size(), verify: store.verifyChain(), lookups };
    });
    assert.equal(result.size, 5_000, 'audit buffer is bounded by capacity');
    assert.equal(result.verify.valid, true);
    assert.ok(result.lookups.every((n) => n === 1));
    enforce(t, 'ledger.audit_append_and_verify', measurement);
  });

  it('search: 50 mixed-role queries over 20k indexed invoices', async (t) => {
    const index = new PermissionAwareSearchIndex();
    for (const [i, inv] of invoices.entries()) index.indexInvoice(inv, i % 4 === 0 ? 'CONFIDENTIAL' : 'INTERNAL');

    const actors: SearchActor[] = [
      { role: 'ADMIN' },
      { role: 'SELLER', walletAddress: WHALE },
      { role: 'VIEWER' },
      { role: 'ANONYMOUS' },
    ];
    const { result, measurement } = await measure(() => {
      let hits = 0;
      for (let q = 0; q < 50; q++) {
        hits += index.search(q % 2 === 0 ? 'example.com' : `order ${q}`, actors[q % actors.length]).length;
      }
      return hits;
    });
    assert.ok(result > 0);
    assert.equal(index.search('example.com', { role: 'ANONYMOUS' }).length, 0, 'budget never buys a permission leak');
    enforce(t, 'search.high_cardinality_queries', measurement);
  });

  it('ops: duplicate detection over 20k invoices', async (t) => {
    const { result, measurement } = await measure(() => detectDuplicateCandidates(invoices));
    assert.equal(result.scanned, INVOICES);
    enforce(t, 'ops.duplicate_scan', measurement);
  });

  it('ops: metadata minimization planning over 20k invoices', async (t) => {
    const records = invoices.map((inv) => ({ id: inv.id, createdAt: new Date(Date.now() - 60 * 864e5), metadata: inv.metadata }));
    const { result, measurement } = await measure(() => planMetadataMinimization(records));
    assert.equal(result.changes.length, INVOICES, 'every 60-day-old ip is past its 30-day window');
    enforce(t, 'ops.metadata_minimization_plan', measurement);
  });
});

describe('resource budgets (#251): database round-trips', () => {
  it('list, stats and get stay within a constant number of queries regardless of page size', async (t) => {
    const db = new CountingQueryable();
    const service = new InvoiceService(db);

    for (const limit of [1, 50, 500]) {
      const { measurement } = await measure(() => service.getInvoicesBySeller(WHALE, undefined, limit, 0), db);
      enforce(t, 'db.list_invoices_page', measurement);
    }
    enforce(t, 'db.invoice_stats', (await measure(() => service.getInvoiceStats(WHALE), db)).measurement);
    enforce(t, 'db.get_invoice', (await measure(() => service.getInvoiceById('00000000-0000-0000-0000-000000000001'), db)).measurement);
  });

  it('a metadata minimization dry run over 2k rows reads in bounded pages and never writes', async (t) => {
    const rows = Array.from({ length: 2_000 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
      created_at: new Date(Date.now() - 60 * 864e5).toISOString(),
      metadata: { ip: '203.0.113.7', order: `A-${i}` },
    }));
    const table = {
      async query(_text: string, params: any[] = []) {
        const [afterId, limit] = params;
        return { rows: rows.filter((r) => r.id > afterId).slice(0, limit) };
      },
    };
    const db = new CountingQueryable(table);
    const { result, measurement } = await measure(() => runMetadataMinimization(db, { batchSize: 500 }), db);
    assert.equal(result.reviewed, 2_000);
    assert.ok(!db.statements.includes('UPDATE'));
    enforce(t, 'db.metadata_minimization_dry_run_2k', measurement);
  });
});
