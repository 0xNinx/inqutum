import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  SyntheticJourneyMonitor,
  formatSyntheticJourneyReport,
} from '../src/ops/synthetic-journey-monitor';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { createOpsRouter } from '../src/routes/ops.routes';

describe('Synthetic journey monitor for critical end-to-end workflow (Issue #264)', () => {
  it('runs complete happy path journey and records per-step and total latency', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney();

    assert.equal(report.success, true);
    assert.ok(report.totalLatencyMs >= 0);
    assert.equal(report.steps.length, 5);

    // Verify all 5 steps passed in sequence
    const expectedSteps = [
      'CREATE_INVOICE',
      'INSPECT_PAYMENT_DETAILS',
      'VERIFY_STELLAR_PAYMENT',
      'CONFIRM_SETTLEMENT',
      'DISPATCH_EVENT_AND_RECEIPT',
    ];

    for (let i = 0; i < expectedSteps.length; i++) {
      assert.equal(report.steps[i].step, expectedSteps[i]);
      assert.equal(report.steps[i].status, 'PASS');
      assert.ok(report.steps[i].latencyMs >= 0);
    }

    const formatted = formatSyntheticJourneyReport(report);
    assert.match(formatted, /SUCCESS/);
    assert.match(formatted, /Total Latency:/);
  });

  it('accurately blames STORAGE_LAYER when invoice creation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CREATE_INVOICE',
      injectedFailureMessage: 'Database connection timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CREATE_INVOICE');
    assert.equal(report.blamedDependency, 'STORAGE_LAYER');
    assert.match(report.rootCause || '', /Database connection timeout/);
    assert.match(report.remediation || '', /connection pool/);
  });

  it('accurately blames API_LAYER when payment envelope retrieval fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'INSPECT_PAYMENT_DETAILS',
      injectedFailureMessage: 'Read replica stale lag',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'INSPECT_PAYMENT_DETAILS');
    assert.equal(report.blamedDependency, 'API_LAYER');
    assert.match(report.remediation || '', /HTTP API routes/);
  });

  it('accurately blames STELLAR_HORIZON when on-chain payment matching fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'VERIFY_STELLAR_PAYMENT',
      injectedFailureMessage: 'Horizon 504 Gateway Timeout',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'VERIFY_STELLAR_PAYMENT');
    assert.equal(report.blamedDependency, 'STELLAR_HORIZON');
    assert.match(report.remediation || '', /Horizon RPC connectivity/);
  });

  it('accurately blames SETTLEMENT_ENGINE when state transition to PAID fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'CONFIRM_SETTLEMENT',
      injectedFailureMessage: 'Optimistic lock conflict during settlement',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'CONFIRM_SETTLEMENT');
    assert.equal(report.blamedDependency, 'SETTLEMENT_ENGINE');
    assert.match(report.remediation || '', /optimistic lock versioning/);
  });

  it('accurately blames EXPORT_ENGINE when receipt proof generation fails', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const report = await monitor.runJourney({
      injectedFailureStep: 'DISPATCH_EVENT_AND_RECEIPT',
      injectedFailureMessage: 'Export schema serialization failure',
    });

    assert.equal(report.success, false);
    assert.equal(report.failedStep, 'DISPATCH_EVENT_AND_RECEIPT');
    assert.equal(report.blamedDependency, 'EXPORT_ENGINE');
    assert.match(report.remediation || '', /export pipeline schemas/);
  });

  it('retry path & SLA tracking: recovers from transient failure on retry and records run history', async () => {
    const storage = new MemoryInvoiceStorage();
    const monitor = new SyntheticJourneyMonitor({ storage });

    const recovered = await monitor.runJourneyWithRetry({
      maxRetries: 2,
      retryDelayMs: 1,
      slaThresholdMs: 10_000,
      injectedFailureStep: 'VERIFY_STELLAR_PAYMENT',
      injectedFailureMessage: 'Transient Horizon blip',
      failAttempts: 1,
    });

    assert.equal(recovered.success, true);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.slaBreached, false);
    assert.equal(monitor.getRecentRuns().length, 1);

    const exhausted = await monitor.runJourneyWithRetry({
      maxRetries: 1,
      retryDelayMs: 1,
      injectedFailureStep: 'CONFIRM_SETTLEMENT',
      injectedFailureMessage: 'Persistent lock conflict',
      failAttempts: 5,
    });

    assert.equal(exhausted.success, false);
    assert.equal(exhausted.attempts, 2);
    assert.equal(exhausted.blamedDependency, 'SETTLEMENT_ENGINE');
  });

  it('authorization path: synthetic journey ops endpoints require admin bearer token', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), adminToken: 'synth-secret' }));

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/ops/synthetic-journey`;

    try {
      const unauth = await fetch(`${base}/run`, { method: 'POST' });
      assert.equal(unauth.status, 401);

      const forbidden = await fetch(`${base}/history`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      assert.equal(forbidden.status, 401);

      const runRes = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer synth-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ retries: 1, slaThresholdMs: 10000 }),
      });
      assert.equal(runRes.status, 200);

      const histRes = await fetch(`${base}/history`, {
        headers: { Authorization: 'Bearer synth-secret' },
      });
      assert.equal(histRes.status, 200);
      const histBody = (await histRes.json()) as { success: boolean; data: unknown[] };
      assert.equal(histBody.success, true);
      assert.equal(histBody.data.length, 1);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
