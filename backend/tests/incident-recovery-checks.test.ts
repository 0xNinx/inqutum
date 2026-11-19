import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  IncidentRecoveryRunner,
  UnauthorizedRecoveryCheckError,
  formatIncidentRecoveryReport,
} from '../src/ops/incident-recovery-checks';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage';
import { MemoryJobStore } from '../src/jobs/memory-job-store';
import { DEFAULT_RETRY_POLICY } from '../src/jobs/job-types';
import { createOpsRouter } from '../src/routes/ops.routes';

describe('Incident runbook executable recovery checks (#392)', () => {
  it('normal path: all recovery checks pass with exitCode 0', async () => {
    const runner = new IncidentRecoveryRunner({
      storage: new MemoryInvoiceStorage(),
      jobs: new MemoryJobStore(),
    });

    const report = await runner.runChecks({
      actorId: 'maintainer-1',
      actorRole: 'ADMIN',
    });

    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.failedChecks, 0);
    assert.equal(report.totalChecks, 4);
    assert.deepEqual(report.remediationCommands, []);

    const formatted = formatIncidentRecoveryReport(report);
    assert.match(formatted, /Status: PASS/);
  });

  it('failure path: reports failing check and runbook remediation commands', async () => {
    const jobs = new MemoryJobStore();
    const now = new Date().toISOString();
    await jobs.enqueue({
      id: 'dead-job-1',
      type: 'invoices.expire-pending',
      payload: { version: 1, data: {} },
      status: 'dead',
      attempts: 5,
      retryPolicy: DEFAULT_RETRY_POLICY,
      runAt: now,
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: null,
      correlationId: null,
      errors: [{ attempt: 5, message: 'Simulated DB timeout', at: now }],
      result: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const runner = new IncidentRecoveryRunner({
      storage: new MemoryInvoiceStorage(),
      jobs,
    });

    const report = await runner.runChecks({
      actorId: 'maintainer-1',
      actorRole: 'OWNER',
      maxRetries: 0,
    });

    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 1);
    assert.equal(report.failedChecks, 1);
    const jobCheck = report.checks.find((c) => c.id === 'JOB_QUEUE_HEALTH');
    assert.equal(jobCheck?.status, 'FAIL');
    assert.ok(report.remediationCommands.some((cmd) => cmd.includes('status=dead')));
  });

  it('retry path: recovers when transient probe failure clears on retry', async () => {
    let attempts = 0;
    const runner = new IncidentRecoveryRunner({
      storage: new MemoryInvoiceStorage(),
      probes: {
        DEPENDENCY_READINESS: async () => {
          attempts++;
          if (attempts < 2) {
            throw new Error('Transient Horizon 503');
          }
          return { ok: true, summary: 'Horizon recovered' };
        },
      },
    });

    const report = await runner.runChecks({
      actorId: 'maintainer-1',
      actorRole: 'ADMIN',
      checkIds: ['DEPENDENCY_READINESS'],
      maxRetries: 2,
      initialBackoffMs: 1,
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks[0].attempts, 2);
    assert.equal(report.checks[0].status, 'PASS');
  });

  it('authorization path: rejects non-admin actors and protects HTTP endpoint', async () => {
    const runner = new IncidentRecoveryRunner({ storage: new MemoryInvoiceStorage() });

    await assert.rejects(
      () => runner.runChecks({ actorId: 'viewer-1', actorRole: 'VIEWER' }),
      (err: unknown) => err instanceof UnauthorizedRecoveryCheckError && err.httpStatus === 403
    );

    const app = express();
    app.use(express.json());
    app.use('/api', createOpsRouter({ storage: new MemoryInvoiceStorage(), adminToken: 'secret-token', recoveryRunner: runner }));

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/ops/incident-recovery/verify`;

    try {
      const unauth = await fetch(url, { method: 'POST' });
      assert.equal(unauth.status, 401);

      const forbidden = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(forbidden.status, 401);

      const ok = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorId: 'oncall-1' }),
      });
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { success: boolean; data: { exitCode: number } };
      assert.equal(body.success, true);
      assert.equal(body.data.exitCode, 0);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
