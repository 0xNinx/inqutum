import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  EventSchemaDriftDetector,
  EventSchemaDriftError,
  UnauthorizedSchemaOperationError,
  UnknownContractRollbackError,
} from '../src/schema/event-schema-drift';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { createOpsRouter } from '../src/routes/ops.routes';

const ADMIN_ACTOR = { actorId: 'admin-1', role: 'ADMIN' as const };
const VIEWER_ACTOR = { actorId: 'viewer-1', role: 'VIEWER' as const };

describe('Cross-service event schema drift detection (#389)', () => {
  let detector: EventSchemaDriftDetector;

  beforeEach(() => {
    detector = new EventSchemaDriftDetector();
  });

  it('normal path: passes cleanly when observed event matches contract', () => {
    const report = detector.detectDrift({
      eventType: 'invoice.paid',
      version: '1.0',
      sourceService: 'settlement-engine',
      payload: {
        invoiceId: 'inv-123',
        txHash: 'a'.repeat(64),
        payerPublicKey: 'G' + 'A'.repeat(55),
        paidAt: '2026-01-01T00:00:00.000Z',
        amount: 42.5,
        assetCode: 'USDC',
      },
    });

    assert.equal(report.hasDrift, false);
    assert.equal(report.severity, 'NONE');
    assert.equal(report.breakingCount, 0);
    assert.equal(report.rollbackRecommended, false);
  });

  it('non-breaking path: classifies additive unknown fields as NON_BREAKING', () => {
    const report = detector.detectDrift({
      eventType: 'invoice.created',
      version: '1.0',
      sourceService: 'invoice-service',
      payload: {
        invoiceId: 'inv-1',
        sellerPublicKey: 'G' + 'A'.repeat(55),
        amount: 10,
        assetCode: 'XLM',
        status: 'PENDING',
        memo: null,
        traceTag: 'canary-v2',
      },
    });

    assert.equal(report.hasDrift, true);
    assert.equal(report.severity, 'NON_BREAKING');
    assert.equal(report.breakingCount, 0);
    assert.equal(report.nonBreakingCount, 1);
    assert.equal(report.rollbackRecommended, false);
    assert.equal(report.drifts[0].kind, 'UNKNOWN_OPTIONAL_FIELD');
  });

  it('failure path: detects missing required field, type mismatch, invalid enum, and version mismatch', () => {
    const report = detector.detectDrift({
      eventType: 'invoice.created',
      version: '2.0',
      sourceService: 'invoice-service',
      payload: {
        sellerPublicKey: 'G' + 'A'.repeat(55),
        amount: '10.00', // type mismatch
        assetCode: 'XLM',
        status: 'ARCHIVED', // invalid enum
      },
    });

    assert.equal(report.hasDrift, true);
    assert.equal(report.severity, 'BREAKING');
    assert.equal(report.rollbackRecommended, true);
    assert.ok(report.breakingCount >= 4);
    const kinds = new Set(report.drifts.map((d) => d.kind));
    assert.ok(kinds.has('VERSION_MISMATCH'));
    assert.ok(kinds.has('MISSING_REQUIRED_FIELD'));
    assert.ok(kinds.has('TYPE_MISMATCH'));
    assert.ok(kinds.has('INVALID_ENUM_VALUE'));
    assert.ok(report.remediationSteps.length > 0);
  });

  it('retry path: recovers on transient probe failure and fails when retries exhausted', async () => {
    let calls = 0;
    const report = await detector.detectDriftWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNRESET');
        return {
          eventType: 'ownership.transferred',
          version: '1.0',
          sourceService: 'ownership-transfer-service',
          payload: {
            transferId: 'tr-1',
            resourceType: 'ORGANIZATION',
            resourceId: 'org-1',
            previousOwnerId: 'G1',
            newOwnerId: 'G2',
            acceptedAt: '2026-01-01T00:00:00.000Z',
          },
        };
      },
      { maxRetries: 2, initialBackoffMs: 1 }
    );

    assert.equal(report.attempts, 2);
    assert.equal(report.severity, 'NONE');

    await assert.rejects(
      () =>
        detector.detectDriftWithRetry(
          async () => {
            throw new Error('Upstream timeout');
          },
          { maxRetries: 1, initialBackoffMs: 1 }
        ),
      (err: unknown) => err instanceof EventSchemaDriftError && err.code === 'DRIFT_PROBE_UNAVAILABLE'
    );
  });

  it('authorization & rollback path: restricts contract mutations to ADMIN/OWNER and supports version rollback', () => {
    assert.throws(
      () =>
        detector.registerContract(
          {
            eventType: 'invoice.created',
            version: '2.0',
            producerService: 'invoice-service',
            consumerServices: ['audit-service'],
            fields: { invoiceId: { type: 'string', required: true } },
          },
          VIEWER_ACTOR
        ),
      (err: unknown) => err instanceof UnauthorizedSchemaOperationError && err.httpStatus === 403
    );

    detector.registerContract(
      {
        eventType: 'invoice.created',
        version: '2.0',
        producerService: 'invoice-service',
        consumerServices: ['audit-service'],
        fields: { invoiceId: { type: 'string', required: true } },
      },
      ADMIN_ACTOR
    );
    assert.equal(detector.getContract('invoice.created')?.version, '2.0');

    const rolledBack = detector.rollbackContract('invoice.created', '1.0', ADMIN_ACTOR);
    assert.equal(rolledBack.version, '1.0');

    assert.throws(
      () => detector.rollbackContract('invoice.created', '9.9', ADMIN_ACTOR),
      (err: unknown) => err instanceof UnknownContractRollbackError && err.httpStatus === 404
    );
  });

  it('HTTP ops endpoints enforce admin auth and return 409 on breaking drift', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), adminToken: 'secret-token', eventSchemaDrift: detector }));

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/ops/event-schemas`;

    try {
      const unauth = await fetch(`${base}/contracts`);
      assert.equal(unauth.status, 401);

      const okRes = await fetch(`${base}/contracts`, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      assert.equal(okRes.status, 200);

      const driftRes = await fetch(`${base}/drift-check`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventType: 'invoice.paid',
          sourceService: 'settlement-engine',
          payload: { invoiceId: 123 },
        }),
      });
      assert.equal(driftRes.status, 409);
      const body = (await driftRes.json()) as { success: boolean; data: { rollbackRecommended: boolean } };
      assert.equal(body.success, false);
      assert.equal(body.data.rollbackRecommended, true);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
