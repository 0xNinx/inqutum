/**
 * Contributor seed fixtures CLI (issue #201). See docs/SEED_FIXTURES.md.
 *
 *   npm run seed:fixtures                       # validate + summary, no database needed
 *   npm run seed:fixtures -- --json             # print the dataset as JSON
 *   npm run seed:fixtures -- --sql              # print idempotent INSERTs
 *   npm run seed:fixtures -- --reset-sql        # print DELETEs for seeded rows only
 *   npm run seed:fixtures -- --apply            # validate, then load into DATABASE_URL
 *   npm run seed:fixtures -- --reset            # delete seeded rows from DATABASE_URL
 *   ... --anchor now                            # shift timestamps so "pending" stays pending today
 *
 * --apply and --reset refuse to run when NODE_ENV=production.
 */
import {
  DEFAULT_SEED_ANCHOR,
  buildSeedDataset,
  seedDatasetToSql,
  seedResetSql,
  validateSeedDataset,
} from '../sandbox/seed-fixtures';

type Mode = 'check' | 'json' | 'sql' | 'reset-sql' | 'apply' | 'reset';

function parseArgs(argv: string[]): { mode: Mode; anchor: string } {
  let mode: Mode = 'check';
  let anchor = DEFAULT_SEED_ANCHOR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--anchor' && argv[i + 1]) {
      const value = argv[++i];
      anchor = value === 'now' ? new Date().toISOString() : value;
    } else if (['--check', '--json', '--sql', '--reset-sql', '--apply', '--reset'].includes(arg)) {
      mode = arg.slice(2) as Mode;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode, anchor };
}

async function main(): Promise<number> {
  const { mode, anchor } = parseArgs(process.argv.slice(2));
  const dataset = buildSeedDataset(anchor);
  const validation = validateSeedDataset(dataset);

  if (!validation.ok) {
    console.error('Seed dataset failed validation:');
    for (const issue of validation.issues) console.error(`  [${issue.code}] ${issue.path}: ${issue.message}`);
    return 1;
  }

  switch (mode) {
    case 'check':
      console.log(`Seed dataset v${dataset.version} anchored at ${dataset.anchor.toISOString()} is consistent.`);
      for (const [name, count] of Object.entries(validation.counts)) console.log(`  ${name.padEnd(20)} ${count}`);
      return 0;
    case 'json':
      console.log(JSON.stringify(dataset, null, 2));
      return 0;
    case 'sql':
      process.stdout.write(seedDatasetToSql(dataset));
      return 0;
    case 'reset-sql':
      process.stdout.write(seedResetSql(dataset));
      return 0;
    case 'apply':
    case 'reset': {
      if (process.env.NODE_ENV === 'production') {
        console.error(`Refusing to --${mode} seed fixtures with NODE_ENV=production.`);
        return 1;
      }
      // Imported lazily so the default modes never need DATABASE_URL.
      const { pool } = await import('../config/database');
      try {
        await pool.query(mode === 'apply' ? seedDatasetToSql(dataset) : seedResetSql(dataset));
        console.log(mode === 'apply' ? `Loaded ${dataset.invoices.length} seed invoices.` : 'Removed seeded rows.');
      } finally {
        await pool.end();
      }
      return 0;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
