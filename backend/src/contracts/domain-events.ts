/**
 * Cross-service contract map for domain events and integration boundaries (#252).
 *
 * Three channels carry domain events between components today:
 *  - audit:        hash-chained audit trail (audit-service). Producers record,
 *                  consumers replay or query it.
 *  - notification: in-app notification feed (notification-service), filtered
 *                  by the preference router.
 *  - job:          durable background jobs (jobs/worker). Producers enqueue a
 *                  type, the worker handler consumes it.
 *
 * Every entry names its producers and consumers by file and by a literal
 * `marker` that must appear in that file. tests/domain-event-contracts.test.ts
 * reads the source and fails when a marker disappears, when a declared type in
 * code has no contract, or when required fields change without a version bump.
 * Real payloads are validated against `requiredFields` in the same suite.
 *
 * Version rules (enforced by `compareContracts`):
 *  - Adding an optional field, a consumer, or a producer: same version.
 *  - Adding a required field, removing or renaming any field, or changing a
 *    field type: breaking. Bump `version`; producers dual-publish (or keep the
 *    old field) until every consumer accepts the new version; consumers accept
 *    N and N-1 during the window.
 *  - Removing an event: mark it `deprecated` for one release first.
 *
 * See docs/CONTRACT_MAP.md for the human-readable map and failure runbook.
 */

export type EventChannel = 'audit' | 'notification' | 'job';

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'iso-datetime' | 'invoice-status';

export interface ContractField {
  /** Dotted path into the payload, e.g. `afterState.id`. */
  path: string;
  type: FieldType;
}

/**
 * What a component does when its side of the boundary fails.
 *  - log_and_continue: the failure is logged; the user-facing operation still succeeds.
 *  - retry_then_dead_letter: job retry policy with backoff, then the dead-letter set.
 *  - dedupe_idempotent: duplicate deliveries are no-ops keyed by a dedup key.
 *  - skip_and_count: the consumer skips an unusable event and reports how many.
 *  - refuse_and_report: the consumer refuses to act (no partial apply) and reports why.
 *  - degrade_to_state: the consumer falls back to comparing state without the event.
 *  - pass_through: the consumer returns the event as stored; it never interprets it.
 */
export type FailureBehavior =
  | 'log_and_continue'
  | 'retry_then_dead_letter'
  | 'dedupe_idempotent'
  | 'skip_and_count'
  | 'refuse_and_report'
  | 'degrade_to_state'
  | 'pass_through';

export interface Endpoint {
  component: string;
  file: string;
  /** Literal text that proves this file produces/consumes the event. */
  marker: string;
  onFailure: FailureBehavior;
  note?: string;
}

export type ContractStatus =
  /** Has at least one producer and one consumer. */
  | 'active'
  /** Declared in code and consumed, but nothing produces it. Consumers must tolerate absence. */
  | 'no_producer'
  /** Produced, but only generic query consumers read it. */
  | 'audit_only';

export interface DomainEventContract {
  name: string;
  channel: EventChannel;
  version: number;
  status: ContractStatus;
  description: string;
  requiredFields: ContractField[];
  optionalFields: ContractField[];
  producers: Endpoint[];
  consumers: Endpoint[];
}

const AUDIT_ENVELOPE: ContractField[] = [
  { path: 'id', type: 'string' },
  { path: 'timestamp', type: 'iso-datetime' },
  { path: 'action', type: 'string' },
  { path: 'actor.type', type: 'string' },
  { path: 'actor.id', type: 'string' },
  { path: 'scope.entityType', type: 'string' },
  { path: 'scope.entityId', type: 'string' },
  { path: 'hash', type: 'string' },
];

/** The post-transition invoice snapshot projection-replay rebuilds the search index from. */
const INVOICE_SNAPSHOT: ContractField[] = [
  { path: 'afterState.id', type: 'string' },
  { path: 'afterState.sellerPublicKey', type: 'string' },
  { path: 'afterState.amount', type: 'number' },
  { path: 'afterState.assetCode', type: 'string' },
  { path: 'afterState.memo', type: 'string' },
  { path: 'afterState.status', type: 'invoice-status' },
];

const NOTIFICATION_ENVELOPE: ContractField[] = [
  { path: 'id', type: 'string' },
  { path: 'recipient', type: 'string' },
  { path: 'type', type: 'string' },
  { path: 'severity', type: 'string' },
  { path: 'title', type: 'string' },
  { path: 'message', type: 'string' },
  { path: 'dedupKey', type: 'string' },
  { path: 'entityId', type: 'string' },
  { path: 'createdAt', type: 'iso-datetime' },
];

const JOB_ENVELOPE: ContractField[] = [
  { path: 'id', type: 'string' },
  { path: 'type', type: 'string' },
  { path: 'payload.version', type: 'number' },
  { path: 'payload.data', type: 'object' },
];

const HANDLERS = 'src/routes/invoice.handlers.ts';
const AUDIT_STORE = 'src/audit/audit-service.ts';
const REPLAY = 'src/ops/projection-replay.ts';
const RECONCILE = 'src/ops/reconciliation.ts';
const AUDIT_ROUTES = 'src/routes/audit.routes.ts';

const handlerAudit = (marker: string): Endpoint => ({
  component: 'invoice handlers',
  file: HANDLERS,
  marker,
  onFailure: 'log_and_continue',
  note: 'Audit write failures are logged and the request still succeeds, so audit-derived projections can miss the event; reconciliation (#255) catches the drift.',
});

const replayConsumer: Endpoint = {
  component: 'search-index event replay',
  file: REPLAY,
  marker: 'SEARCH_INDEX_V1',
  onFailure: 'refuse_and_report',
  note: 'Events whose afterState is not a full invoice snapshot are counted as rejected and the rebuilt index is not swapped in.',
};

const auditQuery: Endpoint = {
  component: 'audit query API',
  file: AUDIT_ROUTES,
  marker: 'getAuditEvents',
  onFailure: 'pass_through',
};

const feedConsumer = (type: string): Endpoint => ({
  component: 'notification preference router',
  file: 'src/notifications/notification-preference.ts',
  marker: `'${type}'`,
  onFailure: 'skip_and_count',
  note: 'Routing decides deliver/suppress; every decision is recorded in the routing audit even when suppressed.',
});

const notificationProducer = (method: string, note?: string): Endpoint => ({
  component: 'notification service',
  file: 'src/notifications/notification-service.ts',
  marker: method,
  onFailure: 'dedupe_idempotent',
  note: note ?? 'Emission is keyed by dedupKey; repeated syncs never create a second notification. Callers wrap it so a failure never fails the request.',
});

export const DOMAIN_EVENT_CONTRACTS: readonly DomainEventContract[] = [
  // -- audit channel ---------------------------------------------------------
  {
    name: 'INVOICE_CREATED',
    channel: 'audit',
    version: 1,
    status: 'active',
    description: 'A seller created an invoice.',
    requiredFields: [...AUDIT_ENVELOPE, ...INVOICE_SNAPSHOT],
    optionalFields: [{ path: 'metadata.amount', type: 'number' }, { path: 'correlationId', type: 'string' }],
    producers: [handlerAudit("action: 'INVOICE_CREATED'")],
    consumers: [
      replayConsumer,
      {
        component: 'projection reconciliation',
        file: RECONCILE,
        marker: "'INVOICE_CREATED'",
        onFailure: 'degrade_to_state',
        note: 'Absence of the event is itself the root-cause signal (CREATED_OUTSIDE_API). A failed audit lookup falls back to state comparison.',
      },
      auditQuery,
    ],
  },
  {
    name: 'INVOICE_CANCELLED',
    channel: 'audit',
    version: 1,
    status: 'active',
    description: 'A seller cancelled a PENDING invoice.',
    requiredFields: [...AUDIT_ENVELOPE, ...INVOICE_SNAPSHOT],
    optionalFields: [{ path: 'beforeState.status', type: 'invoice-status' }],
    producers: [handlerAudit("action: 'INVOICE_CANCELLED'")],
    consumers: [replayConsumer, auditQuery],
  },
  {
    name: 'PAYMENT_VERIFIED',
    channel: 'audit',
    version: 1,
    status: 'active',
    description: 'A payment was verified on Horizon and the invoice settled.',
    requiredFields: [
      ...AUDIT_ENVELOPE,
      ...INVOICE_SNAPSHOT,
      { path: 'metadata.txHash', type: 'string' },
      { path: 'metadata.payerPublicKey', type: 'string' },
    ],
    optionalFields: [{ path: 'beforeState.status', type: 'invoice-status' }],
    producers: [handlerAudit("action: 'PAYMENT_VERIFIED'")],
    consumers: [
      replayConsumer,
      {
        component: 'projection reconciliation',
        file: RECONCILE,
        marker: "'PAYMENT_VERIFIED'",
        onFailure: 'degrade_to_state',
        note: 'A PAID invoice with no PAYMENT_VERIFIED event is flagged for Horizon confirmation.',
      },
      auditQuery,
    ],
  },
  {
    name: 'PAYMENT_SIMULATED',
    channel: 'audit',
    version: 1,
    status: 'active',
    description: 'A dev-only simulated payment settled an invoice. Never produced in production.',
    requiredFields: [...AUDIT_ENVELOPE, ...INVOICE_SNAPSHOT],
    optionalFields: [{ path: 'metadata.mockTxHash', type: 'string' }],
    producers: [handlerAudit("action: 'PAYMENT_SIMULATED'")],
    consumers: [replayConsumer, auditQuery],
  },
  {
    name: 'INVOICE_EXPIRED',
    channel: 'audit',
    version: 1,
    status: 'no_producer',
    description:
      'Declared and consumed, never produced: expiry is a lazy storage transition, not an event. Replay derives expiries from storage instead, and reconciliation reports EXPIRY_NOT_PROJECTED.',
    requiredFields: [...AUDIT_ENVELOPE, ...INVOICE_SNAPSHOT],
    optionalFields: [],
    producers: [],
    consumers: [replayConsumer],
  },
  {
    name: 'PROOF_EXPORTED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A seller generated a data export.',
    requiredFields: [
      ...AUDIT_ENVELOPE,
      { path: 'metadata.schemaVersion', type: 'string' },
      { path: 'metadata.recordCount', type: 'number' },
      { path: 'metadata.format', type: 'string' },
    ],
    optionalFields: [],
    producers: [{ component: 'export routes', file: 'src/routes/export.routes.ts', marker: "action: 'PROOF_EXPORTED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'CONFIG_CHANGED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'Runtime configuration changed: feature-flag override, rollout, or public status.',
    requiredFields: [
      ...AUDIT_ENVELOPE,
      { path: 'reason', type: 'string' },
      { path: 'metadata.configKey', type: 'string' },
      { path: 'metadata.change', type: 'string' },
    ],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [
      { component: 'admin config', file: 'src/config/admin-config.ts', marker: "action: 'CONFIG_CHANGED'", onFailure: 'refuse_and_report', note: 'Evidence first: no audit event, no change (503).' },
      { component: 'rollout guard', file: 'src/config/rollout-guard.ts', marker: "action: 'CONFIG_CHANGED'", onFailure: 'refuse_and_report', note: 'Evidence first for start, rollback and complete.' },
      { component: 'public status', file: 'src/ops/public-status.ts', marker: "action: 'CONFIG_CHANGED'", onFailure: 'refuse_and_report', note: 'Evidence first for declare and clear.' },
    ],
    consumers: [auditQuery],
  },
  {
    name: 'MAINTAINER_ACTION',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A maintainer ran an operational action (requeue, override, replay, reconciliation, approval receipt).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'reason', type: 'string' }],
    optionalFields: [{ path: 'metadata', type: 'object' }],
    producers: [
      { component: 'ops routes', file: 'src/routes/ops.routes.ts', marker: "action: 'MAINTAINER_ACTION'", onFailure: 'log_and_continue' },
      { component: 'jobs routes', file: 'src/routes/jobs.routes.ts', marker: "action: 'MAINTAINER_ACTION'", onFailure: 'log_and_continue' },
    ],
    consumers: [auditQuery],
  },

  {
    name: 'AUTHORIZATION_GRANTED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A delegation, approval or API-access grant was issued (#199).',
    requiredFields: [...AUDIT_ENVELOPE],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_GRANTED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_REVOKED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A grant was revoked by its grantor or an OWNER/ADMIN; pending renewals are cancelled (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.reason', type: 'string' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_REVOKED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_CLEANED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'An expired grant past its grace period was tombstoned by the cleanup job (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.expiredForMs', type: 'number' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_CLEANED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_RENEWAL_REQUESTED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'Renewal of a grant was requested; awaits a second OWNER/ADMIN (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.renewalRequestId', type: 'string' }, { path: 'metadata.reason', type: 'string' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_RENEWAL_REQUESTED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_RENEWAL_REJECTED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A pending renewal request was rejected (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.renewalRequestId', type: 'string' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_RENEWAL_REJECTED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_RENEWED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A renewal was confirmed: old grant superseded, new grant issued (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.renewalRequestId', type: 'string' }, { path: 'metadata.newGrantId', type: 'string' }, { path: 'metadata.requestedBy', type: 'string' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_RENEWED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },
  {
    name: 'AUTHORIZATION_DENIED',
    channel: 'audit',
    version: 1,
    status: 'audit_only',
    description: 'A protected action was refused because the matching grant is expired, revoked, cleaned or superseded (#199).',
    requiredFields: [...AUDIT_ENVELOPE, { path: 'metadata.action', type: 'string' }, { path: 'metadata.reason', type: 'string' }],
    optionalFields: [{ path: 'beforeState', type: 'object' }, { path: 'afterState', type: 'object' }],
    producers: [{ component: 'authorization lifecycle', file: 'src/domain/authorization-lifecycle.ts', marker: "this.audit('AUTHORIZATION_DENIED'", onFailure: 'log_and_continue' }],
    consumers: [auditQuery],
  },

  // -- notification channel --------------------------------------------------
  {
    name: 'invoice.paid',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Seller is told an invoice was paid. Mandatory: cannot be muted.',
    requiredFields: [...NOTIFICATION_ENVELOPE, { path: 'data.invoiceId', type: 'string' }],
    optionalFields: [],
    producers: [notificationProducer("type: 'invoice.paid'")],
    consumers: [feedConsumer('invoice.paid')],
  },
  {
    name: 'invoice.expired',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Seller is told an invoice expired unpaid.',
    requiredFields: [...NOTIFICATION_ENVELOPE, { path: 'data.invoiceId', type: 'string' }],
    optionalFields: [],
    producers: [notificationProducer("type: 'invoice.expired'")],
    consumers: [feedConsumer('invoice.expired')],
  },
  {
    name: 'invoice.cancelled',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Seller is told an invoice was cancelled.',
    requiredFields: [...NOTIFICATION_ENVELOPE, { path: 'data.invoiceId', type: 'string' }],
    optionalFields: [],
    producers: [notificationProducer("type: 'invoice.cancelled'")],
    consumers: [feedConsumer('invoice.cancelled')],
  },
  {
    name: 'payment.rejected',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Seller is told a payment attempt was rejected for a recoverable reason.',
    requiredFields: [...NOTIFICATION_ENVELOPE],
    optionalFields: [],
    producers: [notificationProducer("type: 'payment.rejected'", 'Called from the verify handler for recoverable rejection codes only.')],
    consumers: [feedConsumer('payment.rejected')],
  },
  {
    name: 'invoice.reminder',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Reminder for an invoice approaching expiry. Producer method exists; no scheduler calls it yet.',
    requiredFields: [...NOTIFICATION_ENVELOPE],
    optionalFields: [],
    producers: [notificationProducer("type: 'invoice.reminder'", 'notifyInvoiceReminder has no caller in src yet.')],
    consumers: [feedConsumer('invoice.reminder')],
  },
  {
    name: 'security.alert',
    channel: 'notification',
    version: 1,
    status: 'active',
    description: 'Security-relevant account event. Mandatory. Producer method exists; no caller yet.',
    requiredFields: [...NOTIFICATION_ENVELOPE],
    optionalFields: [],
    producers: [notificationProducer("type: 'security.alert'", 'notifySecurityAlert has no caller in src yet.')],
    consumers: [feedConsumer('security.alert')],
  },
  {
    name: 'marketing.digest',
    channel: 'notification',
    version: 1,
    status: 'no_producer',
    description: 'Optional digest type known to the router; nothing emits it.',
    requiredFields: [...NOTIFICATION_ENVELOPE],
    optionalFields: [],
    producers: [],
    consumers: [feedConsumer('marketing.digest')],
  },

  // -- job channel -----------------------------------------------------------
  {
    name: 'invoices.expire-pending',
    channel: 'job',
    version: 1,
    status: 'active',
    description: 'Expiry sweep, one per interval bucket. Held while public status is paused or in maintenance.',
    requiredFields: JOB_ENVELOPE,
    optionalFields: [],
    producers: [{ component: 'expiry scheduler', file: 'src/jobs/runtime.ts', marker: 'queue.enqueue(EXPIRE_PENDING_INVOICES_JOB', onFailure: 'log_and_continue', note: 'Idempotency key per bucket; duplicate enqueues collapse.' }],
    consumers: [{ component: 'job worker', file: 'src/jobs/runtime.ts', marker: 'worker.register(EXPIRE_PENDING_INVOICES_JOB', onFailure: 'retry_then_dead_letter' }],
  },
  {
    name: 'records.resumable-repair',
    channel: 'job',
    version: 1,
    status: 'no_producer',
    description: 'Resumable repair of orphaned or inconsistent records. Handler is registered, but /ops/repair-records runs the service inline and nothing enqueues this type yet.',
    requiredFields: JOB_ENVELOPE,
    optionalFields: [{ path: 'payload.data.jobId', type: 'string' }, { path: 'payload.data.dryRun', type: 'boolean' }],
    producers: [],
    consumers: [{ component: 'job worker', file: 'src/jobs/runtime.ts', marker: 'worker.register(RESUMABLE_REPAIR_JOB', onFailure: 'retry_then_dead_letter' }],
  },
  {
    name: 'retention.sweep',
    channel: 'job',
    version: 1,
    status: 'no_producer',
    description: 'Data-retention sweep. Handler is registered by registerRetentionJob; no scheduler enqueues it yet.',
    requiredFields: JOB_ENVELOPE,
    optionalFields: [],
    producers: [],
    consumers: [{ component: 'job worker', file: 'src/db/retention-sweep.ts', marker: 'worker.register(RETENTION_SWEEP_JOB', onFailure: 'retry_then_dead_letter' }],
  },
  {
    name: 'projections.reconcile',
    channel: 'job',
    version: 1,
    status: 'active',
    description: 'Detect-only projection reconciliation (#255). Embedded worker only; never repairs.',
    requiredFields: JOB_ENVELOPE,
    optionalFields: [],
    producers: [{ component: 'reconciliation scheduler', file: 'src/jobs/runtime.ts', marker: 'queue.enqueue(RECONCILE_PROJECTIONS_JOB', onFailure: 'log_and_continue', note: 'Opt-in via RECONCILIATION_INTERVAL_MS.' }],
    consumers: [{ component: 'job worker', file: 'src/jobs/runtime.ts', marker: 'worker.register(RECONCILE_PROJECTIONS_JOB', onFailure: 'retry_then_dead_letter' }],
  },
  {
    name: 'authorizations.cleanup-stale',
    channel: 'job',
    version: 1,
    status: 'no_producer',
    description: 'Stale authorization cleanup (#199). Handler is registered when cleanupStaleAuthorizations is wired; no scheduler enqueues it yet.',
    requiredFields: JOB_ENVELOPE,
    optionalFields: [{ path: 'payload.data.dryRun', type: 'boolean' }, { path: 'payload.data.graceMs', type: 'number' }],
    producers: [],
    consumers: [{ component: 'job worker', file: 'src/jobs/runtime.ts', marker: 'worker.register(AUTHORIZATION_CLEANUP_JOB', onFailure: 'retry_then_dead_letter' }],
  },
];

/**
 * Known producer-side gaps: event names written in code with no declared type.
 * Listed so the test can tell a known gap from a new one.
 */
export const KNOWN_UNDECLARED_EVENTS: ReadonlyArray<{ name: string; file: string; note: string }> = [
  {
    name: 'EMAIL_SENT',
    file: HANDLERS,
    note: "Recorded with `as any`; not an AuditAction. Generic audit consumers see it; typed consumers never match it. Declare it in AuditAction before anything depends on it.",
  },
];

export function contractFor(name: string, channel?: EventChannel): DomainEventContract | undefined {
  return DOMAIN_EVENT_CONTRACTS.find((c) => c.name === name && (!channel || c.channel === channel));
}

const STATUSES = new Set(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']);

function readPath(payload: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), payload);
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'iso-datetime':
      return (typeof value === 'string' && !Number.isNaN(Date.parse(value))) || (value instanceof Date && !Number.isNaN(value.getTime()));
    case 'invoice-status':
      return typeof value === 'string' && STATUSES.has(value);
    case 'object':
      return typeof value === 'object' && value !== null;
    default:
      return typeof value === type;
  }
}

/** Validates a real payload against its contract. Returns the violations; empty means valid. */
export function validateEventPayload(contract: DomainEventContract, payload: unknown): string[] {
  const problems: string[] = [];
  for (const field of contract.requiredFields) {
    const value = readPath(payload, field.path);
    if (value === undefined || value === null) problems.push(`${contract.name}: missing required ${field.path}`);
    else if (!matchesType(value, field.type)) problems.push(`${contract.name}: ${field.path} is not ${field.type}`);
  }
  for (const field of contract.optionalFields) {
    const value = readPath(payload, field.path);
    if (value !== undefined && value !== null && !matchesType(value, field.type)) {
      problems.push(`${contract.name}: optional ${field.path} is not ${field.type}`);
    }
  }
  return problems;
}

export interface ContractComparison {
  breaking: string[];
  additive: string[];
  versionOk: boolean;
}

/** Applies the version rules to two revisions of one contract. */
export function compareContracts(previous: DomainEventContract, next: DomainEventContract): ContractComparison {
  const key = (f: ContractField) => `${f.path}:${f.type}`;
  const prevRequired = new Map(previous.requiredFields.map((f) => [f.path, f]));
  const nextRequired = new Map(next.requiredFields.map((f) => [f.path, f]));
  const prevAll = new Map([...previous.optionalFields, ...previous.requiredFields].map((f) => [f.path, f]));
  const nextAll = new Map([...next.optionalFields, ...next.requiredFields].map((f) => [f.path, f]));
  const breaking: string[] = [];
  const additive: string[] = [];

  for (const [path, field] of prevAll) {
    const after = nextAll.get(path);
    if (!after) breaking.push(`removed ${path}`);
    else if (key(after) !== key(field)) breaking.push(`changed type of ${path} from ${field.type} to ${after.type}`);
  }
  for (const [path] of nextRequired) {
    if (!prevRequired.has(path)) breaking.push(`added required ${path}`);
  }
  for (const [path] of nextAll) {
    if (!prevAll.has(path) && !nextRequired.has(path)) additive.push(`added optional ${path}`);
  }

  const versionOk = breaking.length === 0 ? next.version >= previous.version : next.version > previous.version;
  return { breaking, additive, versionOk };
}
