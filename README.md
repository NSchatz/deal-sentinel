# deal-sentinel

A self-hosted price watcher for the homelab. It tracks new-retail listings (tools, furniture, building materials) across several retailers, keeps their price history indefinitely, and notifies only when history says a price is genuinely good: a historical low, an unusual drop, a clearance signal, or a known buying window.

History is the product. A price change is not news; a price that is the lowest in a year is. Every alert carries the reason it fired, because over-alerting is what kills tools like this.

Runs entirely on the owner's infrastructure at $0/month recurring, against public data only, at personal-use request volumes. Those are constraints, not goals: see `BRIEF.md` section 2.

- `BRIEF.md` - the guiding document: vision, hard constraints, the retailer landscape by difficulty tier, capabilities, architecture recommendations, milestones, and the decisions left open.
- `CLAUDE.md` - the working agreement, and how work reaches this repo through the SDD umbrella.
- `docs/decisions/` - one file per significant decision. `docs/fixtures-notes/` - what broke, what the recapture was, so the next repair is shorter.

Status: phase `ALERT-4`. The loop is closed end to end: one sanctioned source
collects prices under its own published terms, history accrues, a rule over that
history decides a price is worth interrupting somebody for, and a notification
says why. Nothing is delivered until the owner configures a channel, which is
the fail-closed default and not an oversight.

## What exists

TypeScript on Node, PostgreSQL, Drizzle. Six packages behind
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
- `packages/db` - the price observation table and its migrations, the write
  path (which takes an `ExtractionResult` and writes nothing at all when it is a
  failure), the one-time initialization action, the start-up check, the backup
  and restore scripts, and the governor's durable allowance counter.
- `packages/governor` - the one fetch chokepoint. Every outbound HTTP request
  this system will ever make goes through `Governor.request`, which applies the
  destination host's configured ceiling and a randomised delay, decides the path
  against that host's `robots.txt`, honours `Retry-After` in both legal forms,
  breaks a failing source rather than hammering it, and counts every request
  that leaves against that source's allowance. Exactly one module in this
  repository may reach an HTTP client, and
  `test/unit/no-direct-http.test.ts` fails the suite if a second one appears.
- `packages/sources` - the sources a price actually comes from: what each
  source's published terms require, what the owner configured for it, the
  adapters behind one common interface, the collection run over the watchlist,
  the raw-content retention job, and the attribution a display or export path
  must carry. Every adapter takes a `Governor` and reaches the network only
  through it.
- `packages/alerts` - the rules over stored history, the notification each
  firing composes, the durable per listing-and-rule cooldown that keeps them
  rare, and the one operator-configured delivery channel. A rule is a pure
  decision over an observation, a history window and its own configuration: no
  clock, no randomness, no database, no environment. It depends on the db
  package and the governor, and on nothing that knows which retailer a price
  came from.

## The first real source, and the terms it runs under

One retailer publishes an official API, and this is the package that reads it.
Three facts shape everything in it:

- **The terms are part of the interface.** That vendor's terms cap how long its
  Content may be cached at seventy-two hours, require its content to be
  "clearly and conspicuously" attributed wherever it is shown, and publish a
  rate limit of 5 calls per second and 50,000 per day whose documented answer to
  an excess is a 403. All four are honoured in code, and what the TERMS say
  lives in `packages/sources/src/terms.ts` - quoted, with its source beside it -
  while what the OWNER chose lives in `config/sources.json`. They are separate
  files on purpose: if both facts lived in one document, a source configured
  with no retention ceiling and a source whose terms declare none would be
  indistinguishable.
- **The watchlist is the only input.** A collection run reads `watchlist_entries`
  and nothing else to decide what to fetch, so "attempted no listing that is
  absent from the watchlist" is a property of the query rather than of care at
  a call site.
- **The credential never leaves the request.** That vendor takes its API key in
  the query string, so the key is in every URL - including the one the vendor
  echoes back inside its own response body as `canonicalUrl`. Every string that
  leaves the package is scrubbed twice: once for the secret itself, and once for
  the query parameter whatever its value is. Nothing reaches a stored row, a
  notification body or a log line.

Two settings are DECLARATIONS rather than readings, because the vendor publishes
neither anywhere: the ISO 4217 currency, which decides the minor-unit exponent
and so decides the NUMBER and not just a label, and the source's IANA local time
zone, which is stored beside every instant because a 90-day low is anchored to
the retailer's local day, and which is also how a zone-less vendor timestamp
becomes an instant at all. A source configured without either does not run.

```sh
pnpm sources:start-check   # checks config/sources.json against each source's
                           # published terms, and config/governor.json's
                           # ceilings and allowances against their published
                           # rate limits, or refuses
```

Nothing in this repository makes a live request to that vendor - not a test, not
CI, not a development session. Every criterion is graded against saved payloads
in `test/fixtures/bestbuy/` and a stubbed transport.

## The alerts, and the two things this repository refuses to decide

An alert is the whole point of keeping the history, and a stream of them is what
kills tools like this one. So rarity is built in rather than tuned in later: a
rule is not evaluated against a listing that holds fewer observations than its
own configured minimum, and a rule that has fired for a listing stays quiet for
its configured cooldown, durably, so a container that restarts does not re-send
this morning's news every hour.

Every notification carries the rule that fired, the observed price with its
ISO 4217 currency, the reference price it beat with its currency, and a link to
the listing. The link is the OWNER'S, taken from the watchlist entry: nothing
here can derive a page a human opens, and a listing with no link is reported by
name rather than alerted on with a fabricated one.

Two things are deliberately not decided here, and `docs/decisions/0004-...` says
why at length:

- **which channel.** `config/alerts.json` carries an endpoint, a method, static
  headers, optional headers for the title and the link, and a credential read
  from a named environment variable. The committed file carries no endpoint, so
  nothing is delivered until the owner sets one. Delivery goes out through
  `Governor.request` like everything else, which means the notification host
  needs its own ceiling in `config/governor.json` or the first gate refuses it.
- **which price endings mean clearance.** The community ladder is unreliable by
  `BRIEF.md`'s own account, so the endings are an operator list, empty as
  committed, and a match is a corroborating tag on a notification some rule
  already fired. It cannot trigger one, and there is no code path by which it
  could.

```sh
pnpm alerts:start-check   # every rule with its window, minimum and cooldown,
                          # and whether a channel is configured at all. Reads
                          # two committed files and contacts nothing
```

The numbers in `config/alerts.json` are conservative and UNVALIDATED, and the
file says so: thresholds, windows and cooldowns are outputs of living with the
system, and `BRIEF.md` fixes none of them.

## The governor, and why it exists before the second source does

`BRIEF.md` constraint 4 is "personal-use volumes ... Part of the point is
keeping the household's home IP in good standing". A block earned against a
residential address is shared by everyone in the house, a burned free allowance
does not come back, and no re-run undoes either. So the request path is one
place, and it is where every rule lives:

- **A ceiling per host, and a randomised delay on every release.** A host with
  no configured ceiling is REFUSED. There is no default-permissive rate and no
  built-in number anywhere in the package.
- **`robots.txt`, with the asymmetry the standard specifies.** A 404 means the
  host carries no rules and may be fetched (RFC 9309 2.3.1.3). A 500, a timeout
  or a connection failure means the file is undefined and the host is COMPLETELY
  DISALLOWED (2.3.1.4). Decisions are cached, bounded by configuration that may
  not exceed 24 hours (2.4), and the file is parsed up to a limit that may not
  be configured below 500 KiB (2.5). That bound is enforced where the request
  LEAVES, not where it was admitted: a request that waited out a ceiling, a
  delay or a `Retry-After` hold has its decision re-asked on the far side of
  every wait, and where no instant can satisfy both a fresh decision and the
  host's own back-pressure the request is REFUSED rather than sent under rules
  this system has declared expired.
- **Back-pressure, both legal forms.** `Retry-After: 120` and
  `Retry-After: Fri, 31 Dec 1999 23:59:59 GMT` are both read (RFC 9110 10.2.3).
  A 429 with no header, a value that will not parse, or one naming an instant
  already past all take the configured back-off - never an immediate retry.
- **A breaker per source.** A source whose error-or-block rate crosses its
  configured threshold is paused for its configured interval and notified once;
  every other source keeps running.
- **An allowance per metered source**, counted centrally, warned once at the
  configured fraction, stopped (not slowed) at the allowance, and stored in
  PostgreSQL so a crash loop inside a period resumes the count instead of
  spending it twice. A unit is SPENT rather than checked: one statement in the
  store takes it if and only if the resulting total is still inside the limit,
  and the request leaves on that answer. Nothing reads the counter and decides,
  because requests for one source on different hosts are not serialised with one
  another - by design, so that one host at its ceiling never holds up another -
  and a counter that is read and then written is overspent by however many of
  them are offered at once.
- **No second way out.** The package exports nothing that can send: a caller
  that wants the real HTTP client asks for the `LIVE_TRANSPORT` marker, which
  has no `send` and which only a `Governor` can redeem, on the far side of all
  six gates above. `test/unit/no-direct-http.test.ts` scans every source file in
  the tree and fails the suite on any ordinary spelling of a client outside one
  allowlisted module - a call, a property of any object, an alias, a
  destructure, an import, or the name as a string.

Configuration lives in `config/governor.json` and every value in it is required:
absent, unparseable or incomplete configuration makes the process refuse to
start, naming the key.

```sh
pnpm governor:start-check              # reads config/governor.json, or refuses
pnpm governor:start-check path/to.json
```

The numbers in the committed file are conservative and UNVALIDATED, and the file
says so. `BRIEF.md` fixes no rate ceiling and neither does this phase: what is
proved here is that the ceilings are ENFORCED, not that they are right.

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
`test/integration/governor-allowance-restart.test.ts` is the same idea for the
allowance counter: it spends part of a period through one governor, throws that
process away, and asserts the next one continues the count.
`test/integration/alert-cooldown-restart.test.ts` is the same idea again for the
alert cooldown, and `test/integration/alert-run.test.ts` reads the whole
observation table before and after an evaluation run and compares it column for
column, because the run that reads the history is the one place worth proving
does not write to it.

The whole suite reaches nothing outside the loopback interface. Every robots,
back-pressure and breaker case runs against a stub HTTP server this suite starts
on 127.0.0.1, and the local PostgreSQL container is the only other endpoint any
test touches. No test reaches a real retailer, on purpose: proving a rule about
third parties by bothering one would be the defect these rules exist to prevent.

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

The database image is pinned by tag AND digest everywhere it is named - the
compose service, both database scripts, and the integration harness. The pin,
where the digest came from, and the one command that re-resolves it are in
`docs/decisions/0005-container-image-pinning.md`; `test/unit/pinning.test.ts`
reds inside `pnpm test:unit` if a reference loses its digest, and an override
of `HISTORY_PG_IMAGE` or `HISTORY_TEST_PG_IMAGE` that carries none is refused
with exit status 3 rather than run.

Backups:

```sh
HISTORY_DATABASE_URL=... pnpm db:backup                 # -> backups/....dump
HISTORY_DATABASE_URL=... pnpm db:restore backups/....dump
```

Both scripts run `pg_dump`/`pg_restore` from the pinned postgres image when the
client binaries are not installed on the host (`HISTORY_PG_RUNNER=docker`),
which is the homelab case.
