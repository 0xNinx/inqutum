/**
 * Cross-Service Event Schema Drift Detection (#389).
 *
 * Validates observed cross-service event payloads against canonical versioned
 * schema contracts, classifying breaking vs. non-breaking drift, supporting
 * bounded retries for remote schema probes, role-gated contract mutations,
 * and version rollback to a previous known-good contract.
 */

export type EventFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface EventFieldSpec {
  type: EventFieldType;
  required: boolean;
  nullable?: boolean;
  enumValues?: readonly string[];
}

export interface EventSchemaContract {
  eventType: string;
  version: string;
  producerService: string;
  consumerServices: readonly string[];
  fields: Record<string, EventFieldSpec>;
}

export interface ObservedEventSample {
  eventType: string;
  version?: string;
  sourceService: string;
  payload: Record<string, unknown>;
}

export type DriftSeverity = 'NONE' | 'NON_BREAKING' | 'BREAKING';

export type DriftKind =
  | 'MISSING_REQUIRED_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_ENUM_VALUE'
  | 'VERSION_MISMATCH'
  | 'UNKNOWN_OPTIONAL_FIELD'
  | 'UNKNOWN_CONTRACT';

export interface EventSchemaDriftItem {
  kind: DriftKind;
  severity: Exclude<DriftSeverity, 'NONE'>;
  field?: string;
  expected: string;
  actual: string;
  message: string;
}

export interface DriftDetectionReport {
  eventType: string;
  contractVersion: string | null;
  sourceService: string;
  checkedAt: string;
  hasDrift: boolean;
  severity: DriftSeverity;
  breakingCount: number;
  nonBreakingCount: number;
  drifts: EventSchemaDriftItem[];
  rollbackRecommended: boolean;
  remediationSteps: string[];
  attempts?: number;
}

export interface SchemaActorContext {
  actorId: string;
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'ANONYMOUS';
}

export interface DriftProbeRetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
}

export class EventSchemaDriftError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'EventSchemaDriftError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class UnauthorizedSchemaOperationError extends EventSchemaDriftError {
  constructor(actorId?: string, role?: string) {
    super(
      'UNAUTHORIZED_SCHEMA_OPERATION',
      `Actor '${actorId || 'anonymous'}' with role '${role || 'none'}' is not authorized to mutate event schema contracts. Requires ADMIN or OWNER.`,
      403
    );
    this.name = 'UnauthorizedSchemaOperationError';
  }
}

export class UnknownContractRollbackError extends EventSchemaDriftError {
  constructor(eventType: string, targetVersion: string) {
    super(
      'CONTRACT_VERSION_NOT_FOUND',
      `No historical contract version '${targetVersion}' found for event '${eventType}'.`,
      404
    );
    this.name = 'UnknownContractRollbackError';
  }
}

export const DEFAULT_EVENT_CONTRACTS: readonly EventSchemaContract[] = [
  {
    eventType: 'invoice.created',
    version: '1.0',
    producerService: 'invoice-service',
    consumerServices: ['notification-service', 'audit-service', 'export-service'],
    fields: {
      invoiceId: { type: 'string', required: true },
      sellerPublicKey: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      assetCode: { type: 'string', required: true },
      status: { type: 'string', required: true, enumValues: ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'] },
      memo: { type: 'string', required: false, nullable: true },
    },
  },
  {
    eventType: 'invoice.paid',
    version: '1.0',
    producerService: 'settlement-engine',
    consumerServices: ['notification-service', 'webhook-dispatcher', 'audit-service'],
    fields: {
      invoiceId: { type: 'string', required: true },
      txHash: { type: 'string', required: true },
      payerPublicKey: { type: 'string', required: true },
      paidAt: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      assetCode: { type: 'string', required: true },
    },
  },
  {
    eventType: 'ownership.transferred',
    version: '1.0',
    producerService: 'ownership-transfer-service',
    consumerServices: ['audit-service', 'notification-service'],
    fields: {
      transferId: { type: 'string', required: true },
      resourceType: { type: 'string', required: true, enumValues: ['SELLER_ACCOUNT', 'ORGANIZATION'] },
      resourceId: { type: 'string', required: true },
      previousOwnerId: { type: 'string', required: true },
      newOwnerId: { type: 'string', required: true },
      acceptedAt: { type: 'string', required: true },
    },
  },
];

function inferFieldType(value: unknown): EventFieldType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

function assertMutatorAuthorized(actor?: SchemaActorContext): void {
  if (!actor || (actor.role !== 'OWNER' && actor.role !== 'ADMIN')) {
    throw new UnauthorizedSchemaOperationError(actor?.actorId, actor?.role);
  }
}

function buildRemediation(drifts: EventSchemaDriftItem[], eventType: string): string[] {
  if (drifts.length === 0) return [];
  const steps = new Set<string>();
  for (const d of drifts) {
    if (d.kind === 'UNKNOWN_CONTRACT') {
      steps.add(`Register a canonical EventSchemaContract for '${eventType}' before deploying consumers.`);
    } else if (d.kind === 'MISSING_REQUIRED_FIELD' || d.kind === 'TYPE_MISMATCH' || d.kind === 'INVALID_ENUM_VALUE') {
      steps.add(`Rollback producer or pin contract for '${eventType}' until field '${d.field}' aligns.`);
    } else if (d.kind === 'VERSION_MISMATCH') {
      steps.add(`Coordinate producer/consumer version upgrade or enable compatibility transform for '${eventType}'.`);
    } else if (d.kind === 'UNKNOWN_OPTIONAL_FIELD') {
      steps.add(`Update contract for '${eventType}' to document additive field '${d.field}' in next minor version.`);
    }
  }
  return [...steps];
}

/**
 * Detects schema drift between observed cross-service event payloads and
 * registered contracts, with version history and rollback support.
 */
export class EventSchemaDriftDetector {
  private readonly contracts = new Map<string, EventSchemaContract>();
  private readonly history = new Map<string, EventSchemaContract[]>();

  constructor(initialContracts: readonly EventSchemaContract[] = DEFAULT_EVENT_CONTRACTS) {
    for (const contract of initialContracts) {
      this.contracts.set(contract.eventType, contract);
      this.history.set(contract.eventType, [contract]);
    }
  }

  /** Lists all active registered event schema contracts. */
  listContracts(): EventSchemaContract[] {
    return Array.from(this.contracts.values());
  }

  /** Retrieves the active contract for an event type, if registered. */
  getContract(eventType: string): EventSchemaContract | undefined {
    return this.contracts.get(eventType);
  }

  /**
   * Registers or updates an event schema contract. Restricted to ADMIN or OWNER.
   */
  registerContract(contract: EventSchemaContract, actor?: SchemaActorContext): EventSchemaContract {
    assertMutatorAuthorized(actor);
    if (!contract.eventType || !contract.version || !contract.producerService) {
      throw new EventSchemaDriftError(
        'INVALID_CONTRACT',
        'Contract must specify eventType, version, and producerService.',
        400
      );
    }

    const existingHistory = this.history.get(contract.eventType) ?? [];
    const filtered = existingHistory.filter((c) => c.version !== contract.version);
    filtered.push(contract);
    this.history.set(contract.eventType, filtered);
    this.contracts.set(contract.eventType, contract);
    return contract;
  }

  /**
   * Rolls back an event's active contract to a previously registered version.
   * Restricted to ADMIN or OWNER.
   */
  rollbackContract(
    eventType: string,
    targetVersion: string,
    actor?: SchemaActorContext
  ): EventSchemaContract {
    assertMutatorAuthorized(actor);
    const versions = this.history.get(eventType) ?? [];
    const target = versions.find((c) => c.version === targetVersion);
    if (!target) {
      throw new UnknownContractRollbackError(eventType, targetVersion);
    }
    this.contracts.set(eventType, target);
    return target;
  }

  /**
   * Compares an observed event sample against the registered contract and
   * classifies breaking vs. non-breaking drift.
   */
  detectDrift(sample: ObservedEventSample): DriftDetectionReport {
    if (!sample || typeof sample.payload !== 'object' || sample.payload === null || Array.isArray(sample.payload)) {
      throw new EventSchemaDriftError('INVALID_EVENT_SAMPLE', 'Observed event sample must contain an object payload.', 400);
    }

    const checkedAt = new Date().toISOString();
    const contract = this.contracts.get(sample.eventType);

    if (!contract) {
      const drifts: EventSchemaDriftItem[] = [
        {
          kind: 'UNKNOWN_CONTRACT',
          severity: 'BREAKING',
          expected: 'registered contract',
          actual: sample.eventType,
          message: `No schema contract registered for event '${sample.eventType}'.`,
        },
      ];
      return {
        eventType: sample.eventType,
        contractVersion: null,
        sourceService: sample.sourceService,
        checkedAt,
        hasDrift: true,
        severity: 'BREAKING',
        breakingCount: 1,
        nonBreakingCount: 0,
        drifts,
        rollbackRecommended: true,
        remediationSteps: buildRemediation(drifts, sample.eventType),
      };
    }

    const drifts: EventSchemaDriftItem[] = [];

    if (sample.version && sample.version !== contract.version) {
      drifts.push({
        kind: 'VERSION_MISMATCH',
        severity: 'BREAKING',
        expected: contract.version,
        actual: sample.version,
        message: `Observed version '${sample.version}' does not match contract version '${contract.version}'.`,
      });
    }

    for (const [field, spec] of Object.entries(contract.fields)) {
      const hasOwn = Object.prototype.hasOwnProperty.call(sample.payload, field);
      const value = sample.payload[field];

      if (!hasOwn || value === undefined) {
        if (spec.required) {
          drifts.push({
            kind: 'MISSING_REQUIRED_FIELD',
            severity: 'BREAKING',
            field,
            expected: spec.type,
            actual: 'missing',
            message: `Required field '${field}' is missing from '${sample.eventType}'.`,
          });
        }
        continue;
      }

      if (value === null) {
        if (!spec.nullable) {
          drifts.push({
            kind: 'TYPE_MISMATCH',
            severity: 'BREAKING',
            field,
            expected: spec.type,
            actual: 'null',
            message: `Field '${field}' is null but contract specifies non-nullable '${spec.type}'.`,
          });
        }
        continue;
      }

      const actualType = inferFieldType(value);
      if (actualType !== spec.type) {
        drifts.push({
          kind: 'TYPE_MISMATCH',
          severity: 'BREAKING',
          field,
          expected: spec.type,
          actual: actualType,
          message: `Field '${field}' expected '${spec.type}' but received '${actualType}'.`,
        });
        continue;
      }

      if (spec.enumValues && typeof value === 'string' && !spec.enumValues.includes(value)) {
        drifts.push({
          kind: 'INVALID_ENUM_VALUE',
          severity: 'BREAKING',
          field,
          expected: spec.enumValues.join(' | '),
          actual: value,
          message: `Field '${field}' value '${value}' is not in allowed enum [${spec.enumValues.join(', ')}].`,
        });
      }
    }

    for (const key of Object.keys(sample.payload)) {
      if (!Object.prototype.hasOwnProperty.call(contract.fields, key)) {
        drifts.push({
          kind: 'UNKNOWN_OPTIONAL_FIELD',
          severity: 'NON_BREAKING',
          field: key,
          expected: 'not in contract',
          actual: inferFieldType(sample.payload[key]),
          message: `Additive field '${key}' observed on '${sample.eventType}' (non-breaking).`,
        });
      }
    }

    const breakingCount = drifts.filter((d) => d.severity === 'BREAKING').length;
    const nonBreakingCount = drifts.filter((d) => d.severity === 'NON_BREAKING').length;
    const severity: DriftSeverity =
      breakingCount > 0 ? 'BREAKING' : nonBreakingCount > 0 ? 'NON_BREAKING' : 'NONE';

    return {
      eventType: sample.eventType,
      contractVersion: contract.version,
      sourceService: sample.sourceService,
      checkedAt,
      hasDrift: drifts.length > 0,
      severity,
      breakingCount,
      nonBreakingCount,
      drifts,
      rollbackRecommended: breakingCount > 0,
      remediationSteps: buildRemediation(drifts, sample.eventType),
    };
  }

  /**
   * Fetches an observed event sample via an async probe with bounded exponential
   * backoff retries, then runs drift detection.
   */
  async detectDriftWithRetry(
    sampleFetcher: () => Promise<ObservedEventSample>,
    options: DriftProbeRetryOptions = {}
  ): Promise<DriftDetectionReport> {
    const maxRetries = Math.max(0, options.maxRetries ?? 2);
    const initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 10);

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const sample = await sampleFetcher();
        const report = this.detectDrift(sample);
        return { ...report, attempts: attempt };
      } catch (err) {
        if (err instanceof EventSchemaDriftError) {
          throw err;
        }
        lastError = err;
        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, initialBackoffMs * Math.pow(2, attempt - 1)));
        }
      }
    }

    throw new EventSchemaDriftError(
      'DRIFT_PROBE_UNAVAILABLE',
      `Failed to probe event schema after ${maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      503
    );
  }
}

export const defaultEventSchemaDriftDetector = new EventSchemaDriftDetector();
