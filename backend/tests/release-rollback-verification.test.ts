import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RollbackDataSourceWriteAttempt,
  formatReleaseRollbackReport,
  readOnlyDataSource,
  verifyReleaseRollback,
  type RollbackDataSource,
} from '../src/ops/release-rollback-verification';
import { UnauthorizedRollbackVerificationError } from '../src/ops/rollback-verification';
import { buildRollbackFixture, createFixtureDataSource, type RollbackFixtureName } from '../src/sandbox/rollback-fixtures';
import { SEED_IDS } from '../src/sandbox/seed-fixtures';

async function run(name: RollbackFixtureName, source?: RollbackDataSource) {
  const fixture = buildRollbackFixture(name);
  return verifyReleaseRollback({
    window: fixture.window,
    contract: fixture.contract,
    source: source ?? createFixtureDataSource(fixture),
    options: { actorId: 'test-operator', actorRole: 'OPERATOR', now: fixture.now },
  });
}

const failing = (report: Awaited<ReturnType<typeof run>>) => report.checks.filter((c) => !c.passed).map((c) => c.id);

describe('Post-rollback data verification (#209)', () => {
  it('clean rollback: passes with only review notes', async () => {
    const report = await run('clean');
    assert.equal(report.status, 'clean');
    assert.equal(report.exitCode, 0);
    assert.ok(report.findings.every((f) => f.severity === 'review'));
    assert.deepEqual(report.manualRepair, { invoices: [], jobs: [], externalReferences: [] });
    // DUP-B was created exactly when 1.5.0 went live.
    assert.deepEqual(report.findings.map((f) => `${f.check}:${f.resourceId}`), [`invoices.written_in_window:${SEED_IDS.invDuplicateB}`]);
    assert.deepEqual(report.scanned, { invoices: 8, jobs: 4, externalReferences: 5 });
  });

  it('partial rollback: detects every record requiring manual repair', async () => {
    const report = await run('partial');
    assert.equal(report.status, 'needs_repair');
    assert.equal(report.exitCode, 1);
    assert.deepEqual(failing(report), [
      'jobs.unknown_type',
      'jobs.payload_version',
      'jobs.in_flight',
      'invoices.schema_version',
      'invoices.partial_settlement',
      'invoices.written_in_window',
      'external.unknown_kind',
      'external.pending',
      'external.dangling',
    ]);
    assert.deepEqual(report.manualRepair, {
      invoices: [SEED_IDS.invPending, SEED_IDS.invDuplicateA, SEED_IDS.invDuplicateB].sort(),
      jobs: ['5eed0000-0000-4000-8009-000000000001', '5eed0000-0000-4000-8009-000000000002', '5eed0000-0000-4000-8009-000000000003'],
      externalReferences: ['seed-xref-email-pending', 'seed-xref-orphan', 'seed-xref-sms'],
    });
    const partial = report.findings.filter((f) => f.check === 'invoices.partial_settlement');
    assert.match(partial.find((f) => f.resourceId === SEED_IDS.invDuplicateA)!.message, /PAID without complete payment fields/);
    assert.match(partial.find((f) => f.resourceId === SEED_IDS.invDuplicateB)!.message, /confirmed payment .* was observed/);
    assert.ok(report.findings.every((f) => f.remediation.length > 0), 'every finding says how to repair it');
  });

  it('failed rollback: critical findings and exit code 2', async () => {
    const report = await run('failed');
    assert.equal(report.status, 'failed');
    assert.equal(report.exitCode, 2);
    const critical = report.findings.filter((f) => f.severity === 'critical');
    assert.deepEqual(critical.map((f) => f.check), ['rollback.status', 'rollback.version']);
    assert.equal(report.findings[0].severity, 'critical', 'critical findings sort first');
    assert.equal(report.window.rollbackCompletedAt, null);
  });

  it('in-progress rollback is not reported as clean', async () => {
    const fixture = buildRollbackFixture('clean');
    fixture.window.rollbackStatus = 'in_progress';
    const report = await verifyReleaseRollback({ window: fixture.window, contract: fixture.contract, source: createFixtureDataSource(fixture), options: { now: fixture.now } });
    assert.equal(report.status, 'failed');
    assert.match(report.findings[0].remediation, /Wait for the rollback to finish/);
  });

  it('flags jobs that dead-lettered under the rolled-back release for review', async () => {
    const fixture = buildRollbackFixture('clean');
    const dead = fixture.jobs.find((j) => j.status === 'dead')!;
    dead.completedAt = new Date(fixture.window.deployedAt.getTime() + 60_000).toISOString();
    const report = await verifyReleaseRollback({ window: fixture.window, contract: fixture.contract, source: createFixtureDataSource(fixture), options: { now: fixture.now } });
    assert.equal(report.status, 'clean');
    assert.ok(report.findings.some((f) => f.check === 'jobs.dead_in_window' && f.resourceId === dead.id));
  });

  it('unversioned historical records fail only when the contract disallows them', async () => {
    const fixture = buildRollbackFixture('clean');
    const report = await verifyReleaseRollback({
      window: fixture.window,
      contract: { ...fixture.contract, allowUnversionedInvoices: false },
      source: createFixtureDataSource(fixture),
      options: { now: fixture.now },
    });
    assert.deepEqual(report.manualRepair.invoices, [SEED_IDS.invHistorical]);
  });

  describe('read-only by default', () => {
    it('never touches mutating methods on the data source', async () => {
      const fixture = buildRollbackFixture('partial');
      const writes: string[] = [];
      const source = Object.assign(createFixtureDataSource(fixture), {
        markAsPaid: async () => writes.push('markAsPaid'),
        requeueDead: async () => writes.push('requeueDead'),
      });
      const before = JSON.stringify([fixture.dataset.invoices, fixture.jobs, fixture.externalReferences]);
      await run('partial', source);
      assert.deepEqual(writes, []);
      assert.equal(JSON.stringify([fixture.dataset.invoices, fixture.jobs, fixture.externalReferences]), before);
    });

    it('the read-only view refuses access to anything but read methods', () => {
      const source = Object.assign(createFixtureDataSource(buildRollbackFixture('clean')), { deleteAll: async () => undefined });
      const view = readOnlyDataSource(source) as RollbackDataSource & { deleteAll: () => Promise<void> };
      assert.throws(() => view.deleteAll(), RollbackDataSourceWriteAttempt);
      assert.throws(() => {
        (view as any).listJobs = async () => [];
      }, RollbackDataSourceWriteAttempt);
      assert.equal(typeof view.listInvoices, 'function');
    });

    it('reports readOnly: true', async () => {
      assert.equal((await run('clean')).readOnly, true);
    });
  });

  it('requires an operator, admin or owner', async () => {
    const fixture = buildRollbackFixture('clean');
    await assert.rejects(
      verifyReleaseRollback({ window: fixture.window, contract: fixture.contract, source: createFixtureDataSource(fixture), options: { actorRole: 'VIEWER' } }),
      UnauthorizedRollbackVerificationError
    );
  });

  it('is deterministic and renders a readable report', async () => {
    const a = await run('partial');
    const b = await run('partial');
    assert.deepEqual(a, b);
    const text = formatReleaseRollbackReport(a);
    assert.match(text, /NEEDS_REPAIR/);
    assert.match(text, /Manual repair required: 3 invoices, 3 jobs, 3 external references/);
  });
});
