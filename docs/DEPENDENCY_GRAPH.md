# Cross-Resource Dependency Graph & Impact Analysis (#203)

Before changing, revoking or resolving a critical resource, a maintainer needs to
know which records, users, operations and external references depend on it.
`analyzeImpact` answers that question. It is read-only: it walks an in-memory
graph and never touches storage.

Source: `backend/src/domain/dependency-graph.ts` · Tests: `backend/tests/dependency-graph.test.ts`

## Model

Every edge reads "**from depends on to**".

| From | Relation | To |
| --- | --- | --- |
| user | `member_of` | organization |
| organization | `owned_by` | user |
| invoice | `issued_by` / `belongs_to` | user / organization |
| invoice | `duplicate_of` | invoice |
| settlement | `settles` | invoice |
| authorization | `granted_to` / `granted_by` | user |
| authorization | `grants_access_to` | organization or invoice |
| authorization | `renews` | authorization (its predecessor) |
| workflow | `tracks` / `assigned_to` | invoice / user |
| job | `operates_on` | invoice |
| external_reference | `references` | invoice or settlement |
| audit_event | `records` / `acted_by` | any entity / user |

`buildGraphFromDataset()` is the reference mapping from the seed dataset
(see [SEED_FIXTURES.md](./SEED_FIXTURES.md)). A store-backed adapter should
emit the same nodes and edges.

## Running it

```bash
cd backend
npm run impact:analyze -- --type invoice --id 5eed0000-0000-4000-8001-000000000003
npm run impact:analyze -- --type user --id seed-user-owner --actor-role COLLABORATOR \
  --actor-id seed-user-collab-revoked --actor-org seed-org-a
npm run impact:analyze -- --type external_reference --id seed-xref-tx-paid --direction dependencies --json
```

Programmatically:

```ts
const report = analyzeImpact(graph, { type: 'invoice', id }, {
  actor: { id: 'u1', role: 'ADMIN', organizationId: 'org-a' },
  direction: 'dependents', // or 'dependencies'
  maxDepth: 10,
  maxNodes: 5000,
});
```

Example (collaborator in org A, failed-settlement invoice):

```
Impact analysis (dependents) for invoice:5eed…0003 (INV-SEED-FAILED-SETTLE)
  6 resources: 5 direct, 1 indirect, 1 redacted
Direct:
  - authorization:[redacted:1] [grants_access_to]
  - external_reference:seed-xref-webhook-failed (webhook_delivery failed) [references]
  - job:5eed…0002 (payments.verify (dead)) [operates_on]
  - settlement:5eed…0002 (failed 39d2b309) [settles]
  - workflow:seed-wf-settlement-review (settlement_review (manual_review)) [tracks]
Indirect:
  - external_reference:seed-xref-tx-failed (stellar_tx rejected) [depth 2, references via settlement:5eed…0002]
```

## Interpreting the result

| Field | Meaning |
| --- | --- |
| `direction` | `dependents`: what is affected if the root changes. `dependencies`: what the root relies on. |
| `direct` | Depth 1. These break or change immediately. Review each one. |
| `indirect` | Depth ≥ 2, at their **shortest** distance. Each resource appears once. `via` and `path` show the chain that reaches it. |
| `cycles` | Strongly connected groups in the traversed part of the graph. Each is walked once. Usually expected (an owner and their organization), but `duplicate_of` cycles mean duplicates that point at each other and should be resolved together. |
| `missingReferences` | Edges from a traversed resource to a record that does not exist. The report still completes. Treat these as data-integrity issues to repair **before** making the change. |
| `truncated` | `maxDepth` or `maxNodes` stopped the walk. The impact is at least what is listed. Raise the limits before relying on it. |
| `summary.redacted` | Number of affected resources you are not allowed to see. Non-zero means the change affects things outside your visibility, so involve an org ADMIN or maintainer. |

## Redaction

| Resource | Sensitivity | Visible to |
| --- | --- | --- |
| organization, invoice, settlement, workflow, job, external reference | internal | Members of the same organization. System jobs with no organization are visible to everyone. |
| user, authorization, audit event | restricted | The resource's own users (the user, a grant's subject or grantor, an event's actor), plus OWNER/ADMIN of the same organization |
| any | — | `MAINTAINER` (platform operator) sees everything |

A redacted resource keeps its **type**, depth, relation and position in paths.
Its **id and label** are replaced with a per-report alias (`[redacted:N]`), so
two mentions of the same hidden resource match without exposing it.
Traversal continues *through* redacted resources, so nothing downstream is
dropped. A dangling id referenced from a redacted resource is also redacted.

If the root is unknown **or** not visible, the result is the same
`404 IMPACT_ROOT_NOT_FOUND`. The query cannot be used to test whether a
restricted resource exists.

## Tradeoffs

- **Graph in memory.** Adapters build the graph and the analysis stays pure,
  which makes it easy to test and impossible to write through. A store-backed
  adapter for very large tenants would need to load the graph incrementally.
- **BFS and shortest depth.** "Direct" and "indirect" get one clear meaning.
  Other, longer routes to the same resource are not listed.
- **Iterative Tarjan** for cycle detection, so deep chains cannot overflow the
  stack. This is tested with a 3 000-node cycle.
