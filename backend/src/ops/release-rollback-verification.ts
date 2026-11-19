/**
 * Post-rollback data verification for newly deployed protocol behaviour (issue #209).
 *
 * rollback-verification.ts (#301) proves the *schema* and *running version*
 * are back at the baseline. That is not enough: while the rolled-back release
 * was live it may have written invoices, enqueued jobs and dispatched external
 * calls that the restored release cannot read, run or reconcile. This module
 * checks that user-facing state, background jobs and external references are
 * consistent with the restored behaviour, and lists every record that needs
 * manual repair.
 *
 * Read-only by construction:
 *  - The data source is wrapped so only the read methods of RollbackDataSource
 *    are reachable; any other property access throws before it can run.
 *  - There is no apply mode. Each finding carries a remediation; repairs go
 *    through the existing audited paths (resumable repair, maintainer intents,
 *    reconciliation apply).
 *
 * Outcome:
 *  - `clean`        no critical/repair findings (review notes may remain), exit 0
 *  - `needs_repair` at least one record needs manual repair,               exit 1
 *  - `failed`       the rollback itself did not take effect,               exit 2
 *
 * See docs/ROLLBACK_VERIFICATION.md ("Post-rollback data verification").
 */
import type { StoredInvoice } from '../storage/invoice-storage';
import type { Job } from '../jobs/job-types';
import { UnauthorizedRollbackVerificationError, type RollbackVerificationOptions } from './rollback-verification';

export interface RestoredBehaviourContract {
  /** Version the system was rolled back to. */
  version: string;
  invoiceStatuses: readonly string[];
  /** `_schemaVersion` values the restored release can read. */
  invoiceSchemaVersions: readonly string[];
  /** Records written before schema versioning carry no stamp; allow them. Default true. */
  allowUnversionedInvoices?: boolean;
  /** Job type -> highest payload version its handler accepts. */
  jobHandlers: Readonly<Record<string, number>>;
  externalReferenceKinds: readonly string[];
}

export interface ReleaseRollbackWindow {
  rolledBackVersion: string;
  restoredVersion: string;
  /** When the rolled-back release went live. */
  deployedAt: Date;
  rollbackStartedAt: Date;
  rollbackCompletedAt?: Date;
  rollbackStatus: 'completed' | 'in_progress' | 'failed';
}

export interface RollbackExternalReference {
  id: string;
  kind: string;
  /** Invoice the reference ultimately belongs to (resolved through settlements). */
  invoiceId: string;
  reference: string;
  status: 'pending' | 'confirmed' | 'delivered' | 'failed' | 'rejected';
  createdAt: Date;
}

/** Read-only port. Implementations must not mutate anything from these methods. */
export interface RollbackDataSource {
  listInvoices(): Promise<StoredInvoice[]>;
  listJobs(): Promise<Job[]>;
  listExternalReferences(): Promise<RollbackExternalReference[]>;
  /** Version reported by the running service, if known. */
  observedVersion?(): Promise<string | undefined>;
}

const READ_METHODS = new Set<string>(['listInvoices', 'listJobs', 'listExternalReferences', 'observedVersion']);

export class RollbackDataSourceWriteAttempt extends Error {
  constructor(property: string) {
    super(`Post-rollback verification is read-only; refused access to '${property}' on the data source`);
    this.name = 'RollbackDataSourceWriteAttempt';
  }
}

/** Exposes only the read methods of a data source; anything else throws. */
export function readOnlyDataSource(source: RollbackDataSource): RollbackDataSource {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !READ_METHODS.has(prop) && prop !== 'then') {
        throw new RollbackDataSourceWriteAttempt(prop);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, prop) {
      throw new RollbackDataSourceWriteAttempt(String(prop));
    },
  });
}

export type RollbackCheckId =
  | 'rollback.status'
  | 'rollback.version'
  | 'jobs.unknown_type'
  | 'jobs.payload_version'
  | 'jobs.in_flight'
  | 'jobs.dead_in_window'
  | 'invoices.unknown_status'
  | 'invoices.schema_version'
  | 'invoices.partial_settlement'
  | 'invoices.written_in_window'
  | 'external.unknown_kind'
  | 'external.pending'
  | 'external.dangling';

export type FindingSeverity = 'critical' | 'repair' | 'review';

export interface RollbackFinding {
  check: RollbackCheckId;
  severity: FindingSeverity;
  resourceType: 'release' | 'invoice' | 'job' | 'external_reference';
  resourceId: string;
  message: string;
  remediation: string;
}

export interface ReleaseRollbackReport {
  status: 'clean' | 'needs_repair' | 'failed';
  exitCode: 0 | 1 | 2;
  readOnly: true;
  generatedAt: string;
  authorizedBy: string;
  window: { rolledBackVersion: string; restoredVersion: string; deployedAt: string; rollbackCompletedAt: string | null };
  checks: Array<{ id: RollbackCheckId; passed: boolean; findings: number }>;
  findings: RollbackFinding[];
  /** Ids needing manual repair, grouped by resource type. */
  manualRepair: { invoices: string[]; jobs: string[]; externalReferences: string[] };
  scanned: { invoices: number; jobs: number; externalReferences: number };
}

const ALL_CHECKS: RollbackCheckId[] = [
  'rollback.status',
  'rollback.version',
  'jobs.unknown_type',
  'jobs.payload_version',
  'jobs.in_flight',
  'jobs.dead_in_window',
  'invoices.unknown_status',
  'invoices.schema_version',
  'invoices.partial_settlement',
  'invoices.written_in_window',
  'external.unknown_kind',
  'external.pending',
  'external.dangling',
];

export interface ReleaseRollbackVerificationInput {
  window: ReleaseRollbackWindow;
  contract: RestoredBehaviourContract;
  source: RollbackDataSource;
  options?: Pick<RollbackVerificationOptions, 'actorId' | 'actorRole'> & { now?: Date };
}

export async function verifyReleaseRollback(input: ReleaseRollbackVerificationInput): Promise<ReleaseRollbackReport> {
  const { window, contract } = input;
  const role = input.options?.actorRole ?? 'ADMIN';
  const actorId = input.options?.actorId ?? 'operator';
  if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'OPERATOR') {
    throw new UnauthorizedRollbackVerificationError(actorId, role);
  }
  const now = input.options?.now ?? new Date();
  const source = readOnlyDataSource(input.source);
  const [invoices, jobs, refs, observed] = await Promise.all([
    source.listInvoices(),
    source.listJobs(),
    source.listExternalReferences(),
    input.source.observedVersion ? source.observedVersion!() : Promise.resolve(undefined),
  ]);

  const findings: RollbackFinding[] = [];
  const add = (f: RollbackFinding) => findings.push(f);
  const windowStart = window.deployedAt.getTime();
  const windowEnd = (window.rollbackCompletedAt ?? now).getTime();
  const inWindow = (d: Date | string | null | undefined) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= windowStart && t <= windowEnd;
  };

  // --- Release state: did the rollback take effect at all? ---------------
  if (window.rollbackStatus !== 'completed') {
    add({
      check: 'rollback.status',
      severity: 'critical',
      resourceType: 'release',
      resourceId: window.rolledBackVersion,
      message: `Rollback to ${window.restoredVersion} is ${window.rollbackStatus}; restored behaviour is not guaranteed to be in effect`,
      remediation: window.rollbackStatus === 'failed'
        ? 'Re-run the rollback (see RUNBOOK "Emergency rollback steps"), then re-run this verification.'
        : 'Wait for the rollback to finish, then re-run this verification.',
    });
  }
  if (observed !== undefined && observed !== window.restoredVersion) {
    add({
      check: 'rollback.version',
      severity: 'critical',
      resourceType: 'release',
      resourceId: observed,
      message: `Service reports version ${observed}, expected ${window.restoredVersion}`,
      remediation: 'Confirm every instance runs the restored build (npm run deploy:smoke, /api/health).',
    });
  }

  // --- Background jobs ----------------------------------------------------
  for (const job of jobs) {
    const pending = job.status === 'queued' || job.status === 'running';
    const maxVersion = contract.jobHandlers[job.type];
    if (pending && maxVersion === undefined) {
      add({
        check: 'jobs.unknown_type',
        severity: 'repair',
        resourceType: 'job',
        resourceId: job.id,
        message: `${job.status} job type '${job.type}' has no handler in ${contract.version}; it will never run or will dead-letter`,
        remediation: 'Drain the job (stop it being claimed) and re-create the equivalent work with a type the restored release handles.',
      });
    } else if (pending && job.payload.version > maxVersion) {
      add({
        check: 'jobs.payload_version',
        severity: 'repair',
        resourceType: 'job',
        resourceId: job.id,
        message: `${job.type} payload v${job.payload.version} is newer than v${maxVersion} supported by ${contract.version}`,
        remediation: 'Rewrite the payload to the supported version or cancel and re-enqueue it.',
      });
    }
    if (job.status === 'running' && inWindow(job.updatedAt)) {
      add({
        check: 'jobs.in_flight',
        severity: 'repair',
        resourceType: 'job',
        resourceId: job.id,
        message: `${job.type} was claimed by ${job.lockedBy ?? 'a worker'} of ${window.rolledBackVersion} and is partially processed`,
        remediation: 'Check the side-effect checkpoints for this job before letting its lease expire and the restored worker reclaim it.',
      });
    }
    if (job.status === 'dead' && inWindow(job.completedAt)) {
      add({
        check: 'jobs.dead_in_window',
        severity: 'review',
        resourceType: 'job',
        resourceId: job.id,
        message: `${job.type} dead-lettered while ${window.rolledBackVersion} was live`,
        remediation: 'Decide whether to requeue (POST /ops/intents job.requeue_dead) now that the restored behaviour is back.',
      });
    }
  }

  // --- User-facing state: invoices -----------------------------------------
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const confirmedTxByInvoice = new Map<string, RollbackExternalReference>();
  for (const ref of refs) if (ref.kind === 'stellar_tx' && ref.status === 'confirmed') confirmedTxByInvoice.set(ref.invoiceId, ref);
  const allowUnversioned = contract.allowUnversionedInvoices !== false;

  for (const inv of invoices) {
    if (!contract.invoiceStatuses.includes(inv.status)) {
      add({
        check: 'invoices.unknown_status',
        severity: 'repair',
        resourceType: 'invoice',
        resourceId: inv.id,
        message: `Status '${inv.status}' is not part of ${contract.version}`,
        remediation: 'Map the record to a status the restored release understands via a resumable repair job.',
      });
    }
    const schema = inv._schemaVersion;
    if (schema === undefined ? !allowUnversioned : !contract.invoiceSchemaVersions.includes(schema)) {
      add({
        check: 'invoices.schema_version',
        severity: 'repair',
        resourceType: 'invoice',
        resourceId: inv.id,
        message: `Record written with schema ${schema ?? 'none'}; ${contract.version} reads ${contract.invoiceSchemaVersions.join(', ')}`,
        remediation: 'Down-convert the record (see SCHEMA_VERSIONING.md) or keep the newer reader enabled until it is migrated.',
      });
    }
    const paidFieldsComplete = Boolean(inv.paymentTxHash && inv.paidAt && inv.payerPublicKey);
    const observedPayment = confirmedTxByInvoice.get(inv.id);
    let partial: string | undefined;
    if (inv.status === 'PAID' && !paidFieldsComplete) partial = 'PAID without complete payment fields (tx hash, paidAt, payer)';
    else if (inv.status !== 'PAID' && inv.paymentTxHash) partial = `${inv.status} but carries paymentTxHash`;
    else if (inv.status !== 'PAID' && observedPayment) partial = `${inv.status} but a confirmed payment ${observedPayment.reference.slice(0, 12)}… was observed`;
    else if (inv.status === 'PAID' && observedPayment && observedPayment.reference !== inv.paymentTxHash) partial = 'PAID with a tx hash that differs from the confirmed payment';
    if (partial) {
      add({
        check: 'invoices.partial_settlement',
        severity: 'repair',
        resourceType: 'invoice',
        resourceId: inv.id,
        message: `Partially processed settlement: ${partial}`,
        remediation: 'Re-run payment verification for this invoice (POST /ops/reconciliation/dry-run, then apply) and confirm on Horizon.',
      });
    }
    if (inWindow(inv.createdAt) || inWindow(inv.paidAt)) {
      add({
        check: 'invoices.written_in_window',
        severity: 'review',
        resourceType: 'invoice',
        resourceId: inv.id,
        message: `${inv.memo} was created or settled while ${window.rolledBackVersion} was live`,
        remediation: 'Spot-check that the restored release renders and acts on this record as expected.',
      });
    }
  }

  // --- External references ---------------------------------------------
  for (const ref of refs) {
    if (!contract.externalReferenceKinds.includes(ref.kind)) {
      add({
        check: 'external.unknown_kind',
        severity: 'repair',
        resourceType: 'external_reference',
        resourceId: ref.id,
        message: `Reference kind '${ref.kind}' is not handled by ${contract.version}`,
        remediation: 'Reconcile the reference with the provider manually and record the outcome on the invoice.',
      });
    }
    if (!invoiceIds.has(ref.invoiceId)) {
      add({
        check: 'external.dangling',
        severity: 'repair',
        resourceType: 'external_reference',
        resourceId: ref.id,
        message: `${ref.kind} ${ref.reference} points at missing invoice ${ref.invoiceId}`,
        remediation: 'Find the invoice the provider call was made for (memo, tx hash) or record the reference as orphaned.',
      });
    }
    if (ref.status === 'pending' && inWindow(ref.createdAt)) {
      add({
        check: 'external.pending',
        severity: 'repair',
        resourceType: 'external_reference',
        resourceId: ref.id,
        message: `${ref.kind} ${ref.reference} dispatched by ${window.rolledBackVersion} has no recorded outcome`,
        remediation: 'Query the provider for the outcome before retrying, to avoid duplicate sends or payments.',
      });
    }
  }

  const severityOrder: Record<FindingSeverity, number> = { critical: 0, repair: 1, review: 2 };
  findings.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity] || ALL_CHECKS.indexOf(a.check) - ALL_CHECKS.indexOf(b.check) || (a.resourceId < b.resourceId ? -1 : 1)
  );

  const repairIds = (type: RollbackFinding['resourceType']) =>
    [...new Set(findings.filter((f) => f.severity === 'repair' && f.resourceType === type).map((f) => f.resourceId))].sort();
  const status = findings.some((f) => f.severity === 'critical') ? 'failed' : findings.some((f) => f.severity === 'repair') ? 'needs_repair' : 'clean';

  return {
    status,
    exitCode: status === 'clean' ? 0 : status === 'needs_repair' ? 1 : 2,
    readOnly: true,
    generatedAt: now.toISOString(),
    authorizedBy: actorId,
    window: {
      rolledBackVersion: window.rolledBackVersion,
      restoredVersion: window.restoredVersion,
      deployedAt: window.deployedAt.toISOString(),
      rollbackCompletedAt: window.rollbackCompletedAt?.toISOString() ?? null,
    },
    checks: ALL_CHECKS.map((id) => {
      const count = findings.filter((f) => f.check === id).length;
      return { id, passed: count === 0, findings: count };
    }),
    findings,
    manualRepair: { invoices: repairIds('invoice'), jobs: repairIds('job'), externalReferences: repairIds('external_reference') },
    scanned: { invoices: invoices.length, jobs: jobs.length, externalReferences: refs.length },
  };
}

export function formatReleaseRollbackReport(report: ReleaseRollbackReport): string {
  const lines = [
    `Post-rollback verification: ${report.status.toUpperCase()} (${report.window.rolledBackVersion} -> ${report.window.restoredVersion}, read-only)`,
    `Scanned ${report.scanned.invoices} invoices, ${report.scanned.jobs} jobs, ${report.scanned.externalReferences} external references.`,
    '',
    ...report.checks.map((c) => `  ${c.passed ? 'PASS' : 'FAIL'}  ${c.id}${c.passed ? '' : ` (${c.findings})`}`),
  ];
  if (report.findings.length) {
    lines.push('', 'Findings:');
    for (const f of report.findings) {
      lines.push(`  [${f.severity}] ${f.check} ${f.resourceType}:${f.resourceId}`, `      ${f.message}`, `      -> ${f.remediation}`);
    }
  }
  const { invoices, jobs, externalReferences } = report.manualRepair;
  if (invoices.length + jobs.length + externalReferences.length) {
    lines.push('', `Manual repair required: ${invoices.length} invoices, ${jobs.length} jobs, ${externalReferences.length} external references.`);
  }
  return lines.join('\n');
}
