import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  DOMAIN_EVENT_CONTRACTS,
  KNOWN_UNDECLARED_EVENTS,
  compareContracts,
  contractFor,
  validateEventPayload,
  type DomainEventContract,
} from '../src/contracts/domain-events.ts';
import { createInvoiceRouter } from '../src/routes/invoice.routes.ts';
import { MemoryInvoiceStorage } from '../src/storage/memory-invoice-storage.ts';
import memoryStorage from '../src/storage/memory-storage.ts';
import { auditStore } from '../src/audit/audit-service.ts';
import { NotificationService } from '../src/notifications/notification-service.ts';
import { MemoryJobStore } from '../src/jobs/memory-job-store.ts';
import { JobQueue } from '../src/jobs/worker.ts';
import { scheduleExpirySweep, scheduleReconciliation } from '../src/jobs/runtime.ts';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const SELLER = `G${'A'.repeat(55)}`;

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [relative(ROOT, full)] : [];
  });
}

/** Members of a string-literal union type, read from source. */
function unionMembers(file: string, typeName: string): string[] {
  const match = read(file).match(new RegExp(`export type ${typeName} =([^;]+);`));
  assert.ok(match, `${typeName} not found in ${file}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Required fields at the current version, pinned for the events other
 * components depend on most. Changing a contract's required fields without
 * bumping its version fails here; bump the version, follow the dual-publish
 * rule in docs/CONTRACT_MAP.md, then update this lock.
 */
const PINNED: Record<string, { version: number; required: string[] }> = {
  'audit:INVOICE_CREATED': {
    version: 1,
    required: [
      'id', 'timestamp', 'action', 'actor.type', 'actor.id', 'scope.entityType', 'scope.entityId', 'hash',
      'afterState.id', 'afterState.sellerPublicKey', 'afterState.amount', 'afterState.assetCode', 'afterState.memo', 'afterState.status',
    ],
  },
  'audit:PAYMENT_VERIFIED': {
    version: 1,
    required: [
      'id', 'timestamp', 'action', 'actor.type', 'actor.id', 'scope.entityType', 'scope.entityId', 'hash',
      'afterState.id', 'afterState.sellerPublicKey', 'afterState.amount', 'afterState.assetCode', 'afterState.memo', 'afterState.status',
      'metadata.txHash', 'metadata.payerPublicKey',
    ],
  },
  'notification:invoice.paid': {
    version: 1,
    required: ['id', 'recipient', 'type', 'severity', 'title', 'message', 'dedupKey', 'entityId', 'createdAt', 'data.invoiceId'],
  },
  'job:projections.reconcile': { version: 1, required: ['id', 'type', 'payload.version', 'payload.data'] },
};

/** Security-session audit actions are a separate boundary (docs/THREAT_MODEL.md), not domain events. */
const OUT_OF_SCOPE_AUDIT = (action: string) => action.startsWith('IMPERSONATION_') || action === 'CAPABILITY_ISSUED';

describe('contract map: completeness against the code', () => {
  it('every AuditAction, NotificationType and job type has a contract', () => {
    const declared = (channel: string) => new Set(DOMAIN_EVENT_CONTRACTS.filter((c) => c.channel === channel).map((c) => c.name));
    const audit = declared('audit');
    const auditActions = unionMembers('src/audit/audit-service.ts', 'AuditAction').filter((a) => !OUT_OF_SCOPE_AUDIT(a));
    for (const action of auditActions) assert.ok(audit.has(action), `AuditAction ${action} has no contract`);

    const notifications = declared('notification');
    for (const type of unionMembers('src/notifications/notification-service.ts', 'NotificationType')) {
      assert.ok(notifications.has(type), `NotificationType ${type} has no contract`);
    }

    const jobs = declared('job');
    const jobConsts = [...read('src/jobs/runtime.ts').matchAll(/export const \w+_JOB = '([^']+)'/g)].map((m) => m[1]);
    jobConsts.push(...[...read('src/db/retention.ts').matchAll(/RETENTION_SWEEP_JOB = '([^']+)'/g)].map((m) => m[1]));
    assert.ok(jobConsts.length >= 4);
    for (const type of jobConsts) assert.ok(jobs.has(type), `job type ${type} has no contract`);
  });

  it('every audit action written in src is declared, or listed as a known gap', () => {
    const known = new Set([...DOMAIN_EVENT_CONTRACTS.map((c) => c.name), ...KNOWN_UNDECLARED_EVENTS.map((g) => g.name)]);
    const allowed = new Set(unionMembers('src/audit/audit-service.ts', 'AuditAction'));
    for (const file of sourceFiles()) {
      // Only literals passed to an audit write: recordEvent / recordAuditEvent / recordAudit.
      for (const [, action] of read(file).matchAll(/record(?:Audit)?(?:Event)?\(\{[\s\S]{0,120}?action: '([A-Z_]+)'/g)) {
        assert.ok(known.has(action) || allowed.has(action), `${file} writes undeclared audit action ${action}`);
      }
    }
    for (const gap of KNOWN_UNDECLARED_EVENTS) {
      assert.ok(read(gap.file).includes(`'${gap.name}'`), `known gap ${gap.name} no longer in ${gap.file}; remove it from KNOWN_UNDECLARED_EVENTS`);
    }
  });

  it('every producer and consumer marker exists in the named file', () => {
    for (const contract of DOMAIN_EVENT_CONTRACTS) {
      for (const endpoint of [...contract.producers, ...contract.consumers]) {
        assert.ok(read(endpoint.file).includes(endpoint.marker), `${contract.name}: "${endpoint.marker}" not found in ${endpoint.file}`);
      }
    }
  });

  it('status agrees with the endpoints and every boundary states its failure behaviour', () => {
    for (const c of DOMAIN_EVENT_CONTRACTS) {
      if (c.status === 'no_producer') assert.equal(c.producers.length, 0, c.name);
      else assert.ok(c.producers.length > 0, `${c.name} is ${c.status} but has no producer`);
      assert.ok(c.consumers.length > 0, `${c.name} has no consumer`);
      for (const e of [...c.producers, ...c.consumers]) assert.ok(e.onFailure, `${c.name}/${e.component}`);
    }
    const names = DOMAIN_EVENT_CONTRACTS.map((c) => `${c.channel}:${c.name}`);
    assert.equal(new Set(names).size, names.length, 'duplicate contract');
  });

  it('docs/CONTRACT_MAP.md lists every contract', () => {
    const doc = readFileSync(join(ROOT, '..', 'docs', 'CONTRACT_MAP.md'), 'utf8');
    for (const c of DOMAIN_EVENT_CONTRACTS) assert.ok(doc.includes(`\`${c.name}\``), `${c.name} missing from docs/CONTRACT_MAP.md`);
  });
});

describe('contract map: version rules', () => {
  const base = contractFor('PAYMENT_VERIFIED', 'audit')!;
  const revise = (patch: Partial<DomainEventContract>): DomainEventContract => ({ ...base, ...patch });

  it('required fields match the pinned lock for the current version', () => {
    for (const [key, pinned] of Object.entries(PINNED)) {
      const [channel, name] = key.split(/:(.+)/);
      const contract = contractFor(name, channel as DomainEventContract['channel'])!;
      const sameFields = JSON.stringify(contract.requiredFields.map((f) => f.path)) === JSON.stringify(pinned.required);
      assert.ok(sameFields || contract.version > pinned.version, `${key}: required fields changed without a version bump`);
      assert.ok(contract.version >= pinned.version, `${key}: version went backwards`);
    }
  });

  it('adding an optional field keeps the version', () => {
    const r = compareContracts(base, revise({ optionalFields: [...base.optionalFields, { path: 'metadata.ledger', type: 'number' }] }));
    assert.deepEqual(r.breaking, []);
    assert.deepEqual(r.additive, ['added optional metadata.ledger']);
    assert.equal(r.versionOk, true);
  });

  it('adding a required field, removing a field or changing a type needs a bump', () => {
    const addRequired = revise({ requiredFields: [...base.requiredFields, { path: 'metadata.ledger', type: 'number' }] });
    assert.deepEqual(compareContracts(base, addRequired).breaking, ['added required metadata.ledger']);
    assert.equal(compareContracts(base, addRequired).versionOk, false);
    assert.equal(compareContracts(base, { ...addRequired, version: 2 }).versionOk, true);

    const removed = revise({ requiredFields: base.requiredFields.filter((f) => f.path !== 'metadata.txHash') });
    assert.deepEqual(compareContracts(base, removed).breaking, ['removed metadata.txHash']);

    const retyped = revise({ requiredFields: base.requiredFields.map((f) => (f.path === 'afterState.amount' ? { ...f, type: 'string' as const } : f)) });
    assert.deepEqual(compareContracts(base, retyped).breaking, ['changed type of afterState.amount from number to string']);
  });
});

describe('contract map: real payloads satisfy their contracts', () => {
  it('audit events produced by the invoice API', async () => {
    memoryStorage.clear();
    const app = express();
    app.use(express.json());
    app.use('/api', createInvoiceRouter({ storage: new MemoryInvoiceStorage(), allowSimulate: true }));
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

      const a = (await (await post('/invoices', { amount: 5, assetCode: 'XLM', sellerPublicKey: SELLER })).json()).data.invoice;
      const b = (await (await post('/invoices', { amount: 7, assetCode: 'XLM', sellerPublicKey: SELLER })).json()).data.invoice;
      assert.equal((await post(`/invoices/${a.id}/cancel`, {})).status, 200);
      assert.equal((await post(`/invoices/${b.id}/simulate-payment`, {})).status, 200);

      const checks: Array<[string, string]> = [
        [a.id, 'INVOICE_CREATED'],
        [a.id, 'INVOICE_CANCELLED'],
        [b.id, 'INVOICE_CREATED'],
        [b.id, 'PAYMENT_SIMULATED'],
      ];
      for (const [id, action] of checks) {
        const event = auditStore.getEventsByEntity(id).find((e) => e.action === action);
        assert.ok(event, `${action} for ${id} not recorded`);
        assert.deepEqual(validateEventPayload(contractFor(action, 'audit')!, event), [], action);
      }
    } finally {
      server.close();
    }
  });

  it('notification produced for a paid invoice', () => {
    const service = new NotificationService();
    const n = service.syncInvoiceNotifications({
      id: 'inv-1', sellerPublicKey: SELLER, amount: 5, assetCode: 'XLM', memo: 'M-1', status: 'PAID',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
    });
    assert.ok(n);
    assert.deepEqual(validateEventPayload(contractFor('invoice.paid', 'notification')!, n), []);
  });

  it('jobs enqueued by the schedulers', async () => {
    const queue = new JobQueue(new MemoryJobStore());
    const expiry = (await scheduleExpirySweep(queue, new Date())).job;
    const reconcile = (await scheduleReconciliation(queue, new Date(), 60_000)).job;
    assert.deepEqual(validateEventPayload(contractFor(expiry.type, 'job')!, expiry), []);
    assert.deepEqual(validateEventPayload(contractFor(reconcile.type, 'job')!, reconcile), []);
  });

  it('a payload missing a required field is rejected with a precise message', () => {
    const problems = validateEventPayload(contractFor('PAYMENT_VERIFIED', 'audit')!, { id: 'x', action: 'PAYMENT_VERIFIED', afterState: { amount: '5' } });
    assert.ok(problems.includes('PAYMENT_VERIFIED: missing required metadata.txHash'));
    assert.ok(problems.includes('PAYMENT_VERIFIED: afterState.amount is not number'));
  });
});
