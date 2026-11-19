import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DependencyGraph,
  ImpactAnalysisError,
  analyzeImpact,
  buildGraphFromDataset,
  canView,
  formatImpactReport,
  type ImpactActor,
  type ResourceNode,
} from '../src/domain/dependency-graph';
import { SEED_IDS, buildSeedDataset } from '../src/sandbox/seed-fixtures';

const MAINTAINER: ImpactActor = { id: 'ops', role: 'MAINTAINER' };
const node = (type: ResourceNode['type'], id: string, extra: Partial<ResourceNode> = {}): ResourceNode => ({
  type,
  id,
  sensitivity: 'internal',
  ownerIds: [],
  organizationId: 'org-1',
  ...extra,
});
const ids = (entries: Array<{ resource: { id: string } }>) => entries.map((e) => e.resource.id).sort();

describe('Cross-resource dependency graph (#203)', () => {
  describe('dependency chains', () => {
    // ext --references--> settlement --settles--> invoice <--tracks-- workflow
    const g = new DependencyGraph()
      .addNode(node('invoice', 'inv'))
      .addNode(node('settlement', 'set'))
      .addNode(node('external_reference', 'ext'))
      .addNode(node('workflow', 'wf'))
      .addEdge({ type: 'settlement', id: 'set' }, 'settles', { type: 'invoice', id: 'inv' })
      .addEdge({ type: 'external_reference', id: 'ext' }, 'references', { type: 'settlement', id: 'set' })
      .addEdge({ type: 'workflow', id: 'wf' }, 'tracks', { type: 'invoice', id: 'inv' });

    it('lists direct and indirect dependents with depth and path', () => {
      const r = analyzeImpact(g, { type: 'invoice', id: 'inv' }, { actor: MAINTAINER });
      assert.deepEqual(ids(r.direct), ['set', 'wf']);
      assert.deepEqual(ids(r.indirect), ['ext']);
      const ext = r.indirect[0];
      assert.equal(ext.depth, 2);
      assert.equal(ext.via.id, 'set');
      assert.deepEqual(ext.path.map((p) => `${p.relation}:${p.resource.id}`), ['settles:set', 'references:ext']);
      assert.deepEqual(r.summary, { total: 3, direct: 2, indirect: 1, redacted: 0, byType: { settlement: 1, workflow: 1, external_reference: 1 } });
      assert.equal(r.truncated, false);
    });

    it('dependencies direction walks the other way', () => {
      const r = analyzeImpact(g, { type: 'external_reference', id: 'ext' }, { actor: MAINTAINER, direction: 'dependencies' });
      assert.deepEqual(ids(r.direct), ['set']);
      assert.deepEqual(ids(r.indirect), ['inv']);
    });

    it('maxDepth truncates and says so', () => {
      const r = analyzeImpact(g, { type: 'invoice', id: 'inv' }, { actor: MAINTAINER, maxDepth: 1 });
      assert.equal(r.indirect.length, 0);
      assert.equal(r.truncated, true);
    });

    it('maxNodes caps the report size', () => {
      const r = analyzeImpact(g, { type: 'invoice', id: 'inv' }, { actor: MAINTAINER, maxNodes: 1 });
      assert.equal(r.summary.total, 1);
      assert.equal(r.truncated, true);
    });

    it('is read-only: analysing twice gives the same report', () => {
      const a = analyzeImpact(g, { type: 'invoice', id: 'inv' }, { actor: MAINTAINER });
      const b = analyzeImpact(g, { type: 'invoice', id: 'inv' }, { actor: MAINTAINER });
      assert.deepEqual(a, b);
    });
  });

  describe('cycles', () => {
    it('terminates on cycles, reports each resource once, and lists the cycle', () => {
      const g = new DependencyGraph()
        .addNode(node('invoice', 'a'))
        .addNode(node('invoice', 'b'))
        .addNode(node('invoice', 'c'))
        .addEdge({ type: 'invoice', id: 'a' }, 'duplicate_of', { type: 'invoice', id: 'b' })
        .addEdge({ type: 'invoice', id: 'b' }, 'duplicate_of', { type: 'invoice', id: 'c' })
        .addEdge({ type: 'invoice', id: 'c' }, 'duplicate_of', { type: 'invoice', id: 'a' });
      const r = analyzeImpact(g, { type: 'invoice', id: 'a' }, { actor: MAINTAINER });
      assert.deepEqual(ids(r.direct), ['c']);
      assert.deepEqual(ids(r.indirect), ['b']);
      assert.equal(r.cycles.length, 1);
      assert.deepEqual(r.cycles[0].map((x) => x.id), ['a', 'b', 'c']);
    });

    it('detects self-loops', () => {
      const g = new DependencyGraph().addNode(node('invoice', 'a')).addEdge({ type: 'invoice', id: 'a' }, 'duplicate_of', { type: 'invoice', id: 'a' });
      const r = analyzeImpact(g, { type: 'invoice', id: 'a' }, { actor: MAINTAINER });
      assert.equal(r.summary.total, 0);
      assert.deepEqual(r.cycles.map((c) => c.map((x) => x.id)), [['a']]);
    });

    it('finds the mutual duplicate pair in the seed dataset', () => {
      const g = buildGraphFromDataset(buildSeedDataset());
      const r = analyzeImpact(g, { type: 'invoice', id: SEED_IDS.invDuplicateA }, { actor: MAINTAINER });
      assert.ok(r.cycles.some((c) => c.map((x) => x.id).join() === [SEED_IDS.invDuplicateA, SEED_IDS.invDuplicateB].join()));
    });

    it('handles long chains without recursion limits', () => {
      const g = new DependencyGraph();
      const N = 3_000;
      for (let i = 0; i < N; i++) g.addNode(node('job', `j${i}`));
      for (let i = 1; i < N; i++) g.addEdge({ type: 'job', id: `j${i}` }, 'operates_on', { type: 'job', id: `j${i - 1}` });
      g.addEdge({ type: 'job', id: 'j0' }, 'operates_on', { type: 'job', id: `j${N - 1}` });
      const r = analyzeImpact(g, { type: 'job', id: 'j0' }, { actor: MAINTAINER, maxDepth: N, maxNodes: N });
      assert.equal(r.summary.total, N - 1);
      assert.equal(r.cycles[0].length, N);
    });
  });

  describe('missing references', () => {
    it('reports dangling edges from traversed resources instead of throwing', () => {
      const ds = buildSeedDataset();
      ds.settlements.find((s) => s.id === SEED_IDS.settlePaid)!.invoiceId = 'deleted-invoice';
      const g = buildGraphFromDataset(ds);
      const r = analyzeImpact(g, { type: 'external_reference', id: SEED_IDS.xrefTxPaid }, { actor: MAINTAINER, direction: 'dependencies' });
      assert.deepEqual(r.missingReferences, [
        { from: { type: 'settlement', id: SEED_IDS.settlePaid, label: r.direct[0].resource.label, redacted: false }, relation: 'settles', to: { type: 'invoice', id: 'deleted-invoice' } },
      ]);
      assert.deepEqual(ids(r.direct), [SEED_IDS.settlePaid]);
      assert.equal(r.indirect.length, 0);
    });

    it('reports a root that itself points at a missing resource', () => {
      const g = new DependencyGraph().addNode(node('job', 'j')).addEdge({ type: 'job', id: 'j' }, 'operates_on', { type: 'invoice', id: 'gone' });
      const r = analyzeImpact(g, { type: 'job', id: 'j' }, { actor: MAINTAINER });
      assert.equal(r.missingReferences.length, 1);
      assert.equal(r.missingReferences[0].to.id, 'gone');
    });

    it('unknown root is a 404, malformed request a 400', () => {
      const g = new DependencyGraph();
      assert.throws(() => analyzeImpact(g, { type: 'invoice', id: 'x' }, { actor: MAINTAINER }), (e: unknown) => e instanceof ImpactAnalysisError && e.httpStatus === 404);
      assert.throws(() => analyzeImpact(g, { type: 'nope' as any, id: 'x' }, { actor: MAINTAINER }), (e: unknown) => e instanceof ImpactAnalysisError && e.httpStatus === 400);
      assert.throws(() => analyzeImpact(g, { type: 'invoice', id: 'x' }, { actor: MAINTAINER, maxDepth: 0 }), /positive integers/);
    });
  });

  describe('redaction', () => {
    const ds = buildSeedDataset();
    const g = buildGraphFromDataset(ds);
    const collaborator: ImpactActor = { id: SEED_IDS.collaborator, role: 'COLLABORATOR', organizationId: SEED_IDS.orgA };
    const orgAdmin: ImpactActor = { id: SEED_IDS.admin, role: 'ADMIN', organizationId: SEED_IDS.orgA };

    it('hides restricted resources from unauthorized users but keeps them in the counts', () => {
      const r = analyzeImpact(g, { type: 'invoice', id: SEED_IDS.invFailedSettlement }, { actor: collaborator });
      const auth = r.direct.find((e) => e.resource.type === 'authorization')!;
      assert.equal(auth.resource.redacted, true);
      assert.match(auth.resource.id, /^\[redacted:\d+\]$/);
      assert.equal(auth.resource.label, undefined);
      assert.equal(r.summary.redacted, 1);
      assert.ok(!JSON.stringify(r).includes(SEED_IDS.authApprovalExpiring), 'restricted id never leaks');
      // Internal resources of the same org stay visible.
      assert.ok(r.direct.some((e) => e.resource.type === 'job' && !e.resource.redacted));
    });

    it('org ADMIN and platform MAINTAINER see restricted resources', () => {
      for (const actor of [orgAdmin, MAINTAINER]) {
        const r = analyzeImpact(g, { type: 'invoice', id: SEED_IDS.invFailedSettlement }, { actor });
        assert.equal(r.summary.redacted, 0);
        assert.ok(r.direct.some((e) => e.resource.id === SEED_IDS.authApprovalExpiring));
      }
    });

    it('traverses through redacted resources and keeps aliases stable within a report', () => {
      // Owner user -> dependents include restricted grants and audit events acted by the owner.
      const viewer: ImpactActor = { id: SEED_IDS.payer, role: 'VIEWER', organizationId: SEED_IDS.orgA };
      const r = analyzeImpact(g, { type: 'organization', id: SEED_IDS.orgA }, { actor: viewer });
      const all = [...r.direct, ...r.indirect];
      assert.ok(r.summary.redacted > 0);
      for (const e of all) {
        if (e.via.redacted) {
          const parent = all.find((p) => p.resource.id === e.via.id);
          assert.ok(parent?.resource.redacted, 'via alias refers to a redacted entry in the same report');
        }
      }
      assert.ok(!JSON.stringify(r).includes('seed-auth-'), 'no authorization ids leak');
      assert.ok(!JSON.stringify(r).includes('admin@inqutum.test'));
    });

    it('cross-tenant users cannot see or probe the root (404, not 403)', () => {
      const outsider: ImpactActor = { id: SEED_IDS.sellerB, role: 'OWNER', organizationId: SEED_IDS.orgB };
      assert.throws(
        () => analyzeImpact(g, { type: 'invoice', id: SEED_IDS.invPaid }, { actor: outsider }),
        (e: unknown) => e instanceof ImpactAnalysisError && e.code === 'IMPACT_ROOT_NOT_FOUND'
      );
    });

    it('redacts dangling ids referenced from hidden resources', () => {
      const broken = buildSeedDataset();
      broken.authorizations.find((a) => a.id === SEED_IDS.authApprovalExpiring)!.grantedBy = 'deleted-user';
      const r = analyzeImpact(buildGraphFromDataset(broken), { type: 'invoice', id: SEED_IDS.invFailedSettlement }, { actor: collaborator });
      const missing = r.missingReferences.find((m) => m.relation === 'granted_by')!;
      assert.equal(missing.from.redacted, true);
      assert.equal(missing.to.id, '[redacted]');
    });

    it('canView rules', () => {
      const restricted = node('user', 'u', { sensitivity: 'restricted', ownerIds: ['u'] });
      assert.equal(canView({ id: 'u', role: 'VIEWER', organizationId: 'org-1' }, restricted), true, 'owner sees self');
      assert.equal(canView({ id: 'x', role: 'COLLABORATOR', organizationId: 'org-1' }, restricted), false);
      assert.equal(canView({ id: 'x', role: 'ADMIN', organizationId: 'org-1' }, restricted), true);
      assert.equal(canView({ id: 'x', role: 'ADMIN', organizationId: 'org-2' }, restricted), false);
      assert.equal(canView({ id: 'x', role: 'VIEWER' }, node('job', 'sweep', { organizationId: undefined })), true, 'system job');
    });
  });

  it('models every seed resource and renders a readable report', () => {
    const ds = buildSeedDataset();
    const g = buildGraphFromDataset(ds);
    const total = ds.organizations.length + ds.users.length + ds.invoices.length + ds.settlements.length + ds.authorizations.length +
      ds.workflows.length + ds.jobs.length + ds.externalReferences.length + ds.auditEvents.length;
    assert.equal(g.size, total);
    const r = analyzeImpact(g, { type: 'invoice', id: SEED_IDS.invPaid }, { actor: MAINTAINER });
    assert.deepEqual(r.missingReferences, []);
    const text = formatImpactReport(r);
    assert.match(text, /Direct:/);
    assert.match(text, /seed-xref-tx-paid/);
  });
});
