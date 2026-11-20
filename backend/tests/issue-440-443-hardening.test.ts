import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedProjectionCache } from '../src/ops/stale-projections.service';
import { DeterministicReplayEngine, type SimulatedResource, type SimulationEvent } from '../src/concurrency/deterministic-replay-engine';
import { SyntheticJourneyMonitor } from '../src/ops/synthetic-journey-monitor';
import { createInvoiceSchema, paymentSchema } from '../src/utils/validation';

const SELLER = `G${'A'.repeat(55)}`;
const TX_HASH = 'a'.repeat(64);

describe('Inqutum hardening contracts (#440-#443)', () => {
  it('#442 bounds cache growth and never serves invalidated or stale values', async () => {
    const cache = new BoundedProjectionCache<string, string>(2);
    cache.set('a', 'v1', 1);
    cache.set('b', 'v1', 1);
    assert.equal(cache.size, 2);

    // Access makes a the most-recently-used entry; c evicts b.
    assert.equal(cache.get('a', 1), 'v1');
    cache.set('c', 'v1', 1);
    assert.equal(cache.get('b', 1), undefined);
    assert.equal(cache.size, 2);

    assert.equal(cache.isStale('a', 2), true);
    assert.equal(cache.get('a', 2), undefined);
    assert.equal(cache.size, 1);
    cache.invalidate('c');
    assert.equal(cache.size, 0);

    let loads = 0;
    await assert.rejects(() => cache.getOrLoad('retry', 3, async () => {
      loads++;
      throw new Error('transient');
    }));
    assert.equal(loads, 1);
    assert.equal(await cache.getOrLoad('retry', 3, async () => {
      loads++;
      return 'recovered';
    }), 'recovered');
    assert.equal(loads, 2, 'failed loads must not poison retries');
  });

  it('#443 converges concurrent duplicate submissions to one settlement', async () => {
    const initial: SimulatedResource = {
      id: 'invoice-duplicate',
      version: 1,
      status: 'PENDING',
      fields: {},
      settledAmount: 0,
    };
    const events: SimulationEvent[] = Array.from({ length: 20 }, (_, index) => ({
      id: `duplicate-${index}`,
      clientId: `worker-${index}`,
      role: 'ADMIN' as const,
      action: 'SETTLE_PAYMENT' as const,
      value: 25,
      expectedVersion: 1,
      idempotencyKey: 'payment-1',
    }));

    const result = await new DeterministicReplayEngine(initial, 440443).executeConcurrentBatch(events);
    assert.equal(result.finalState.status, 'PAID');
    assert.equal(result.finalState.settledAmount, 25);
    assert.equal(result.successfulWrites, 1);
    assert.equal(result.retriesHandled, 19);
  });

  it('#441 retries a failed synthetic journey without retaining a failed result as success', async () => {
    const report = await new SyntheticJourneyMonitor().runJourneyWithRetry({
      maxRetries: 1,
      retryDelayMs: 0,
      injectedFailureStep: 'VERIFY_STELLAR_PAYMENT',
      injectedFailureMessage: 'temporary Horizon outage',
      failAttempts: 1,
    });

    assert.equal(report.success, true);
    assert.equal(report.attempts, 2);
    assert.equal(report.failedStep, undefined);
    assert.equal(report.steps.every((step) => step.status === 'PASS'), true);
  });

  it('#440 safely rejects malformed and boundary payloads without throwing', () => {
    const hostileValues: unknown[] = [
      null, undefined, [], {}, true, '', '\u0000\u202e', Number.NaN,
      Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 'x'.repeat(501),
    ];

    for (const value of hostileValues) {
      assert.doesNotThrow(() => createInvoiceSchema.safeParse({
        amount: value,
        assetCode: 'XLM',
        sellerPublicKey: SELLER,
        expiresInDays: value,
      }));
      assert.doesNotThrow(() => paymentSchema.safeParse({
        invoiceId: value,
        txHash: value,
        payerPublicKey: value,
        amount: value,
      }));
    }

    assert.equal(createInvoiceSchema.safeParse({
      amount: 1,
      assetCode: 'XLM',
      sellerPublicKey: SELLER,
      expiresInDays: 1,
    }).success, true);
    assert.equal(paymentSchema.safeParse({
      invoiceId: 'not-a-uuid',
      txHash: TX_HASH,
      payerPublicKey: SELLER,
      amount: 1,
    }).success, false);
  });
});
