# deal-sentinel

A self-hosted price watcher for the homelab. It tracks new-retail listings (tools, furniture, building materials) across several retailers, keeps their price history indefinitely, and notifies only when history says a price is genuinely good: a historical low, an unusual drop, a clearance signal, or a known buying window.

History is the product. A price change is not news; a price that is the lowest in a year is. Every alert carries the reason it fired, because over-alerting is what kills tools like this.

Runs entirely on the owner's infrastructure at $0/month recurring, against public data only, at personal-use request volumes. Those are constraints, not goals: see `BRIEF.md` section 2.

- `BRIEF.md` - the guiding document: vision, hard constraints, the retailer landscape by difficulty tier, capabilities, architecture recommendations, milestones, and the decisions left open.
- `CLAUDE.md` - the working agreement, and how work reaches this repo through the SDD umbrella.
- `docs/decisions/` - one file per significant decision. `docs/fixtures-notes/` - what broke, what the recapture was, so the next repair is shorter.

Status: phase `HISTORY-1`. Nothing fetches anything yet, on purpose: this phase
is the smallest thing that makes collecting prices SAFE, not the smallest thing
that collects. A green suite here says the extractor is not obviously wrong
about markup somebody already saved, and that a restore has actually been
performed.

## What exists

TypeScript on Node, PostgreSQL, Drizzle. Three packages behind
`"workspaces": ["packages/*"]`:

- `packages/shared` - the cross-package types (`ExtractionResult`,
  `ObservationContext`), and nothing else.
- `packages/extractor` - `extractOffer(markup)`, pure: no database, no network,
  no filesystem. It resolves exactly one offer price and its ISO 4217 currency,
  or it returns a typed failure (`no-offer`, `ambiguous-offer`, `no-price`,
  `no-currency`). It never guesses, because a gap is visible a week later and a
  wrong number is not. It reads embedded JSON-LD and schema.org microdata, and
  scopes every microdata property to the offer element that encloses it, so the
  markup dialect never changes the verdict: a page carrying two offers at two
  prices refuses in both. Its fixtures live beside it in `fixtures/`, committed
  as files, reduced to the offer markup under test: no review body, no reviewer
  name, no account identifier, ever.
- `packages/db` - the price observation table and its first migration, the write
  path (which takes an `ExtractionResult` and writes nothing at all when it is a
  failure), the one-time initialization action, the start-up check, and the
  backup and restore scripts.

## Running it

```sh
pnpm install
pnpm typecheck
pnpm test:unit          # no docker needed
pnpm test:integration   # starts real PostgreSQL containers
pnpm test               # both
```

The integration tests are not optional decoration: the phase's own evidence is a
performed restore, so `test/integration/restore-proof.test.ts` seeds a real
database from the fixtures, dumps it with `pg_dump`, destroys the container AND
its named volume, brings up a fresh one, restores with `pg_restore`, and
compares every observation row for row.

## Starting the history database

```sh
docker volume create deal-sentinel-history      # once, deliberately
HISTORY_DB_PASSWORD=... docker compose up -d history-db
HISTORY_DATABASE_URL=postgres://sentinel:...@127.0.0.1:5432/deal_sentinel_history pnpm db:init
```

`db:init` creates the schema and writes a completed-initialization marker, and
REFUSES if a marker is already there. Every ordinary start runs
`pnpm db:start-check` first, which refuses to start when the marker is missing,
rather than beginning a new empty history. The volume is declared `external` in
`docker-compose.yml`, so `docker compose down -v` cannot take the price history
with it.

Backups:

```sh
HISTORY_DATABASE_URL=... pnpm db:backup                 # -> backups/....dump
HISTORY_DATABASE_URL=... pnpm db:restore backups/....dump
```

Both scripts run `pg_dump`/`pg_restore` from the postgres image when the client
binaries are not installed on the host (`HISTORY_PG_RUNNER=docker`), which is
the homelab case.
