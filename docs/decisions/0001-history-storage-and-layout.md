# 0001 - storage, layout, and how a price becomes an integer

Decided for phase `HISTORY-1`, implemented in spec
`S0002-deal-sentinel-history-1`. Brief section 9 leaves decisions 1 and 2 open;
this file records where each half was actually settled, so a later phase extends
`packages/` rather than reopening any of it.

## Language, database engine, migration tool: not decided here

TypeScript on Node, PostgreSQL, and Drizzle. The owner decided the language and
the database engine ("typescript / node / postgresql"); the migration tool was
selected from options offered to them. The record of authority is the umbrella
file `work/specs/S0002-deal-sentinel-history-1/operator-decision-section-9-language-and-storage.md`,
and nothing in this repo may cite the Drizzle choice as the owner's own words.

Drizzle's rationale of record: it emits plain `.sql` migrations, which
`pg_dump`/`pg_restore` round-trip cleanly, keeping the schema loosely coupled to
the restore proof.

## Layout: three packages, npm workspaces

Fixed by the spec's own "Layout decision" section, not by the owner:

- `packages/shared` - the cross-package types, and nothing else.
- `packages/extractor` - the pure extractor and its committed fixtures. No
  database import, no network, no filesystem beyond reading its own fixtures in
  tests. Purity is a package boundary here, so a later adapter cannot make it
  impure by import alone.
- `packages/db` - schema, migrations, the guarded write path, the one-time
  initialization action, the start-up check, and the backup/restore scripts.

A later live adapter (`SOURCE-3`) depends on the extractor and on the db write
path; neither of those depends on the other, and neither depends on the adapter.
The repo-root `test/` directory is where the two are composed for integration
tests, which is the same seat that adapter will sit in.

`package.json` declares `"workspaces": ["packages/*"]`. **Deviation, recorded:**
installs here are run with pnpm, and `pnpm-workspace.yaml` restates the same
globs because pnpm does not read the `workspaces` field. The umbrella's build
environment permits `pnpm` and not `npm`, and pnpm is already installed there,
so it is not a new dependency in that environment. The package layout, the
boundaries and the `workspaces` field are unchanged, and `pnpm-lock.yaml` is
committed. Neither workspace file may drift from the other.

## A price becomes an integer by its own currency's exponent

`amount_minor_units` is a Postgres `bigint`, and the conversion from a decimal
price uses **that currency's ISO 4217 minor-unit exponent**: 2 for USD, 0 for
JPY, 3 for KWD. Never a fixed multiply-by-100.

The spec's acceptance says "an exact integer minor unit" and does not name the
mechanism. A fixed x100 satisfies USD and silently records JPY 12800 as
1280000 and KWD 12.995 as 1300, and a wrong price is indistinguishable from a
true one a week later, when the page it came from is gone. The fixture suite
carries a JPY fixture (exponent 0) and a KWD fixture (exponent 3) precisely so
the generic path is exercised rather than merely intended: a fixed x100 passes
every USD fixture and fails those two.

Consequences, each of them a test:

- A currency code the table in `packages/extractor/src/currency.ts` does not
  carry is answered `no-currency`, not assumed to be a 2-decimal currency.
  Onboarding a currency means adding its code and exponent.
- A price with a non-zero digit past its currency's exponent ("12.995" in USD)
  is answered `no-price`. Rounding it would poison the series.
- A number shape that means two different things in two locales ("1.299") is
  answered `no-price`. Only plain `1299.00` and US-grouped `1,299.00` are read.

## Availability is stored as received

The `availability` column holds the schema.org token exactly as the markup
carried it, including one outside the twelve documented `ItemAvailability`
members. NULL means the markup declared no availability at all, which is not the
same as a token whose meaning is unknown. Ten of the twelve members are neither
`InStock` nor `OutOfStock`, so a boolean would be lossy on its first day.

## The store id is reserved, and is not the per-listing key

`store_id` is nullable, is left unpopulated by this phase, and is refused by the
write path if a caller tries to set it. `listing_id` is what a row is attributed
by. `HARD-8` adds store-scoped sources and will populate it then; until then, a
row that carried a store id would be claiming a dimension nothing in this repo
can observe.
