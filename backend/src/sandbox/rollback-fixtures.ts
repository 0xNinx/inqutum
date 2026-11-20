/**
 * Post-rollback verification fixtures (issue #209), built on the contributor
 * seed dataset (#201) so the scenarios share one consistent baseline.
 *
 *  - clean:   rollback completed; everything the rolled-back release wrote is
 *             readable by the restored one. Only review notes remain.
 *  - partial: rollback completed, but the rolled-back release left jobs,
 *             records and provider calls the restored release cannot handle.
 *  - failed:  rollback failed and the service still reports the new version.
 */
import type { Job } from '../jobs/job-types';
import { DEFAULT_RETRY_POLICY } from '../jobs/job-types';
import { INVOICE_STATUSES } from '../storage/invoice-storage';
import type {
  ReleaseRollbackWindow,
  RestoredBehaviourContract,
  RollbackDataSource,
  RollbackExternalReference,
} from '../ops/release-rollback-verification';
import { SEED_IDS, buildSeedDataset, seedTxHash, type SeedDataset, type SeedJob } from './seed-fixtures';

export type RollbackFixtureName = 'clean' | 'partial' | 'failed';
export const ROLLBACK_FIXTURES: readonly RollbackFixtureName[] = ['clean', 'partial', 'failed'];

export interface RollbackFixture {
  name: RollbackFixtureName;
  window: ReleaseRollbackWindow;
  contract: RestoredBehaviourContract;
  now: Date;
  dataset: SeedDataset;
  jobs: Job[];
  externalReferences: RollbackExternalReference[];
  observedVersion: string;
}

const HOUR = 60 * 60_000;

export const RESTORED_CONTRACT: RestoredBehaviourContract = {
  version: '1.4.0',
  invoiceStatuses: INVOICE_STATUSES,
  invoiceSchemaVersions: ['1.0.0'],
  allowUnversionedInvoices: true,
  jobHandlers: { 'payments.verify': 1, 'notifications.receipt': 1, 'invoices.expire-pending': 1 },
  externalReferenceKinds: ['stellar_tx', 'email_delivery', 'webhook_delivery'],
};

function toJob(seed: SeedJob, overrides: Partial<Job> = {}): Job {
  const completedAt = seed.completedAt?.toISOString() ?? null;
  return {
    id: seed.id,
    type: seed.type,
    payload: { version: seed.payloadVersion, data: seed.invoiceId ? { invoiceId: seed.invoiceId } : {} },
    status: seed.status,
    attempts: seed.attempts,
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
    runAt: seed.createdAt.toISOString(),
    lockedUntil: null,
    lockedBy: null,
    idempotencyKey: null,
    correlationId: null,
    errors: seed.lastError ? [{ attempt: seed.attempts, at: completedAt ?? seed.createdAt.toISOString(), message: seed.lastError }] : [],
    result: null,
    createdAt: seed.createdAt.toISOString(),
    updatedAt: completedAt ?? seed.createdAt.toISOString(),
    completedAt,
    ...overrides,
  };
}

function toExternalReferences(ds: SeedDataset): RollbackExternalReference[] {
  const settlementInvoice = new Map(ds.settlements.map((s) => [s.id, s.invoiceId]));
  return ds.externalReferences.map((x) => ({
    id: x.id,
    kind: x.kind,
    invoiceId: x.resourceType === 'invoice' ? x.resourceId : settlementInvoice.get(x.resourceId) ?? x.resourceId,
    reference: x.reference,
    status: x.status,
    createdAt: x.createdAt,
  }));
}

export function buildRollbackFixture(name: RollbackFixtureName): RollbackFixture {
  const dataset = buildSeedDataset();
  const anchor = dataset.anchor.getTime();
  const at = (offsetMs: number) => new Date(anchor + offsetMs);
  const window: ReleaseRollbackWindow = {
    rolledBackVersion: '1.5.0',
    restoredVersion: RESTORED_CONTRACT.version,
    deployedAt: at(-3 * HOUR),
    rollbackStartedAt: at(-1 * HOUR),
    rollbackCompletedAt: at(-30 * 60_000),
    rollbackStatus: 'completed',
  };
  const jobs = dataset.jobs.map((j) => toJob(j));
  const externalReferences = toExternalReferences(dataset);
  const fixture: RollbackFixture = { name, window, contract: RESTORED_CONTRACT, now: at(0), dataset, jobs, externalReferences, observedVersion: '1.4.0' };

  if (name === 'partial') {
    const inWindow = at(-2 * HOUR);
    const base: SeedJob = { id: '', type: 'payments.verify', status: 'queued', attempts: 0, payloadVersion: 1, createdAt: inWindow };
    jobs.push(
      // Job type introduced by 1.5.0: no handler after rollback.
      toJob({ ...base, id: '5eed0000-0000-4000-8009-000000000001', type: 'payments.verify-batch', invoiceId: SEED_IDS.invPending }),
      // Known type, but enqueued with the 1.5.0 payload shape.
      toJob({ ...base, id: '5eed0000-0000-4000-8009-000000000002', payloadVersion: 2, invoiceId: SEED_IDS.invDuplicateA }),
      // Claimed by a 1.5.0 worker mid-flight.
      toJob({ ...base, id: '5eed0000-0000-4000-8009-000000000003', status: 'running', attempts: 1, invoiceId: SEED_IDS.invDuplicateB }, {
        lockedBy: 'worker-1.5.0-a', lockedUntil: at(-90 * 60_000).toISOString(), updatedAt: at(-91 * 60_000).toISOString(),
      })
    );
    const pending = dataset.invoices.find((i) => i.id === SEED_IDS.invPending)!;
    pending._schemaVersion = '2.0.0';
    // 1.5.0 flipped status but crashed before writing the payment fields.
    const dupA = dataset.invoices.find((i) => i.id === SEED_IDS.invDuplicateA)!;
    dupA.status = 'PAID';
    externalReferences.push(
      { id: 'seed-xref-email-pending', kind: 'email_delivery', invoiceId: SEED_IDS.invPaid, reference: 'seed-email-receipt-0002', status: 'pending', createdAt: inWindow },
      // Payment confirmed on-chain, never applied to the invoice.
      { id: 'seed-xref-tx-unapplied', kind: 'stellar_tx', invoiceId: SEED_IDS.invDuplicateB, reference: seedTxHash('unapplied-dup-b'), status: 'confirmed', createdAt: inWindow },
      { id: 'seed-xref-sms', kind: 'sms_delivery', invoiceId: SEED_IDS.invPending, reference: 'seed-sms-0001', status: 'delivered', createdAt: inWindow },
      { id: 'seed-xref-orphan', kind: 'webhook_delivery', invoiceId: '5eed0000-0000-4000-8001-000000000099', reference: 'seed-webhook-0002', status: 'delivered', createdAt: inWindow }
    );
  }

  if (name === 'failed') {
    window.rollbackStatus = 'failed';
    delete window.rollbackCompletedAt;
    fixture.observedVersion = '1.5.0';
  }

  return fixture;
}

/** In-memory, read-only data source over a fixture. */
export function createFixtureDataSource(fixture: RollbackFixture): RollbackDataSource {
  return {
    listInvoices: async () => fixture.dataset.invoices.map((i) => ({ ...i })),
    listJobs: async () => fixture.jobs.map((j) => ({ ...j })),
    listExternalReferences: async () => fixture.externalReferences.map((x) => ({ ...x })),
    observedVersion: async () => fixture.observedVersion,
  };
}
