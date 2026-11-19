/**
 * Post-rollback data verification (#209). Read-only.
 *
 * Usage:
 *   npm run rollback:verify -- [--fixture clean|partial|failed] [--actor-role ADMIN] [--json]
 *
 * Exit codes: 0 clean, 1 records need manual repair, 2 rollback failed / not in effect.
 * Against a live environment, call verifyReleaseRollback() with a RollbackDataSource
 * backed by your stores; see docs/ROLLBACK_VERIFICATION.md.
 */
import {
  formatReleaseRollbackReport,
  verifyReleaseRollback,
} from '../src/ops/release-rollback-verification';
import { ROLLBACK_FIXTURES, buildRollbackFixture, createFixtureDataSource, type RollbackFixtureName } from '../src/sandbox/rollback-fixtures';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let fixtureName: RollbackFixtureName = 'clean';
  let actorRole = 'ADMIN';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture' && argv[i + 1]) fixtureName = argv[++i] as RollbackFixtureName;
    else if (argv[i] === '--actor-role' && argv[i + 1]) actorRole = argv[++i];
    else if (argv[i] === '--json') json = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!ROLLBACK_FIXTURES.includes(fixtureName)) throw new Error(`--fixture must be one of ${ROLLBACK_FIXTURES.join(', ')}`);

  const fixture = buildRollbackFixture(fixtureName);
  const report = await verifyReleaseRollback({
    window: fixture.window,
    contract: fixture.contract,
    source: createFixtureDataSource(fixture),
    options: { actorId: 'cli-operator', actorRole: actorRole as 'ADMIN', now: fixture.now },
  });
  console.log(json ? JSON.stringify(report, null, 2) : formatReleaseRollbackReport(report));
  return report.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
