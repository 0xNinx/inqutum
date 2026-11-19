/**
 * Stale authorization report / cleanup (#199) over the contributor seed dataset.
 *
 * Usage:
 *   npm run auth:stale              # read-only report (default)
 *   npm run auth:stale -- --apply   # mark expired grants past grace as cleaned (in-memory, prints audit events)
 *   npm run auth:stale -- --json
 */
import { MemoryAuditStore } from '../src/audit/audit-service';
import { AuthorizationLifecycle } from '../src/domain/authorization-lifecycle';
import { buildSeedDataset } from '../src/sandbox/seed-fixtures';

function main(): number {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  const dataset = buildSeedDataset();
  const audit = new MemoryAuditStore();
  const lifecycle = new AuthorizationLifecycle({ audit, now: () => dataset.anchor }).load(dataset.authorizations);

  const report = lifecycle.findStale();
  const cleanup = lifecycle.cleanup({ actor: { id: 'cli-maintainer', role: 'ADMIN' }, dryRun: !apply });
  const events = audit.listChronological();

  if (json) {
    console.log(JSON.stringify({ report, cleanup, auditEvents: events }, null, 2));
    return 0;
  }
  const c = report.counts;
  console.log(`Authorizations at ${report.generatedAt}: ${c.active} active, ${c.expired} expired, ${c.revoked} revoked, ${c.cleaned} cleaned, ${c.renewed} renewed`);
  console.log('\nExpired (no longer authorize anything):');
  for (const e of report.expired) {
    console.log(`  - ${e.grant.id} ${e.grant.scope.action} for ${e.grant.subjectId}, expired ${Math.round(e.expiredForMs / 3_600_000)}h ago${e.eligibleForCleanup ? ' [cleanup]' : ' [in grace]'}`);
  }
  console.log('\nExpiring soon (renewal candidates):');
  for (const e of report.expiringSoon) {
    console.log(`  - ${e.grant.id} ${e.grant.scope.action} for ${e.grant.subjectId}, ${Math.round(e.expiresInMs / 3_600_000)}h left`);
  }
  console.log(`\n${cleanup.dryRun ? 'Dry run: would clean' : 'Cleaned'} ${cleanup.cleaned.length}: ${cleanup.cleaned.join(', ') || 'none'}`);
  if (!cleanup.dryRun) console.log(`Audit events written: ${events.map((e) => e.action).join(', ')}`);
  return 0;
}

process.exit(main());
