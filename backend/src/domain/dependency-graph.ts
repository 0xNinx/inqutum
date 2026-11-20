/**
 * Cross-resource dependency graph and read-only impact analysis (issue #203).
 *
 * Before a maintainer changes, revokes or resolves a resource they need to know
 * which records, users, operations and external references depend on it. The
 * graph stores one directed edge per dependency, `from` depends on `to`:
 *
 *   settlement --settles--> invoice --issued_by--> user --member_of--> organization
 *
 * `analyzeImpact` walks those edges and never mutates anything:
 *  - direction 'dependents' (default) answers "what is affected if I change X":
 *    it follows edges backwards, from X to everything that depends on X.
 *  - direction 'dependencies' answers "what does X rely on".
 *
 * Guarantees:
 *  - Breadth-first, so every resource is reported once at its shortest depth;
 *    depth 1 is a direct dependency, depth >= 2 is indirect.
 *  - Cycles (e.g. duplicate invoices that point at each other, an owner and the
 *    organization they own) are traversed once and reported as strongly
 *    connected components, never followed forever.
 *  - Edges whose target does not exist are reported as missing references
 *    instead of throwing, so a half-deleted record still produces a report.
 *  - Resources the actor may not see are redacted (id, label removed; type and
 *    position kept) but still traversed, so counts stay truthful and nothing
 *    downstream of a restricted node is silently dropped.
 *  - An invisible or unknown root yields the same 404, so the endpoint cannot
 *    be used to probe for the existence of restricted resources.
 *
 * See docs/DEPENDENCY_GRAPH.md.
 */
import type { CollaborationRole } from './invitation';
import { ROLE_HIERARCHY } from './invitation';
import type { SeedDataset } from '../sandbox/seed-fixtures';

export const RESOURCE_TYPES = [
  'organization',
  'user',
  'invoice',
  'settlement',
  'authorization',
  'workflow',
  'job',
  'external_reference',
  'audit_event',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type DependencyRelation =
  | 'member_of'
  | 'owned_by'
  | 'issued_by'
  | 'belongs_to'
  | 'duplicate_of'
  | 'settles'
  | 'granted_to'
  | 'granted_by'
  | 'grants_access_to'
  | 'renews'
  | 'tracks'
  | 'assigned_to'
  | 'operates_on'
  | 'references'
  | 'records'
  | 'acted_by';

export interface ResourceRef {
  type: ResourceType;
  id: string;
}

export interface ResourceNode extends ResourceRef {
  label?: string;
  /** Organization the resource belongs to; undefined for global/system resources. */
  organizationId?: string;
  /**
   * internal: visible to members of the owning organization.
   * restricted: visible only to listed owners and org OWNER/ADMIN (users, grants, audit).
   */
  sensitivity: 'internal' | 'restricted';
  ownerIds: string[];
}

export interface DependencyEdge {
  from: ResourceRef;
  to: ResourceRef;
  relation: DependencyRelation;
}

export interface ImpactActor {
  id: string;
  /** MAINTAINER is a platform operator and sees every resource. */
  role: CollaborationRole | 'MAINTAINER';
  organizationId?: string;
}

export const refKey = (ref: ResourceRef): string => `${ref.type}:${ref.id}`;

export class DependencyGraph {
  private readonly nodes = new Map<string, ResourceNode>();
  private readonly out = new Map<string, DependencyEdge[]>();
  private readonly in = new Map<string, DependencyEdge[]>();

  addNode(node: ResourceNode): this {
    this.nodes.set(refKey(node), node);
    return this;
  }

  /** Edges may point at nodes that do not exist; they surface as missing references. */
  addEdge(from: ResourceRef, relation: DependencyRelation, to: ResourceRef): this {
    const edge: DependencyEdge = { from: { type: from.type, id: from.id }, to: { type: to.type, id: to.id }, relation };
    const push = (index: Map<string, DependencyEdge[]>, key: string) => {
      const list = index.get(key);
      if (list) list.push(edge);
      else index.set(key, [edge]);
    };
    push(this.out, refKey(from));
    push(this.in, refKey(to));
    return this;
  }

  getNode(ref: ResourceRef): ResourceNode | undefined {
    return this.nodes.get(refKey(ref));
  }

  has(ref: ResourceRef): boolean {
    return this.nodes.has(refKey(ref));
  }

  outgoing(ref: ResourceRef): readonly DependencyEdge[] {
    return this.out.get(refKey(ref)) ?? [];
  }

  incoming(ref: ResourceRef): readonly DependencyEdge[] {
    return this.in.get(refKey(ref)) ?? [];
  }

  get size(): number {
    return this.nodes.size;
  }
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export function canView(actor: ImpactActor, node: ResourceNode): boolean {
  if (actor.role === 'MAINTAINER') return true;
  if (node.ownerIds.includes(actor.id)) return true;
  // Global/system resources (e.g. the expiry sweep job) carry no tenant data.
  if (node.organizationId === undefined) return node.sensitivity === 'internal';
  if (node.organizationId !== actor.organizationId) return false;
  if (node.sensitivity === 'internal') return true;
  return ROLE_HIERARCHY[actor.role] >= ROLE_HIERARCHY.ADMIN;
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export class ImpactAnalysisError extends Error {
  constructor(public readonly code: 'IMPACT_ROOT_NOT_FOUND' | 'IMPACT_INVALID_REQUEST', message: string, public readonly httpStatus: number) {
    super(message);
    this.name = 'ImpactAnalysisError';
  }
}

export type ImpactDirection = 'dependents' | 'dependencies';

export interface ImpactOptions {
  actor: ImpactActor;
  direction?: ImpactDirection;
  /** Maximum hops from the root. Default 10. */
  maxDepth?: number;
  /** Hard cap on reported resources. Default 5000. */
  maxNodes?: number;
}

/** A resource as shown to the actor: real ref, or a stable `[redacted:N]` alias. */
export interface DisplayRef {
  type: ResourceType;
  id: string;
  label?: string;
  redacted: boolean;
}

export interface ImpactEntry {
  resource: DisplayRef;
  depth: number;
  /** Relation on the edge that first reached this resource. */
  relation: DependencyRelation;
  /** The resource it was reached from (the root for direct entries). */
  via: DisplayRef;
  /** Root-to-resource chain, root excluded. */
  path: Array<{ resource: DisplayRef; relation: DependencyRelation }>;
}

export interface MissingReference {
  from: DisplayRef;
  relation: DependencyRelation;
  /** The dangling target. Its id is shown only if the actor can see the referrer. */
  to: { type: ResourceType; id: string };
}

export interface ImpactReport {
  root: DisplayRef;
  direction: ImpactDirection;
  direct: ImpactEntry[];
  indirect: ImpactEntry[];
  /** Each cycle is a strongly connected component of the traversed subgraph. */
  cycles: DisplayRef[][];
  missingReferences: MissingReference[];
  /** True when maxDepth or maxNodes stopped the traversal early. */
  truncated: boolean;
  summary: {
    total: number;
    direct: number;
    indirect: number;
    redacted: number;
    byType: Partial<Record<ResourceType, number>>;
  };
}

const compareRefs = (a: ResourceRef, b: ResourceRef) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1);

export function analyzeImpact(graph: DependencyGraph, root: ResourceRef, options: ImpactOptions): ImpactReport {
  const direction = options.direction ?? 'dependents';
  const maxDepth = options.maxDepth ?? 10;
  const maxNodes = options.maxNodes ?? 5000;
  if (!(RESOURCE_TYPES as readonly string[]).includes(root?.type) || typeof root.id !== 'string' || !root.id) {
    throw new ImpactAnalysisError('IMPACT_INVALID_REQUEST', 'root must be { type, id } with a known resource type', 400);
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || !Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new ImpactAnalysisError('IMPACT_INVALID_REQUEST', 'maxDepth and maxNodes must be positive integers', 400);
  }
  const rootNode = graph.getNode(root);
  if (!rootNode || !canView(options.actor, rootNode)) {
    throw new ImpactAnalysisError('IMPACT_ROOT_NOT_FOUND', `No ${root.type} '${root.id}' visible to this actor`, 404);
  }

  const next = (ref: ResourceRef): Array<{ ref: ResourceRef; relation: DependencyRelation }> =>
    direction === 'dependents'
      ? graph.incoming(ref).map((e) => ({ ref: e.from, relation: e.relation }))
      : graph.outgoing(ref).filter((e) => graph.has(e.to)).map((e) => ({ ref: e.to, relation: e.relation }));

  // Redaction aliases are assigned in discovery order so the same hidden
  // resource has the same alias everywhere in one report.
  const aliases = new Map<string, string>();
  const display = (ref: ResourceRef): DisplayRef => {
    const node = graph.getNode(ref)!;
    if (canView(options.actor, node)) return { type: ref.type, id: ref.id, label: node.label, redacted: false };
    const key = refKey(ref);
    if (!aliases.has(key)) aliases.set(key, `[redacted:${aliases.size + 1}]`);
    return { type: ref.type, id: aliases.get(key)!, redacted: true };
  };

  type Visit = { ref: ResourceRef; depth: number; relation: DependencyRelation; parent: string };
  const visited = new Map<string, Visit | null>([[refKey(root), null]]);
  let frontier: ResourceRef[] = [root];
  let truncated = false;

  for (let depth = 1; frontier.length > 0; depth++) {
    const layer: ResourceRef[] = [];
    for (const current of frontier) {
      const neighbours = next(current).sort((a, b) => compareRefs(a.ref, b.ref) || (a.relation < b.relation ? -1 : 1));
      for (const { ref, relation } of neighbours) {
        const key = refKey(ref);
        if (visited.has(key)) continue;
        if (depth > maxDepth || visited.size - 1 >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.set(key, { ref, depth, relation, parent: refKey(current) });
        layer.push(ref);
      }
    }
    frontier = layer;
  }

  const rootDisplay = display(root);
  const displayByKey = new Map<string, DisplayRef>([[refKey(root), rootDisplay]]);
  const visits = [...visited.values()].filter((v): v is Visit => v !== null);
  visits.sort((a, b) => a.depth - b.depth || compareRefs(a.ref, b.ref));
  for (const v of visits) displayByKey.set(refKey(v.ref), display(v.ref));

  const entries: ImpactEntry[] = visits.map((v) => {
    const path: ImpactEntry['path'] = [];
    for (let cur: Visit | null = v; cur; cur = visited.get(cur.parent) ?? null) {
      path.push({ resource: displayByKey.get(refKey(cur.ref))!, relation: cur.relation });
    }
    path.reverse();
    return {
      resource: displayByKey.get(refKey(v.ref))!,
      depth: v.depth,
      relation: v.relation,
      via: displayByKey.get(v.parent)!,
      path,
    };
  });

  // Dangling references from any traversed resource (including the root).
  const missingReferences: MissingReference[] = [];
  for (const key of visited.keys()) {
    const ref = key === refKey(root) ? root : visited.get(key)!.ref;
    for (const edge of graph.outgoing(ref)) {
      if (graph.has(edge.to)) continue;
      const from = displayByKey.get(key)!;
      missingReferences.push({
        from,
        relation: edge.relation,
        to: { type: edge.to.type, id: from.redacted ? '[redacted]' : edge.to.id },
      });
    }
  }

  const traversed = new Map<string, ResourceRef>([[refKey(root), root]]);
  for (const v of visits) traversed.set(refKey(v.ref), v.ref);
  const cycles = findCycles(traversed, next).map((component) => component.map((ref) => displayByKey.get(refKey(ref))!));

  const byType: Partial<Record<ResourceType, number>> = {};
  for (const e of entries) byType[e.resource.type] = (byType[e.resource.type] ?? 0) + 1;
  const direct = entries.filter((e) => e.depth === 1);
  const indirect = entries.filter((e) => e.depth > 1);

  return {
    root: rootDisplay,
    direction,
    direct,
    indirect,
    cycles,
    missingReferences,
    truncated,
    summary: {
      total: entries.length,
      direct: direct.length,
      indirect: indirect.length,
      redacted: entries.filter((e) => e.resource.redacted).length,
      byType,
    },
  };
}

/** Tarjan's SCC over the traversed subgraph; returns components with a real cycle. */
function findCycles(
  refs: Map<string, ResourceRef>,
  next: (ref: ResourceRef) => Array<{ ref: ResourceRef; relation: DependencyRelation }>
): ResourceRef[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: ResourceRef[][] = [];

  // Iterative Tarjan so deep chains cannot overflow the call stack.
  for (const start of refs.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ key: string; succ: string[]; i: number }> = [];
    const open = (key: string) => {
      index.set(key, counter);
      low.set(key, counter);
      counter++;
      stack.push(key);
      onStack.add(key);
      const succ = next(refs.get(key)!).map((n) => refKey(n.ref)).filter((k) => refs.has(k));
      work.push({ key, succ, i: 0 });
    };
    open(start);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.succ.length) {
        const w = frame.succ[frame.i++];
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(frame.key, Math.min(low.get(frame.key)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].key;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.key)!));
      }
      if (low.get(frame.key) === index.get(frame.key)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.key);
        const selfLoop = component.length === 1 && frame.succ.includes(frame.key);
        if (component.length > 1 || selfLoop) {
          components.push(component.map((k) => refs.get(k)!).sort(compareRefs));
        }
      }
    }
  }
  return components.sort((a, b) => compareRefs(a[0], b[0]));
}

// ---------------------------------------------------------------------------
// Model: how the core resources depend on each other
// ---------------------------------------------------------------------------

/**
 * Builds the graph from the seed dataset shape. Production adapters should
 * emit the same nodes/edges from their stores; this is the reference mapping.
 */
export function buildGraphFromDataset(ds: SeedDataset): DependencyGraph {
  const g = new DependencyGraph();
  const invoiceOrg = new Map(ds.invoices.map((i) => [i.id, i.metadata?.organizationId as string | undefined]));
  const settlementInvoice = new Map(ds.settlements.map((s) => [s.id, s.invoiceId]));
  const userOrg = new Map(ds.users.map((u) => [u.id, u.organizationId]));
  const authOrg = new Map(
    ds.authorizations.map((a) => [a.id, a.scope.resourceType === 'organization' ? a.scope.resourceId : invoiceOrg.get(a.scope.resourceId)])
  );
  const user = (id: string): ResourceRef => ({ type: 'user', id });

  for (const o of ds.organizations) {
    g.addNode({ type: 'organization', id: o.id, label: o.name, organizationId: o.id, sensitivity: 'internal', ownerIds: [o.ownerId] });
    g.addEdge({ type: 'organization', id: o.id }, 'owned_by', user(o.ownerId));
  }
  for (const u of ds.users) {
    g.addNode({ type: 'user', id: u.id, label: u.displayName, organizationId: u.organizationId, sensitivity: 'restricted', ownerIds: [u.id] });
    g.addEdge(user(u.id), 'member_of', { type: 'organization', id: u.organizationId });
  }
  for (const inv of ds.invoices) {
    const ref: ResourceRef = { type: 'invoice', id: inv.id };
    g.addNode({ ...ref, label: inv.memo, organizationId: invoiceOrg.get(inv.id), sensitivity: 'internal', ownerIds: inv.userId ? [inv.userId] : [] });
    if (inv.userId) g.addEdge(ref, 'issued_by', user(inv.userId));
    if (inv.metadata?.organizationId) g.addEdge(ref, 'belongs_to', { type: 'organization', id: inv.metadata.organizationId });
    if (inv.metadata?.duplicateOf) g.addEdge(ref, 'duplicate_of', { type: 'invoice', id: inv.metadata.duplicateOf });
  }
  for (const s of ds.settlements) {
    const ref: ResourceRef = { type: 'settlement', id: s.id };
    g.addNode({ ...ref, label: `${s.status} ${s.txHash.slice(0, 8)}`, organizationId: invoiceOrg.get(s.invoiceId), sensitivity: 'internal', ownerIds: [] });
    g.addEdge(ref, 'settles', { type: 'invoice', id: s.invoiceId });
  }
  for (const a of ds.authorizations) {
    const ref: ResourceRef = { type: 'authorization', id: a.id };
    g.addNode({ ...ref, label: `${a.kind} ${a.scope.action}`, organizationId: authOrg.get(a.id), sensitivity: 'restricted', ownerIds: [a.subjectId, a.grantedBy] });
    g.addEdge(ref, 'granted_to', user(a.subjectId));
    g.addEdge(ref, 'granted_by', user(a.grantedBy));
    g.addEdge(ref, 'grants_access_to', { type: a.scope.resourceType, id: a.scope.resourceId });
    if (a.renewedFromId) g.addEdge(ref, 'renews', { type: 'authorization', id: a.renewedFromId });
  }
  for (const w of ds.workflows) {
    const ref: ResourceRef = { type: 'workflow', id: w.id };
    g.addNode({ ...ref, label: `${w.kind} (${w.state})`, organizationId: invoiceOrg.get(w.invoiceId), sensitivity: 'internal', ownerIds: [w.ownerId] });
    g.addEdge(ref, 'tracks', { type: 'invoice', id: w.invoiceId });
    g.addEdge(ref, 'assigned_to', user(w.ownerId));
  }
  for (const j of ds.jobs) {
    const ref: ResourceRef = { type: 'job', id: j.id };
    g.addNode({ ...ref, label: `${j.type} (${j.status})`, organizationId: j.invoiceId ? invoiceOrg.get(j.invoiceId) : undefined, sensitivity: 'internal', ownerIds: [] });
    if (j.invoiceId) g.addEdge(ref, 'operates_on', { type: 'invoice', id: j.invoiceId });
  }
  for (const x of ds.externalReferences) {
    const ref: ResourceRef = { type: 'external_reference', id: x.id };
    const org = x.resourceType === 'invoice' ? invoiceOrg.get(x.resourceId) : invoiceOrg.get(settlementInvoice.get(x.resourceId) ?? '');
    g.addNode({ ...ref, label: `${x.kind} ${x.status}`, organizationId: org, sensitivity: 'internal', ownerIds: [] });
    g.addEdge(ref, 'references', { type: x.resourceType, id: x.resourceId });
  }
  for (const e of ds.auditEvents) {
    const ref: ResourceRef = { type: 'audit_event', id: e.id };
    const org =
      e.entityType === 'invoice' ? invoiceOrg.get(e.entityId)
        : e.entityType === 'authorization' ? authOrg.get(e.entityId)
          : e.entityType === 'user' ? userOrg.get(e.entityId)
            : invoiceOrg.get(settlementInvoice.get(e.entityId) ?? '');
    g.addNode({ ...ref, label: e.action, organizationId: org, sensitivity: 'restricted', ownerIds: e.actorId === 'system' ? [] : [e.actorId] });
    g.addEdge(ref, 'records', { type: e.entityType, id: e.entityId });
    if (e.actorId !== 'system') g.addEdge(ref, 'acted_by', user(e.actorId));
  }
  return g;
}

/** Plain-text rendering for the CLI. */
export function formatImpactReport(report: ImpactReport): string {
  const name = (r: DisplayRef) => `${r.type}:${r.id}${r.label ? ` (${r.label})` : ''}`;
  const lines = [
    `Impact analysis (${report.direction}) for ${name(report.root)}`,
    `  ${report.summary.total} resources: ${report.summary.direct} direct, ${report.summary.indirect} indirect, ${report.summary.redacted} redacted`,
    `  by type: ${Object.entries(report.summary.byType).map(([t, n]) => `${t}=${n}`).join(', ') || 'none'}`,
    '',
    'Direct:',
    ...report.direct.map((e) => `  - ${name(e.resource)} [${e.relation}]`),
    'Indirect:',
    ...report.indirect.map((e) => `  - ${name(e.resource)} [depth ${e.depth}, ${e.relation} via ${e.via.type}:${e.via.id}]`),
  ];
  if (report.cycles.length) {
    lines.push('Cycles:', ...report.cycles.map((c) => `  - ${c.map((r) => `${r.type}:${r.id}`).join(' <-> ')}`));
  }
  if (report.missingReferences.length) {
    lines.push('Missing references:', ...report.missingReferences.map((m) => `  - ${m.from.type}:${m.from.id} --${m.relation}--> ${m.to.type}:${m.to.id} (not found)`));
  }
  if (report.truncated) lines.push('', 'Traversal truncated by maxDepth/maxNodes; raise the limits to see the full impact.');
  return lines.join('\n');
}
