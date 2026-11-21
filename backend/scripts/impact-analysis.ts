/**
 * Read-only impact analysis over the contributor seed dataset (#203).
 *
 * Usage:
 *   npm run impact:analyze -- --type invoice --id <id> [--direction dependents|dependencies]
 *                             [--actor-id <id>] [--actor-role MAINTAINER|OWNER|ADMIN|COLLABORATOR|VIEWER]
 *                             [--actor-org <orgId>] [--max-depth 10] [--json]
 *
 * Defaults to a MAINTAINER actor. Exit code 0 on success, 1 on a bad request or unknown root.
 */
import {
  ImpactAnalysisError,
  analyzeImpact,
  buildGraphFromDataset,
  formatImpactReport,
  type ImpactActor,
  type ImpactDirection,
  type ResourceType,
} from '../src/domain/dependency-graph';
import { buildSeedDataset } from '../src/sandbox/seed-fixtures';

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i].startsWith('--') && argv[i + 1] !== undefined) opts[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { opts, json };
}

function main(): number {
  const { opts, json } = parseArgs(process.argv.slice(2));
  if (!opts.type || !opts.id) {
    console.error('Usage: npm run impact:analyze -- --type <resourceType> --id <id> [--actor-role ...] [--json]');
    return 1;
  }
  const actor: ImpactActor = {
    id: opts['actor-id'] ?? 'cli-maintainer',
    role: (opts['actor-role'] ?? 'MAINTAINER') as ImpactActor['role'],
    organizationId: opts['actor-org'],
  };
  const graph = buildGraphFromDataset(buildSeedDataset());
  try {
    const report = analyzeImpact(graph, { type: opts.type as ResourceType, id: opts.id }, {
      actor,
      direction: (opts.direction ?? 'dependents') as ImpactDirection,
      maxDepth: opts['max-depth'] ? Number(opts['max-depth']) : undefined,
    });
    console.log(json ? JSON.stringify(report, null, 2) : formatImpactReport(report));
    return 0;
  } catch (error) {
    if (error instanceof ImpactAnalysisError) {
      console.error(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exit(main());
