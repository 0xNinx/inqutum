# Contributor Seed Fixtures (#201)

A deterministic, commit-safe dataset that covers Inqutum's core workflows and
their awkward edge cases, without any production data or credentials.

Source: `backend/src/sandbox/seed-fixtures.ts` · CLI: `backend/src/db/seed-fixtures-cli.ts` ·
Tests: `backend/tests/seed-fixtures.test.ts`

## What is in it

| Collection | Rows | Edge cases covered |
| --- | --- | --- |
| organizations | 2 | Two tenants, so cross-tenant visibility can be tested |
| users | 6 | Owner, admin, revoked collaborator, payer, **suspended** viewer |
| invoices | 8 | Pending, paid, **failed settlement**, expired, cancelled, **historical (2 years old, no `_schemaVersion`)**, two **mutual duplicates** (a dependency cycle) |
| settlements | 3 | Confirmed, **failed (`UNDERPAID`)**, historical |
| authorizations | 7 | Active, **revoked**, **expired-but-still-stored-active** (cleanup target), expiring in 24 h (renewal candidate), cleaned, a renewed → renewal chain |
| workflows | 3 | **Overdue** (SLA breached 2 h ago), completed, in manual review |
| jobs | 4 | Succeeded, **dead-lettered** with error, system sweep |
| externalReferences | 5 | Confirmed/rejected Stellar txs, delivered email, failed webhook |
| auditEvents | 8 | Historical and recent events, including revocation and renewal |

`SEED_IDS` exports every id so tests can refer to records by meaning
(`SEED_IDS.invFailedSettlement`) instead of by literal.

## Safety and determinism

- **Fixed anchor.** Every timestamp is an offset from `DEFAULT_SEED_ANCHOR`
  (`2026-01-15T12:00:00Z`). Same anchor ⇒ deeply equal dataset and
  byte-identical SQL on every machine.
- **Fixed ids.** Invoice, settlement and job ids are UUIDs so the SQL loads into
  the real schema; transaction hashes are `sha256("inqutum-seed:<label>")`, never
  real network hashes.
- **No secrets.** Public keys are the throwaway testnet keys already in
  `db/seed.sql` and `sandbox/fixtures.ts`. Emails use the reserved `.test` TLD.
  The validator fails on anything matching a Stellar secret seed or a
  credential-looking field, so an accidental paste cannot pass CI.

## Commands

All commands run from `backend/`. Only `--apply`/`--reset` need a database.

```bash
npm run seed:fixtures                      # validate + summary (no database needed)
npm run seed:fixtures -- --json            # dump the dataset
npm run seed:fixtures -- --sql > seed.sql  # idempotent INSERTs (ON CONFLICT DO NOTHING)
npm run seed:fixtures -- --reset-sql       # DELETEs for seeded ids only

# Load into your local Postgres (DATABASE_URL), after `npm run db:migrate`:
npm run seed:fixtures -- --apply --anchor now
# Remove exactly the seeded rows again:
npm run seed:fixtures -- --reset
```

`--anchor now` shifts the whole dataset to the current time. Without it the
fixed 2026-01-15 anchor is used, and the server's lazy expiry would turn the
seeded `PENDING` invoices into `EXPIRED` the first time you list them.

`--apply` and `--reset` refuse to run when `NODE_ENV=production`. Reset deletes
by seeded id only (jobs → transactions → payment_events → invoices), never with
an unscoped `DELETE`.

Only invoices, settlements (as `transactions`) and jobs have Postgres tables
today. Users, authorizations, workflows, external references and audit events
are used in memory by the dependency graph, authorization lifecycle and
rollback verification modules and their tests.

## Validation

`validateSeedDataset(ds)` returns every issue at once (`{ code, path, message }`).
It checks:

- unique ids across all collections, unique invoice memos;
- every reference resolves (owners, members, invoices, settlements, grants,
  renewal chains in both directions, audit actors);
- invoice state rules: `PAID` needs tx hash, payer, `paidAt` and a confirmed
  settlement with the same hash; unpaid invoices carry no payment fields;
  `PENDING` must not already be past `expiresAt`; `EXPIRED` must be;
- failed settlements have a reason and are never recorded as the payment;
- revoked grants name who revoked them; cleaned grants were cleaned after expiry;
- completed workflows have `completedAt` (and only they do); dead jobs keep
  their last error;
- no records dated after the anchor; reserved email domains; no secret material.

`npm test` runs the validator against the committed dataset and checks that
deliberately broken copies are rejected.

## Adding an edge case

1. Add the record in `buildSeedDataset()` using offsets from the anchor and a
   new `SEED_IDS` entry.
2. Run `npm run seed:fixtures`; fix anything the validator reports.
3. If the new case needs a new rule, add it to `validateSeedDataset` and a
   "catches broken edits" test.
