import { Router } from 'express';
import type { JobStore } from '../jobs/job-types';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { metrics } from '../observability/telemetry';
import { apiFailure } from '../types/api';
import { buildOpsHealthReport } from '../ops/ops-health';
import { requireAdmin } from './jobs.routes';
import {
  ImpersonationService,
  impersonationService,
  IMPERSONATION_PERMISSIONS,
  type ImpersonationPermission,
} from '../audit/impersonation';
import { stellarPublicKeySchema } from '../utils/validation';
import {
  simulatePolicyChange,
  runMaintainerPolicySimulation,
  PolicySimulationPermissionError,
  PolicySimulationValidationError,
} from '../domain/policy-simulation';
import {
  runPolicySimulationPreview,
  parsePolicySimulationPreviewRequest,
  PolicyPreviewError,
} from '../domain/policy-simulation-preview';
import { evaluatePolicyDryRun, parsePolicyDryRunRequest, PolicyDryRunError } from '../domain/policy-dry-run';
import {
  SecurityEventInvalidator,
  createSecurityEventInvalidator,
  SecurityEventInvalidationError,
  type SecurityEventInvalidationInput,
} from '../security/security-event-invalidator';
import { loadPolicy } from '../domain/policy';
import {
  TrendExportService,
  TrendExportPermissionError,
  TrendExportValidationError,
  type TrendWindowGranularity,
} from '../exports/trend-export';
import { explainRejection } from '../errors/rejection-explanation';
import {
  ExternalReferenceVerificationService,
  defaultExternalReferenceVerifier,
  type ExternalReferenceInput,
  type ExternalReferenceProbe,
} from '../services/external-reference-verification';
import { CapabilityError, CapabilityTokenService, capabilityServiceFromEnv } from '../security/capability-tokens';
import { AdminConfigError, AdminConfigService, adminConfig } from '../config/admin-config';
import { staleProjectionService } from '../ops/stale-projections.service';
import { defaultSearchIndex } from '../services/search-index.service';
import { SyntheticJourneyMonitor } from '../ops/synthetic-journey-monitor';
import {
  EventSchemaDriftDetector,
  EventSchemaDriftError,
  defaultEventSchemaDriftDetector,
} from '../schema/event-schema-drift';
import { OwnershipTransferService } from '../services/ownership-transfer.service';
import { OwnershipTransferError } from '../domain/ownership-transfer';
import {
  IncidentRecoveryRunner,
  UnauthorizedRecoveryCheckError,
} from '../ops/incident-recovery-checks';
import { verifySnapshotRestore } from '../db/snapshot-restore-verification';
import {
  DEPENDENCY_MATRIX,
  runDependencyChecks,
  validateMatrix,
  type DependencyId,
  type DependencyProbe,
  type Capability,
} from '../ops/dependency-degradation';
import { DegradedModeService, degradedModeService } from '../ops/degraded-mode.service';
import {
  PartialFailureRetryCoordinator,
  buildDashboard,
  inspectJobFailure,
  parseDashboardFilter,
} from '../ops/partial-failure-dashboard';
import { jobsToOperations } from '../domain/partial-failures';
import { ApprovalError, MaintainerApprovalService, type IntentStatus, type ReceiptOutcome } from '../ops/maintainer-approval';
import { auditStore } from '../audit/audit-service';
import {
  NothingToRollBackError,
  ProjectionReplayService,
  ReplayInProgressError,
  UnknownProjectorVersionError,
} from '../ops/projection-replay';
import {
  ResumableRepairService,
  RepairJobNotFoundError,
  type RepairPhase,
} from '../ops/resumable-repair.service';
import { pool } from '../config/database';
import { EventLedger, eventLedger } from '../audit/event-ledger';
import { FeatureRolloutController, featureRollout } from '../config/feature-rollout';
import { registerGovernanceRoutes } from './governance.routes';

export interface OpsRouterOptions {
  storage: InvoiceStorage;
  jobs?: JobStore;
  /** Same bearer token as /jobs (JOBS_ADMIN_TOKEN). When empty, the route is disabled (403). */
  adminToken?: string;
  /** Overridable for tests. */
  impersonation?: ImpersonationService;
  /** Health probes per external dependency. Missing probes report `unknown`. */
  dependencyProbes?: Partial<Record<DependencyId, DependencyProbe>>;
  /**
   * Approval service for high-impact actions. Defaults to one keyed by
   * MAINTAINER_INTENT_SECRET; when that is unset the intent routes return 403.
   */
  approvals?: MaintainerApprovalService | null;
  /**
   * Capability tokens for sensitive actions. Defaults to one keyed by
   * CAPABILITY_TOKEN_SECRET; when that is unset the capability routes return 403.
   */
  capabilities?: CapabilityTokenService | null;
  /** Audited runtime configuration. Defaults to the process instance. */
  adminConfig?: AdminConfigService;
  /** Search-index event replay (#290). Defaults to the live index and audit trail. */
  replay?: ProjectionReplayService;
  /** Resumable record repair service for orphaned and inconsistent records. */
  repairService?: ResumableRepairService;
  /** Historical trend export service. */
  trendExport?: TrendExportService;
  /** Resilient external reference verification service. */
  externalReferences?: ExternalReferenceVerificationService;
  /** Custom external reference probe for verification routes. */
  externalReferenceProbe?: ExternalReferenceProbe;
  /** Tamper-evident event ledger (#250). Defaults to the process ledger. */
  ledger?: EventLedger;
  /** Feature rollout guardrails (#309). Defaults to the process controller. */
  rollout?: FeatureRolloutController;
  /**
   * Secret used to sign pagination cursors for the policy simulation preview
   * endpoint (#432). When unset (or shorter than 32 characters), cursor-based
   * paging is disabled and only the first page is returned. Treat as a secret.
   */
  policyPreviewCursorSecret?: string;
  /**
   * Security-event session invalidator (#433). Defaults to one wired to the
   * process impersonation service, capability service, and audit store.
   * Pass null to disable the invalidation route (403).
   */
  securityInvalidator?: SecurityEventInvalidator | null;
}

function defaultApprovals(): MaintainerApprovalService | null {
  const secret = process.env.MAINTAINER_INTENT_SECRET;
  if (!secret || secret.length < 16) return null;
  return new MaintainerApprovalService({
    secret,
    onReceipt: (r) =>
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: r.executedBy ?? r.requestedBy },
        scope: { entityType: 'system', entityId: r.target },
        reason: `${r.action}: ${r.outcome}`,
        metadata: {
          receiptId: r.id,
          intentId: r.intentId,
          outcome: r.outcome,
          approvedBy: r.approvedBy,
          riskScore: r.risk?.score ?? null,
          riskLevel: r.risk?.level ?? null,
          riskFactors: r.risk?.factors.map((f) => f.code) ?? [],
        },
      }),
  });
}

const durationOf = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Mount under `/api`.
 *   GET  /ops/health  maintainer summary of unresolved failures and drift
 *
 *   POST /ops/impersonation           start a scoped, time-limited session
 *   POST /ops/impersonation/end       close a session
 *   GET  /ops/impersonation           list sessions / read the banner state
 */
export function createOpsRouter(options: OpsRouterOptions): Router {
  const router = Router();
  const impersonation = options.impersonation ?? impersonationService;
  const admin = requireAdmin(options.adminToken);
  const approvals = options.approvals === undefined ? defaultApprovals() : options.approvals;
  const retries = options.jobs ? new PartialFailureRetryCoordinator(options.jobs) : null;
  const capabilities = options.capabilities === undefined ? capabilityServiceFromEnv() : options.capabilities;
  // Security-event session invalidator (#433). Defaults to a process-wide
  // instance wired to the live impersonation/capability/audit singletons.
  // Pass null explicitly to disable the invalidation route.
  const securityInvalidator =
    options.securityInvalidator === undefined
      ? createSecurityEventInvalidator(impersonation, capabilities, auditStore)
      : options.securityInvalidator;
  // Cursor secret for the policy simulation preview (#432). Pulled from
  // options, falling back to the capability secret (already validated for
  // length) so a configured deployment gets paging for free.
  const policyPreviewCursorSecret =
    options.policyPreviewCursorSecret ??
    (process.env.POLICY_PREVIEW_CURSOR_SECRET && process.env.POLICY_PREVIEW_CURSOR_SECRET.length >= 32
      ? process.env.POLICY_PREVIEW_CURSOR_SECRET
      : undefined);
  const config = options.adminConfig ?? adminConfig;
  const replay =
    options.replay ??
    new ProjectionReplayService({
      storage: options.storage,
      index: defaultSearchIndex,
      events: () => auditStore.listChronological(),
    });
  const repairService = options.repairService ?? new ResumableRepairService({ db: pool });
  const trendExport =
    options.trendExport ??
    new TrendExportService({
      storage: options.storage,
      jobs: options.jobs,
      recentLogs: () => metrics.getRecentLogs(200),
    });
  const externalReferences = options.externalReferences ?? defaultExternalReferenceVerifier;
  const degradedMode = options.degradedMode ?? degradedModeService;
  const publicStatus = options.publicStatus ?? publicStatusService;
  const rollouts = options.rollouts ?? rolloutGuard;
  const reconciliation =
    options.reconciliation ??
    new ReconciliationService({
      storage: options.storage,
      index: defaultSearchIndex,
      auditLookup: options.storage.getAuditEventsByInvoice
        ? (id) => options.storage.getAuditEventsByInvoice!(id)
        : undefined,
    });

  if (approvals && options.jobs) {
    const jobs = options.jobs;
    approvals.registerExecutor('job.requeue_dead', async (intent) => {
      const job = await jobs.requeueDead(intent.target, new Date());
      if (!job) throw new Error('Job is not dead-lettered (state changed since intent was declared)');
      return { jobId: job.id, status: job.status };
    });
  }
  if (approvals) {
    approvals.registerExecutor('invoice.cancel', async (intent) => {
      const expected = typeof intent.params.expectedVersion === 'number' ? intent.params.expectedVersion : undefined;
      const invoice = await options.storage.cancelInvoice(intent.target, expected);
      return { invoiceId: invoice.id, status: invoice.status, version: invoice.version ?? null };
    });
  }

  const fail = (res: any, req: any, status: number, code: string, error: string) =>
    res.status(status).json(apiFailure(error, { code, correlationId: req.correlationId }));

  // -- External dependency degradation matrix --------------------------------

  router.get('/ops/dependencies/matrix', admin, (req, res) => {
    res.json({
      success: true,
      data: { matrix: DEPENDENCY_MATRIX.map((d) => ({ ...d, failureModes: d.failureModes.map((f) => ({ code: f.code, description: f.description })) })), problems: validateMatrix() },
      correlationId: req.correlationId,
    });
  });

  router.get('/ops/dependencies', admin, async (req, res, next) => {
    try {
      const report = await runDependencyChecks(options.dependencyProbes ?? {});
      res.status(report.overall === 'down' ? 503 : 200).json({ success: report.overall !== 'down', data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Degraded mode & capability status -------------------------------------

  router.get('/ops/degraded-mode/status', admin, async (req, res, next) => {
    try {
      const status = await degradedMode.getStatus({ forceRefresh: req.query.refresh === 'true' });
      res.json({ success: true, data: status, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/degraded-mode/overrides', admin, (req, res) => {
    const { dependency, state, reason } = req.body ?? {};
    if (!dependency || !state || !reason) {
      return fail(res, req, 400, 'INVALID_OVERRIDE_PAYLOAD', 'dependency, state, and reason are required');
    }

    try {
      const override = degradedMode.setOverride(dependency, state, String(reason), 'ops-admin');
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: dependency },
        reason: `Set manual degradation override: ${state} (${reason})`,
        metadata: override,
        correlationId: req.correlationId,
      });

      res.status(201).json({ success: true, data: override, correlationId: req.correlationId });
    } catch (err: any) {
      fail(res, req, 400, 'INVALID_DEPENDENCY', err.message);
    }
  });

  router.delete('/ops/degraded-mode/overrides/:dependency', admin, (req, res) => {
    const dep = req.params.dependency as DependencyId;
    const cleared = degradedMode.clearOverride(dep);
    if (!cleared) {
      return fail(res, req, 404, 'OVERRIDE_NOT_FOUND', `No manual override found for ${dep}`);
    }

    auditStore.recordEvent({
      action: 'MAINTAINER_ACTION',
      actor: { type: 'maintainer', id: 'ops-admin' },
      scope: { entityType: 'system', entityId: dep },
      reason: `Cleared manual degradation override for ${dep}`,
      metadata: { dependency: dep },
      correlationId: req.correlationId,
    });

    res.json({ success: true, data: { cleared: true, dependency: dep }, correlationId: req.correlationId });
  });

  router.delete('/ops/degraded-mode/overrides', admin, (req, res) => {
    degradedMode.clearAllOverrides();
    auditStore.recordEvent({
      action: 'MAINTAINER_ACTION',
      actor: { type: 'maintainer', id: 'ops-admin' },
      scope: { entityType: 'system', entityId: 'all' },
      reason: 'Cleared all manual degradation overrides',
      correlationId: req.correlationId,
    });

    res.json({ success: true, data: { clearedAll: true }, correlationId: req.correlationId });
  });

  router.get('/ops/degraded-mode/capabilities/:capability', admin, async (req, res, next) => {
    try {
      const cap = req.params.capability as Capability;
      const decision = await degradedMode.checkCapability(cap);
      res.json({ success: true, data: decision, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Partial-failure dashboard ---------------------------------------------

  router.get('/ops/partial-failures', admin, async (req, res, next) => {
    try {
      const { filter, error } = parseDashboardFilter(req.query as Record<string, unknown>);
      if (error) return fail(res, req, 400, 'INVALID_FILTER', error);
      const jobs = options.jobs ? (await options.jobs.list({ limit: 1000 })).jobs : [];
      res.json({ success: true, data: buildDashboard(jobsToOperations(jobs), filter), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ops/partial-failures/:id', admin, async (req, res, next) => {
    try {
      const job = options.jobs ? await options.jobs.get(req.params.id) : null;
      if (!job) return fail(res, req, 404, 'NOT_FOUND', 'Operation not found');
      res.json({ success: true, data: inspectJobFailure(job), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/partial-failures/:id/retry', admin, async (req, res, next) => {
    try {
      if (!retries) return fail(res, req, 503, 'JOBS_UNAVAILABLE', 'Job store not configured');
      const key = req.header('idempotency-key') ?? (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined);
      const outcome = await retries.retry(req.params.id, key);
      if (outcome.status === 'rejected') {
        const status = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'USER_ACTION_REQUIRED' ? 422 : 409;
        return fail(res, req, status, outcome.code, outcome.message);
      }
      if (outcome.status === 'requeued') {
        auditStore.recordEvent({
          action: 'MAINTAINER_ACTION',
          actor: { type: 'maintainer', id: 'ops-admin' },
          scope: { entityType: 'system', entityId: outcome.job.id },
          reason: 'Partial failure retried from dashboard',
          metadata: { jobType: outcome.job.type, idempotencyKey: key ?? null },
          correlationId: req.correlationId,
        });
      }
      res.json({ success: true, data: { status: outcome.status, job: outcome.job }, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Maintainer action approvals with signed intent receipts ---------------

  const needApprovals = (req: any, res: any, next: any) =>
    approvals ? next() : fail(res, req, 403, 'APPROVALS_DISABLED', 'Set MAINTAINER_INTENT_SECRET to enable high-impact actions');
  /** Typed domain errors carry their own status and code; anything else is a 500. */
  const knownError = (req: any, res: any, err: unknown, next: any) =>
    err instanceof ApprovalError ||
    err instanceof CapabilityError ||
    err instanceof AdminConfigError ||
    err instanceof PolicyDryRunError ||
    err instanceof PublicStatusError ||
    err instanceof RolloutGuardError ||
    err instanceof ReconciliationError
      ? fail(res, req, err.httpStatus, err.code, err.message)
      : next(err);

  // -- Public status: degraded / paused / maintenance (#254) -----------------

  router.get('/ops/public-status', admin, async (req, res, next) => {
    try {
      res.json({ success: true, data: await publicStatus.internalStatus(), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.put('/ops/public-status', admin, async (req, res, next) => {
    try {
      const declaration = publicStatus.declare({
        state: req.body?.state,
        reason: req.body?.reason,
        expectedResolutionAt: req.body?.expectedResolutionAt,
        expectedVersion: req.body?.expectedVersion,
        actorId: 'ops-admin',
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: { declaration, version: publicStatus.getVersion() }, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.delete('/ops/public-status', admin, (req, res, next) => {
    try {
      const cleared = publicStatus.clear({
        reason: req.body?.reason,
        expectedVersion: req.body?.expectedVersion,
        actorId: 'ops-admin',
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: { cleared, version: publicStatus.getVersion() }, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  // -- Feature-flag rollout guard (#256) --------------------------------------

  router.get('/ops/rollouts', admin, (req, res) => {
    res.json({ success: true, data: rollouts.list(), correlationId: req.correlationId });
  });

  router.post('/ops/rollouts/:flag', admin, (req, res, next) => {
    try {
      const record = rollouts.start({
        flag: req.params.flag,
        scope: req.body?.scope,
        guardrail: req.body?.guardrail,
        reason: req.body?.reason,
        actorId: 'ops-admin',
        correlationId: req.correlationId,
      });
      res.status(201).json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  // Outcome signals from monitors (synthetic journey, smoke checks) feed the guardrail.
  router.post('/ops/rollouts/:flag/outcomes', admin, (req, res) => {
    const ok = Number(req.body?.ok ?? 0);
    const failed = Number(req.body?.failed ?? 0);
    if (![ok, failed].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000) || ok + failed === 0) {
      return fail(res, req, 400, 'INVALID_ROLLOUT', 'ok and failed must be non-negative integers (at most 1000 each) with at least one outcome');
    }
    if (!rollouts.get(req.params.flag as FeatureFlag)) {
      return fail(res, req, 404, 'ROLLOUT_NOT_FOUND', `No rollout of "${req.params.flag}"`);
    }
    let record = null;
    for (let i = 0; i < ok; i++) record = rollouts.recordOutcome(req.params.flag as FeatureFlag, true, req.correlationId);
    for (let i = 0; i < failed; i++) record = rollouts.recordOutcome(req.params.flag as FeatureFlag, false, req.correlationId);
    res.json({ success: true, data: record, correlationId: req.correlationId });
  });

  router.post('/ops/rollouts/:flag/rollback', admin, (req, res, next) => {
    try {
      const record = rollouts.rollback(req.params.flag, {
        trigger: 'manual',
        reason: req.body?.reason,
        actorId: 'ops-admin',
        correlationId: req.correlationId,
      });
      res.status(record.status === 'rolled_back' ? 200 : 500).json({
        success: record.status === 'rolled_back',
        data: record,
        correlationId: req.correlationId,
      });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/rollouts/:flag/verify', admin, (req, res) => {
    const record = rollouts.get(req.params.flag as FeatureFlag);
    if (!record) return fail(res, req, 404, 'ROLLOUT_NOT_FOUND', `No rollout of "${req.params.flag}"`);
    const verification = rollouts.verifyRollback(record.flag, record.scope.allowList);
    res.status(verification.consistent ? 200 : 409).json({ success: verification.consistent, data: verification, correlationId: req.correlationId });
  });

  router.post('/ops/rollouts/:flag/complete', admin, (req, res, next) => {
    try {
      res.json({ success: true, data: rollouts.complete(req.params.flag, 'ops-admin', req.correlationId), correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  // -- Projection reconciliation, dry run first (#255) ------------------------

  router.post('/ops/reconciliation/dry-run', admin, async (req, res, next) => {
    try {
      res.json({ success: true, data: await reconciliation.plan(), correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/reconciliation/apply', admin, async (req, res, next) => {
    const planId = req.body?.planId;
    if (typeof planId !== 'string' || planId.length === 0) {
      return fail(res, req, 400, 'PLAN_REQUIRED', 'planId from a dry run is required; repairs are never applied without one');
    }
    try {
      const result = await reconciliation.apply(planId, 'ops-admin');
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: 'search_index' },
        reason: 'Projection reconciliation applied',
        metadata: { runId: result.runId, planId, applied: result.applied.length, failed: result.failed.length, clean: result.verification.clean },
        correlationId: req.correlationId,
      });
      res.status(result.verification.clean && result.failed.length === 0 ? 200 : 207).json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof ReconciliationError && err.code === 'PLAN_STALE') {
        return res.status(409).json({
          ...apiFailure(err.message, { code: err.code, correlationId: req.correlationId }),
          data: err.plan,
        });
      }
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/reconciliation/rollback', admin, (req, res, next) => {
    try {
      const result = reconciliation.rollback();
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: 'search_index' },
        reason: 'Projection reconciliation rolled back',
        metadata: result,
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/intents', admin, needApprovals, (req, res, next) => {
    try {
      const intent = approvals!.requestIntent({
        action: String(req.body?.action ?? ''),
        target: String(req.body?.target ?? ''),
        reason: String(req.body?.reason ?? ''),
        requestedBy: String(req.body?.requestedBy ?? ''),
        params: req.body?.params && typeof req.body.params === 'object' ? req.body.params : {},
      });
      res.status(201).json({ success: true, data: intent, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.get('/ops/intents', admin, needApprovals, (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as IntentStatus) : undefined;
    res.json({ success: true, data: approvals!.listIntents({ status }), correlationId: req.correlationId });
  });

  router.post('/ops/intents/:id/approve', admin, needApprovals, (req, res, next) => {
    try {
      res.json({ success: true, data: approvals!.approve(req.params.id, String(req.body?.approverId ?? '')), correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/intents/:id/reject', admin, needApprovals, (req, res, next) => {
    try {
      res.json({ success: true, data: approvals!.reject(req.params.id, String(req.body?.maintainerId ?? ''), String(req.body?.reason ?? '')), correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.post('/ops/intents/:id/execute', admin, needApprovals, async (req, res, next) => {
    try {
      const receipt = await approvals!.execute(req.params.id, {
        executedBy: String(req.body?.executedBy ?? ''),
        confirmation: String(req.body?.confirmation ?? ''),
        params: req.body?.params,
      });
      res.status(receipt.outcome === 'succeeded' ? 200 : 502).json({ success: receipt.outcome === 'succeeded', data: receipt, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  router.get('/ops/receipts', admin, needApprovals, (req, res) => {
    const outcome = typeof req.query.outcome === 'string' ? (req.query.outcome as ReceiptOutcome) : undefined;
    const target = typeof req.query.target === 'string' ? req.query.target : undefined;
    res.json({
      success: true,
      data: { receipts: approvals!.listReceipts({ outcome, target }), chainBrokenAt: approvals!.verifyReceiptChain() },
      correlationId: req.correlationId,
    });
  });

  router.get('/ops/receipts/:id', admin, needApprovals, (req, res) => {
    const receipt = approvals!.getReceipt(req.params.id);
    if (!receipt) return fail(res, req, 404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
    res.json({ success: true, data: { receipt, signatureValid: approvals!.verifyReceipt(receipt) }, correlationId: req.correlationId });
  });

  router.get('/ops/health', admin, async (req, res, next) => {
    try {
      const report = await buildOpsHealthReport({
        storage: options.storage,
        jobs: options.jobs,
        recentLogs: () => metrics.getRecentLogs(200),
      });
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Policy simulation preview before committing changes (Issue #267)
  router.post('/ops/policy/simulate', admin, async (req, res, next) => {
    try {
      const current = loadPolicy();
      const rawPolicy = req.body?.proposedPolicy;
      const actor = req.body?.actor ?? { id: 'ops-admin', role: 'maintainer' };

      // When caller supplies explicit proposedPolicy fields, selection, fixtureName, or actor,
      // run the full maintainer simulation tool with strict validation and workflow checks.
      if (
        req.body?.fixtureName ||
        req.body?.selection ||
        req.body?.actor ||
        (rawPolicy !== undefined &&
          (typeof rawPolicy !== 'object' ||
            rawPolicy === null ||
            Array.isArray(rawPolicy) ||
            Object.keys(rawPolicy).length > 0))
      ) {
        const invoices =
          req.body?.fixtureName || !options.storage.getAllInvoices
            ? []
            : await options.storage.getAllInvoices();
        const workflows = options.jobs ? (await options.jobs.list({ limit: 1000 })).jobs : [];
        const simulation = runMaintainerPolicySimulation({
          actor,
          proposedPolicy: rawPolicy,
          currentPolicy: current,
          invoices,
          workflows,
          selection: req.body?.selection,
          fixtureName: req.body?.fixtureName,
          maxExamples: req.body?.maxExamples,
        });
        return res.json({ success: true, data: simulation, correlationId: req.correlationId });
      }

      const invoices = options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [];
      const simulation = simulatePolicyChange(invoices, rawPolicy || {}, current);
      res.json({ success: true, data: simulation, correlationId: req.correlationId });
    } catch (err) {
      if (
        err instanceof PolicySimulationPermissionError ||
        err instanceof PolicySimulationValidationError
      ) {
        const explanation = explainRejection(err, { correlationId: req.correlationId });
        return res.status(err.httpStatus).json({
          success: false,
          code: err.code,
          error: err.message,
          explanation,
          correlationId: req.correlationId,
        });
      }
      next(err);
    }
  });

  // Dry-run policy evaluation with paginated affected-record previews (#296).
  // Validation runs before any record is read; a storage that cannot enumerate
  // invoices fails closed rather than reporting an empty impact.
  router.post('/ops/policy/dry-run', admin, async (req, res, next) => {
    try {
      const request = parsePolicyDryRunRequest(req.body, loadPolicy());
      if (!options.storage.getAllInvoices) {
        return fail(res, req, 503, 'DRY_RUN_UNAVAILABLE', 'Storage cannot enumerate invoices, so impact cannot be evaluated');
      }
      const invoices = await options.storage.getAllInvoices();
      res.json({ success: true, data: evaluatePolicyDryRun(invoices, request), correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  // -- Capability tokens for sensitive actions (#285) ------------------------

  const needCapabilities = (req: any, res: any, next: any) =>
    capabilities
      ? next()
      : fail(res, req, 403, 'CAPABILITIES_DISABLED', 'Set CAPABILITY_TOKEN_SECRET (32+ characters) to enable sensitive admin actions');

  router.post('/ops/capabilities', admin, needCapabilities, (req, res, next) => {
    try {
      const ttlSeconds = req.body?.ttlSeconds;
      const { token, claims } = capabilities!.issue({
        action: String(req.body?.action ?? ''),
        target: String(req.body?.target ?? ''),
        subject: String(req.body?.subject ?? ''),
        ttlMs: ttlSeconds === undefined ? undefined : Number(ttlSeconds) * 1000,
      });
      // Recorded before the token is returned: no capability exists without evidence.
      auditStore.recordEvent({
        action: 'CAPABILITY_ISSUED',
        actor: { type: 'maintainer', id: claims.subject, ip: req.ip, userAgent: req.get('user-agent') },
        scope: { entityType: 'system', entityId: claims.target },
        reason: `Capability issued for ${claims.action}`,
        metadata: { capabilityId: claims.id, action: claims.action, expiresAt: new Date(claims.exp).toISOString() },
        correlationId: req.correlationId,
      });
      res.status(201).json({
        success: true,
        data: {
          token,
          capabilityId: claims.id,
          action: claims.action,
          target: claims.target,
          subject: claims.subject,
          issuedAt: new Date(claims.iat).toISOString(),
          expiresAt: new Date(claims.exp).toISOString(),
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  // -- Audited runtime configuration (#292) ----------------------------------

  router.get('/ops/config', admin, (req, res) => {
    res.json({ success: true, data: config.snapshot(), correlationId: req.correlationId });
  });

  router.put('/ops/config/feature-flags/:flag', admin, needCapabilities, async (req, res, next) => {
    try {
      const result = await capabilities!.use(
        req.header('x-capability-token'),
        { action: 'config.feature_flag.set', target: req.params.flag },
        (claims) =>
          config.setFeatureFlag({
            flag: req.params.flag,
            enabled: req.body?.enabled,
            reason: req.body?.reason,
            expectedVersion: req.body?.expectedVersion,
            actorId: claims.subject,
            capabilityId: claims.id,
            correlationId: req.correlationId,
            ip: req.ip,
            userAgent: req.get('user-agent'),
          })
      );
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      knownError(req, res, err, next);
    }
  });

  registerGovernanceRoutes(router, {
    admin,
    needCapabilities,
    capabilities,
    ledger: options.ledger ?? eventLedger,
    rollout: options.rollout ?? featureRollout,
  });

  // Stale projection detection and repair recommendations (Issue #269)
  router.get('/ops/stale-projections/detect', admin, async (req, res, next) => {
    try {
      const report = await staleProjectionService.detect(options.storage);
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/stale-projections/repair', admin, async (req, res, next) => {
    try {
      const mode = req.body?.mode === 'queued' ? 'queued' : 'immediate';
      const evidence = await staleProjectionService.repair(options.storage, defaultSearchIndex, { mode });
      res.json({ success: true, data: evidence, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Versioned event replay for the search-index projection (#290). Dry run by default.
  router.post('/ops/projections/search-index/replay', admin, async (req, res, next) => {
    const dryRun = req.body?.dryRun !== false;
    const version = req.body?.projectorVersion;
    if (version !== undefined && !Number.isSafeInteger(version)) {
      return fail(res, req, 400, 'INVALID_PROJECTOR_VERSION', 'projectorVersion must be an integer');
    }
    try {
      const report = await replay.replay({ dryRun, projectorVersion: version });
      if (report.outcome === 'refused') {
        return res.status(409).json({
          ...apiFailure(`Replay not applied: ${report.reasons.join('; ')}`, {
            code: 'REPLAY_REFUSED',
            correlationId: req.correlationId,
          }),
          data: report,
        });
      }
      if (report.outcome === 'applied') {
        auditStore.recordEvent({
          action: 'MAINTAINER_ACTION',
          actor: { type: 'maintainer', id: 'ops-admin' },
          scope: { entityType: 'system', entityId: 'search_index' },
          reason: 'Search index rebuilt by event replay',
          metadata: { projectorVersion: report.projectorVersion, events: report.events.total, diff: report.diff },
          correlationId: req.correlationId,
        });
      }
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof UnknownProjectorVersionError) return fail(res, req, 400, 'INVALID_PROJECTOR_VERSION', err.message);
      if (err instanceof ReplayInProgressError) return fail(res, req, 409, 'REPLAY_IN_PROGRESS', err.message);
      next(err);
    }
  });

  router.post('/ops/projections/search-index/rollback', admin, (req, res) => {
    try {
      const result = replay.rollback();
      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: 'search_index' },
        reason: 'Search index replay rolled back',
        metadata: result,
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof NothingToRollBackError) return fail(res, req, 409, 'NOTHING_TO_ROLL_BACK', err.message);
      throw err;
    }
  });

  // Synthetic journey monitor for critical workflow (Issue #264 / #391)
  router.post('/ops/synthetic-journey/run', admin, async (req, res, next) => {
    try {
      const retries = typeof req.body?.retries === 'number' ? Math.max(0, req.body.retries) : 0;
      const slaThresholdMs =
        typeof req.body?.slaThresholdMs === 'number' ? req.body.slaThresholdMs : undefined;
      const report = await syntheticMonitor.runJourneyWithRetry({
        maxRetries: retries,
        slaThresholdMs,
      });
      res.status(report.success ? 200 : 503).json({ success: report.success, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ops/synthetic-journey/history', admin, (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) || 20 : 20;
    res.json({ success: true, data: syntheticMonitor.getRecentRuns(limit), correlationId: req.correlationId });
  });

  // Snapshot restore verification for critical data and derived indexes (Issue #263)
  router.post('/ops/snapshot-restore/verify', admin, async (req, res, next) => {
    try {
      const snapshotPkg = req.body?.snapshotPackage || {
        invoices: options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [],
        metadata: { exportedAt: new Date().toISOString(), source: 'api' },
      };
      const report = verifySnapshotRestore(snapshotPkg);
      res.status(report.ok ? 200 : 422).json({ success: report.ok, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Resumable record repair jobs -----------------------------------------

  router.post('/ops/repair-records/jobs', admin, async (req, res, next) => {
    try {
      const { dryRun, batchSize, phases, maxBatches } = req.body ?? {};
      const report = await repairService.startRepairJob({
        dryRun: dryRun !== undefined ? Boolean(dryRun) : undefined,
        batchSize: typeof batchSize === 'number' ? batchSize : undefined,
        phases: Array.isArray(phases) ? (phases as RepairPhase[]) : undefined,
        maxBatches: typeof maxBatches === 'number' ? maxBatches : undefined,
      });

      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: report.jobId },
        reason: `Record repair job started (${report.status})`,
        metadata: {
          jobId: report.jobId,
          status: report.status,
          dryRun: report.dryRun,
          repaired: report.counts.repaired,
          scanned: report.counts.scanned,
          failed: report.counts.failed,
        },
        correlationId: req.correlationId,
      });

      res.status(201).json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/repair-records/jobs/:id/resume', admin, async (req, res, next) => {
    try {
      const { batchSize, maxBatches } = req.body ?? {};
      const report = await repairService.resumeRepairJob(req.params.id, {
        batchSize: typeof batchSize === 'number' ? batchSize : undefined,
        maxBatches: typeof maxBatches === 'number' ? maxBatches : undefined,
      });

      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: 'ops-admin' },
        scope: { entityType: 'system', entityId: report.jobId },
        reason: `Record repair job resumed (${report.status})`,
        metadata: {
          jobId: report.jobId,
          status: report.status,
          dryRun: report.dryRun,
          repaired: report.counts.repaired,
          scanned: report.counts.scanned,
          failed: report.counts.failed,
        },
        correlationId: req.correlationId,
      });

      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof RepairJobNotFoundError) {
        return fail(res, req, 404, 'REPAIR_JOB_NOT_FOUND', err.message);
      }
      next(err);
    }
  });

  router.get('/ops/repair-records/jobs/:id', admin, async (req, res, next) => {
    try {
      const report = await repairService.getJob(req.params.id);
      if (!report) {
        return fail(res, req, 404, 'REPAIR_JOB_NOT_FOUND', `Repair job ${req.params.id} not found`);
      }
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ops/repair-records/jobs', admin, async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? (req.query.status as any) : undefined;
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const jobs = await repairService.listJobs({ status, limit });
      res.json({ success: true, data: jobs, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Scoped maintainer impersonation (#76) --------------------------------

  router.get('/ops/impersonation', admin, (req, res) => {
    const maintainerId = String(req.query.maintainerId ?? '');
    const includeClosed = req.query.includeClosed !== 'false';
    res.json({
      success: true,
      data: {
        indicator: maintainerId
          ? impersonation.indicator(maintainerId)
          : { active: false },
        sessions: impersonation.listSessions(includeClosed),
        permissions: IMPERSONATION_PERMISSIONS,
      },
      correlationId: req.correlationId,
    });
  });

  router.post('/ops/impersonation', admin, (req, res) => {
    const target = stellarPublicKeySchema.safeParse(req.body?.targetId);
    if (!target.success) {
      return res.status(400).json(apiFailure('targetId must be a valid Stellar public key', {
        code: 'TARGET_INVALID',
        correlationId: req.correlationId,
      }));
    }

    const permissions = (req.body?.permissions ?? ['read']) as ImpersonationPermission[];

    try {
      const session = impersonation.startSession({
        maintainerId: String(req.body?.maintainerId ?? ''),
        targetId: target.data,
        permissions,
        reason: String(req.body?.reason ?? ''),
        durationMs: durationOf(req.body?.durationMs),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return res.status(201).json({
        success: true,
        data: { session, indicator: impersonation.indicator(session.maintainerId) },
        correlationId: req.correlationId,
      });
    } catch (err) {
      return res.status(400).json(apiFailure(err instanceof Error ? err.message : 'Impersonation session rejected', {
        code: 'IMPERSONATION_REJECTED',
        correlationId: req.correlationId,
      }));
    }
  });

  router.post('/ops/impersonation/end', admin, (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const closed = impersonation.endSession(
      sessionId,
      req.body?.maintainerId ? String(req.body.maintainerId) : undefined,
    );
    if (!closed) {
      return res.status(404).json(apiFailure('No active session with that id for this maintainer', {
        code: 'SESSION_NOT_FOUND',
        correlationId: req.correlationId,
      }));
    }
    return res.json({ success: true, data: { sessionId, closed: true }, correlationId: req.correlationId });
  });

  // -- Historical trend export for operational and financial metrics ---------

  const handleTrendExport = async (req: any, res: any, next: any) => {
    try {
      const sourceParams = req.method === 'GET' ? req.query : req.body ?? {};
      const actor = sourceParams.actor ?? {
        id: String(sourceParams.actorId ?? 'ops-admin'),
        role: String(sourceParams.role ?? 'maintainer'),
      };
      const dimensions =
        typeof sourceParams.dimensions === 'string'
          ? sourceParams.dimensions.split(',').map((d: string) => d.trim()).filter(Boolean)
          : Array.isArray(sourceParams.dimensions)
          ? sourceParams.dimensions
          : undefined;

      const artifact = await trendExport.exportTrends({
        actor,
        granularity: sourceParams.granularity as TrendWindowGranularity | undefined,
        format: sourceParams.format === 'csv' ? 'csv' : sourceParams.format === 'json' ? 'json' : undefined,
        from: sourceParams.from,
        to: sourceParams.to,
        dimensions,
        fillEmptyBuckets: Boolean(sourceParams.fillEmptyBuckets),
        maxBuckets: sourceParams.maxBuckets !== undefined ? Number(sourceParams.maxBuckets) : undefined,
        maxSourceRecords:
          sourceParams.maxSourceRecords !== undefined ? Number(sourceParams.maxSourceRecords) : undefined,
      });

      auditStore.recordEvent({
        action: 'MAINTAINER_ACTION',
        actor: { type: 'maintainer', id: actor.id },
        scope: { entityType: 'system', entityId: artifact.meta.exportId },
        reason: 'Historical trend export generated',
        metadata: {
          schema: artifact.meta.schema,
          schemaVersion: artifact.meta.schemaVersion,
          granularity: artifact.meta.granularity,
          bucketCount: artifact.meta.bucketCount,
          truncated: artifact.meta.truncated,
        },
        correlationId: req.correlationId,
      });

      if (artifact.meta.format === 'csv' && req.query?.raw === 'true') {
        res.setHeader('Content-Type', artifact.contentType);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="inqutum-trends-v${artifact.meta.schemaVersion}.csv"`
        );
        return res.status(200).send(artifact.body);
      }

      return res.status(200).json({
        success: true,
        data: {
          meta: artifact.meta,
          totals: artifact.totals,
          buckets: artifact.buckets,
          ...(artifact.meta.format === 'csv' ? { csv: artifact.body } : {}),
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      if (err instanceof TrendExportPermissionError || err instanceof TrendExportValidationError) {
        const explanation = explainRejection(err, { correlationId: req.correlationId });
        return res.status(err.httpStatus).json({
          success: false,
          code: err.code,
          error: err.message,
          explanation,
          correlationId: req.correlationId,
        });
      }
      next(err);
    }
  };

  router.post('/ops/trends/export', admin, handleTrendExport);
  router.get('/ops/trends/export', admin, handleTrendExport);

  // -- Resilient external reference verification -----------------------------

  router.post('/ops/external-references/verify', admin, async (req, res, next) => {
    try {
      const input: ExternalReferenceInput = {
        referenceId: String(req.body?.referenceId ?? ''),
        referenceType: req.body?.referenceType,
        invoiceId: String(req.body?.invoiceId ?? ''),
        externalIdentifier: String(req.body?.externalIdentifier ?? ''),
        sourceSystem: String(req.body?.sourceSystem ?? 'external-source'),
        endpoint: typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined,
        expectedAmount: typeof req.body?.expectedAmount === 'number' ? req.body.expectedAmount : undefined,
        expectedAssetCode:
          typeof req.body?.expectedAssetCode === 'string' ? req.body.expectedAssetCode : undefined,
      };

      const defaultProbe: ExternalReferenceProbe = async () => {
        if (req.body?.mockSourceResponse !== undefined) {
          return req.body.mockSourceResponse;
        }
        return {
          status: 'verified',
          observedTimestamp: new Date().toISOString(),
          ledgerSequence: 100_000,
          settledAmount: input.expectedAmount ?? 100,
          assetCode: input.expectedAssetCode ?? 'XLM',
        };
      };

      const probe = options.externalReferenceProbe ?? defaultProbe;
      const record =
        req.body?.singleAttempt === true
          ? await externalReferences.verifySingleAttempt(input, probe)
          : await externalReferences.verifyWithRetries(input, probe);

      const status = record.status === 'VERIFIED' ? 200 : record.status === 'RETRY_SCHEDULED' ? 202 : 422;
      return res.status(status).json({
        success: record.status === 'VERIFIED',
        data: record,
        correlationId: req.correlationId,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/ops/external-references/:id', admin, (req, res) => {
    const record = externalReferences.getRecord(req.params.id);
    if (!record) {
      return fail(res, req, 404, 'REFERENCE_NOT_FOUND', 'External reference verification record not found');
    }
    return res.json({ success: true, data: record, correlationId: req.correlationId });
  });

  // -- User-facing explanation resolver endpoint -----------------------------

  router.post('/ops/rejections/explain', (req, res) => {
    const explanation = explainRejection(req.body?.error ?? req.body ?? {}, {
      correlationId: req.correlationId,
    });
    res.status(200).json({
      success: true,
      data: explanation,
      correlationId: req.correlationId,
    });
  });

  // -- Cross-service event schema drift detection (#389) --------------------

  router.get('/ops/event-schemas/contracts', admin, (_req, res) => {
    res.json({ success: true, data: eventSchemaDrift.listContracts(), correlationId: _req.correlationId });
  });

  router.post('/ops/event-schemas/drift-check', admin, (req, res) => {
    try {
      const report = eventSchemaDrift.detectDrift(req.body);
      const status = report.breakingCount > 0 ? 409 : 200;
      return res.status(status).json({
        success: report.breakingCount === 0,
        data: report,
        correlationId: req.correlationId,
      });
    } catch (err) {
      if (err instanceof EventSchemaDriftError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.post('/ops/event-schemas/rollback', admin, (req, res) => {
    try {
      const { eventType, targetVersion, actorId } = req.body ?? {};
      const contract = eventSchemaDrift.rollbackContract(eventType, targetVersion, {
        actorId: typeof actorId === 'string' ? actorId : 'admin',
        role: 'ADMIN',
      });
      return res.json({ success: true, data: contract, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof EventSchemaDriftError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  // -- Ownership transfer with expiry and audit history (#390) --------------

  router.post('/ops/ownership-transfers', admin, (req, res) => {
    try {
      const record = ownershipTransfers.initiateTransfer(req.body);
      return res.status(201).json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof OwnershipTransferError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.post('/ops/ownership-transfers/:id/accept', admin, (req, res) => {
    try {
      const record = ownershipTransfers.acceptTransfer(req.params.id, req.body?.acceptorId);
      return res.json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof OwnershipTransferError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.post('/ops/ownership-transfers/:id/cancel', admin, (req, res) => {
    try {
      const record = ownershipTransfers.cancelTransfer(req.params.id, req.body?.actorId, req.body?.reason);
      return res.json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof OwnershipTransferError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.post('/ops/ownership-transfers/:id/reject', admin, (req, res) => {
    try {
      const record = ownershipTransfers.rejectTransfer(req.params.id, req.body?.actorId, req.body?.reason);
      return res.json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof OwnershipTransferError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.post('/ops/ownership-transfers/:id/retry', admin, (req, res) => {
    try {
      const record = ownershipTransfers.retryTransfer(req.params.id, req.body?.actorId, {
        ttlMs: req.body?.ttlMs,
        reason: req.body?.reason,
      });
      return res.status(201).json({ success: true, data: record, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof OwnershipTransferError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      throw err;
    }
  });

  router.get('/ops/ownership-transfers/:resourceId/history', admin, (req, res) => {
    const resourceId = req.params.resourceId;
    return res.json({
      success: true,
      data: {
        transfers: ownershipTransfers.listTransfers(resourceId),
        auditHistory: ownershipTransfers.getAuditHistory({ resourceId }),
      },
      correlationId: req.correlationId,
    });
  });

  // -- Executable incident recovery checks (#392) ---------------------------

  router.post('/ops/incident-recovery/verify', admin, async (req, res, next) => {
    try {
      const report = await recoveryRunner.runChecks({
        actorId: typeof req.body?.actorId === 'string' ? req.body.actorId : 'admin',
        actorRole: 'ADMIN',
        checkIds: Array.isArray(req.body?.checkIds) ? req.body.checkIds : undefined,
        maxRetries: typeof req.body?.maxRetries === 'number' ? req.body.maxRetries : undefined,
      });
      return res.status(report.ok ? 200 : 503).json({
        success: report.ok,
        data: report,
        correlationId: req.correlationId,
      });
    } catch (err) {
      if (err instanceof UnauthorizedRecoveryCheckError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      next(err);
    }
  });

  // -- Paginated affected-record preview for policy simulations (#432) ------
  //
  // Runs the full maintainer simulation against live records, a named
  // fixture, or a caller-supplied selection, and returns ONE bounded page of
  // affected records plus the full risk/workflow/seller summary. The opaque
  // `nextCursor` is HMAC-signed against (proposal digest, dataset digest) so
  // it cannot page a different proposal or survive an in-flight data change.

  router.post('/ops/policy/simulate/preview', admin, async (req, res, next) => {
    try {
      const parsed = parsePolicySimulationPreviewRequest(req.body, loadPolicy());
      const invoices =
        parsed.fixtureName || !options.storage.getAllInvoices
          ? []
          : await options.storage.getAllInvoices();
      const workflows = options.jobs ? (await options.jobs.list({ limit: 1000 })).jobs : [];
      const page = runPolicySimulationPreview(
        {
          ...parsed,
          invoices,
          workflows,
        },
        policyPreviewCursorSecret,
      );
      return res.json({ success: true, data: page, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof PolicyPreviewError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      if (err instanceof PolicySimulationPermissionError || err instanceof PolicySimulationValidationError) {
        const explanation = explainRejection(err, { correlationId: req.correlationId });
        return res.status(err.httpStatus).json({
          success: false,
          code: err.code,
          error: err.message,
          explanation,
          correlationId: req.correlationId,
        });
      }
      next(err);
    }
  });

  // -- Security-event session invalidation (#433) ---------------------------
  //
  // Terminates every active impersonation session and revokes every live
  // capability token for a subject in one atomic call, writing a single
  // audit event with the full invalidation manifest. The route is admin-only
  // and fails closed (403) when the invalidator is not configured.

  router.post('/ops/security/invalidate-sessions', admin, (req, res, next) => {
    if (!securityInvalidator) {
      return fail(res, req, 403, 'SECURITY_INVALIDATION_DISABLED', 'Security-event session invalidation is not configured');
    }
    try {
      const body = req.body ?? {};
      const input: SecurityEventInvalidationInput = {
        subjectId: String(body.subjectId ?? ''),
        kind: body.kind,
        reason: String(body.reason ?? ''),
        triggeredBy: String(body.triggeredBy ?? 'ops-admin'),
        correlationId: req.correlationId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      };
      const result = securityInvalidator.invalidate(input);
      return res.status(200).json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof SecurityEventInvalidationError) {
        return fail(res, req, err.httpStatus, err.code, err.message);
      }
      next(err);
    }
  });

  router.get('/ops/security/invalidate-sessions/status', admin, (req, res, next) => {
    if (!securityInvalidator) {
      return fail(res, req, 403, 'SECURITY_INVALIDATION_DISABLED', 'Security-event session invalidation is not configured');
    }
    try {
      const subjectId = String(req.query?.subjectId ?? '');
      if (!subjectId) {
        return fail(res, req, 400, 'INVALID_STATUS_REQUEST', 'subjectId query parameter is required');
      }
      return res.json({ success: true, data: securityInvalidator.status(subjectId), correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createOpsRouter;
