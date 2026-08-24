# 0003: Database engine and migration tooling

Status: decided
Decision owner: the owner (Noah)
Resolves: BRIEF.md section 9, decision 2 (database engine and migration tooling)
Recorded by: S0016-deal-sentinel-decisions-1

Section 9 is a bullet list, so "decision 2" names its "Exact database schema
and ORM/migration tooling" item, in the engine-and-tooling half. The exact
schema is settled per phase by the spec that adds tables and is not this
record's subject. The language-and-layout half is decision 1, recorded in
`0002-implementation-language-and-layout.md`.

Numbering: this record was commissioned as `0002-<slug>.md`. `0001` was already
taken by `0001-history-storage-and-layout.md`, so both records commissioned
together shifted up one slot. The number is a filename, not the section 9 item.

## Decision

The database engine is PostgreSQL (currently `postgres:16-alpine`),
self-hosted: it runs as the `history-db` service in this repo's own
`docker-compose.yml`, on the owner's own Docker host, bound to `127.0.0.1`, on
an external named volume that `docker compose down -v` cannot remove. It is not
a managed or hosted database and never becomes one without a new decision.

Migrations are versioned with drizzle-kit, generated from
`packages/db/src/schema.ts` into committed plain `.sql` files under
`packages/db/migrations/` with a journal. Schema changes are generated,
reviewed and committed as SQL; nothing applies a schema change implicitly at
runtime.

Attribution matters here and is stated precisely, because
`0001-history-storage-and-layout.md` requires it: the owner chose the engine in
their own words ("typescript / node / postgresql"), with the umbrella file
`work/specs/S0002-deal-sentinel-history-1/operator-decision-section-9-language-and-storage.md`
as the record of authority (as named by `0001`, which is where this file takes
it from). The migration tool was selected from options offered to the owner and
must not be cited as the owner's own words.

## Reasoning

1. Section 5 states the merit directly: "PostgreSQL is the recommended default:
   relational joins for products/listings/rules plus perfectly adequate
   time-series performance at this scale, and the owner knows it." The query
   this system exists to answer is relational in shape - a listing, joined to
   its rule config, against a window of its own history - and the scale is
   personal-use, which is far inside what a single Postgres instance handles
   without tuning.

2. Rejected: SQLite. Section 5's stated merit for it is genuine - "SQLite is a
   legitimate lighter choice for a single-container MVP" - and it loses because
   the store is precisely the part of this system that is not MVP-shaped. Price
   history cannot be backfilled: the page a row came from is gone a week later,
   so the store outlives every component around it and is the one asset a later
   rewrite cannot recreate. That argues for the engine that will still fit in
   three years, not the one that fits the first container. Concretely, the
   collector, the rule evaluation, the backup script and any dashboard reading
   the same data are separate processes; a server engine serves concurrent
   readers alongside a writer as a matter of course, where SQLite's
   single-writer model plus a file on a shared volume makes that a thing to
   engineer around. Section 5 also recommends a dashboard reading the database
   directly, and a server engine keeps both the Grafana-only and the custom-UI
   options open (which of those happens is section 9's own open question, not
   decided here). Migrating the one irreplaceable table later, under load, is
   exactly the migration worth not needing.

3. Rejected: TimescaleDB now, and InfluxDB at all. Section 5: "TimescaleDB is a
   zero-regret later upgrade if the history table ever feels slow; InfluxDB
   adds a second query model for little benefit here." Timescale is therefore
   deliberately deferred rather than refused - it is an extension over
   Postgres, so choosing Postgres today is what keeps that upgrade cheap. Influx
   is rejected on section 5's own reasoning: a second query language and a
   second operational surface, bought for performance headroom this workload
   does not need.

4. Rejected: managed or hosted Postgres (the Neon / Supabase / RDS class),
   including their free tiers. Constraint 5 requires that the system "Runs on
   the owner's infrastructure. Docker on a Proxmox VM/LXC; data survives
   restarts; nothing exposed beyond the LAN by default" - a hosted database is
   off that infrastructure by definition. Constraint 1 forbids the paid tiers
   outright. A free tier would be nominally $0/month, but it puts the one
   irreplaceable asset in this project on a third party's terms of service,
   where a retention limit, an idle-project policy or a tier change can delete
   history that cannot be recreated, and where the price of keeping it is a
   later upgrade to a paid plan. Self-hosted Postgres is free, on-infrastructure
   and durable on the owner's own volume, so the $0/month-compliant option is
   also the best-fitting one here: no paid option is being passed over on merit,
   and there is nothing to escalate to the owner under constraint 7.

5. Migration tooling: drizzle-kit, chosen for what it emits rather than for its
   query API. Its rationale of record, restated from
   `0001-history-storage-and-layout.md` and from `packages/db/drizzle.config.ts`:
   it generates plain `.sql` migration files, which `pg_dump` and `pg_restore`
   round-trip cleanly, keeping the schema loosely coupled to the restore proof.
   Two alternatives were considered and rejected:
   - Hand-written SQL with no tooling. Rejected for having no journal and no
     generated-from-schema check, so drift between the declared schema and the
     applied one is invisible until a restore fails.
   - An ORM that owns the schema at runtime and applies changes implicitly on
     boot (the `db push` / auto-migrate pattern). Rejected because
     initialization of the history database here is a deliberate one-time act
     (`pnpm db:init`) guarded by a start-up check (`pnpm db:start-check`) that
     refuses to start without the completed-initialization marker. A tool that
     silently mutates the schema at boot is the exact failure mode that guard
     exists to prevent.

6. Constraint 7, explicitly: this decision spends nothing and loosens nothing.
   PostgreSQL and drizzle-kit are free and open source, and the engine runs in
   a container on hardware the owner already owns and already powers, so the
   recurring cost is $0/month and constraint 1 is untouched. Constraint 5 is
   tightened rather than loosened: the port is published on `127.0.0.1` only,
   so the database is not reachable from the LAN at all, and the data volume is
   external so an ordinary stack reset cannot take the history with it. No
   other section 2 constraint is in contact with a storage engine: new retail
   only, public data only, personal-use volumes and the PA-API prohibition are
   all untouched by where rows are kept. There is nothing here that requires
   asking the owner first.

7. Constraint 4 (personal-use volumes and the household's home IP) touches this
   decision only indirectly, and the decision deliberately keeps it that way.
   The engine is loopback-bound and speaks to nothing outside the host, so it
   adds no third-party request traffic and no new surface against the
   residential IP. The one real connection runs the other way: a durable,
   queryable history is what lets cadence, cooldowns and "have we already seen
   this price today" be answered from stored rows instead of re-fetching a
   retailer's page, so the store is part of what keeps request volume low. That
   is also a test this decision had to pass: an engine implying a network
   round-trip off the household's connection per observation would have been an
   argument against it on constraint 4 grounds as well as constraint 5. Neither
   PostgreSQL as deployed here nor SQLite would have done that; the hosted
   option in point 4 would have.

## Not a deciding factor

- Benchmark throughput. At personal-use volumes both candidate engines are
  orders of magnitude faster than the workload; neither was chosen for speed.
- ORM ergonomics. Drizzle is here for the plain `.sql` files it emits and the
  restore path that depends on them, not for the shape of its query builder. A
  different tool with the same output property would have been acceptable.
- Future scale. This is a household tool with a bounded watchlist; no growth
  projection was used as an argument.

## Not decided here

Nothing else in section 9 is settled by this record: not the exact schema
beyond the tables an implemented phase already carries, not queue-versus-plain
scheduling or whether Redis is introduced, not the notification channels or
alert format, not which JSON-LD retailers are onboarded first or whether Target
lands in the MVP, not whether Amazon is included at all, not Grafana-only
versus a custom UI, and not when (if ever) the one-time proxy top-up is bought.
