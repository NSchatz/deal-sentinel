# 0005: A durable breaker-pause record, and a display path that binds loopback

Status: decided
Decision owner: the implementer, from BRIEF.md
Resolves: nothing BRIEF.md section 9 leaves open. Both halves are consequences
of making the system observable at all, and both were forced by the shape of
what was already here
Recorded by: S0042-deal-sentinel-ops-5

Attribution, precisely, because `0001-history-storage-and-layout.md` requires
it: the owner said nothing about either subject. BRIEF.md section 9 decision 10
leaves "Grafana versus a custom UI" open and this record does not close it - what
it decides is narrower and lower down. Neither half below may be cited as the
owner's own words.

## Decision

**A breaker pause is written down, in the history database, at the moment the
breaker announces it.**

`Breaker` keeps everything in a `Map` keyed by source, in one process, and
resumes lazily when `status()` is next asked. That is the right shape for a
gate: it is read on the hot path, before every send, and a gate that reached a
database to answer would be a gate that could be slow or absent at the moment it
is most needed. But it means "this source is paused" exists NOWHERE a second
process can see it, and the phase this record belongs to is entirely about a
second process seeing things.

So the pause becomes a row, and the three properties that matter are all
properties of WHERE it is written rather than of care at a call site:

- it is written from `Breaker.record`'s return value, which is the one place a
  pause is announced. That is what already makes "notify once per pause" true,
  and the row inherits it. Anything that polled `status()` instead would write a
  row for every request that arrived behind the pause;
- it carries `expires_at` rather than a duration, so whether a source is paused
  RIGHT NOW is a comparison a reader makes against its own clock. An expired
  pause reads as resumed on the very next read, with no restart, no sweep job
  and no manual reset, and the expired row stays exactly where it is as history;
- it carries the condition IN PARTS - the failing count, the total in the
  window, the window and the threshold - beside the sentence. A record that only
  carried the sentence would leave a later reader parsing English to answer
  "what threshold was in force when this fired", and the answer would change
  shape the next time somebody edited the wording.

The in-memory breaker is NOT replaced and is not read from the database. The
gate stays exactly as fast and exactly as available as it was; the row is a
consequence of a decision, never an input to one.

**The operator view is a local, read-only process that binds ONE address, and
the committed configuration names a loopback one.**

This is the first listening socket this system has ever had and its first
display path, and both are exposures the rest of the system does not have:

- the sanctioned API takes its credential in the query string and echoes the
  whole URL back inside its own response body, so every recorded condition,
  refusal detail and stop reason is derived from a string that carried a key.
  The write path redacts; the display path redacts AGAIN, because a row written
  by an older build, restored from a dump, or pasted in by hand is still a row a
  page would otherwise show. Redacting twice costs a string scan. Redacting once
  costs a credential published to whatever can reach the socket, and no re-run
  undoes that;
- so `config/dashboard.json` names `127.0.0.1`, and the loader REFUSES `0.0.0.0`
  and `::` outright. A wildcard is not an address the configuration names; it is
  every address the machine has. A specific non-loopback address is permitted,
  because the owner is entitled to put this on their own LAN deliberately, and
  the start check says out loud when the configured address is not loopback.
  There is no authentication, no TLS and no accounts, and that is stated rather
  than implied;
- the process READS. Every query is a SELECT, a method that is not GET or HEAD
  is refused before the router runs, and the allowance is read AS ROWS rather
  than through `AllowanceLedger.check` - which announces the stop when it finds
  the counter at its limit, claiming the period's once-only mark and emitting
  its one notification. A page that read the allowance through the ledger would
  spend the mark it was reading and notify the owner every time they opened it;
- the process CANNOT SEND. It holds no governor, no adapter and no transport.
  The single binding it takes from `node:http` is `createServer`, and the
  repository-wide chokepoint proof was taught the difference between a server
  and a client as a RULE - an import binding only server-side names is not a
  client import, anywhere, for anybody - rather than by adding a fourth path to
  its allowlist. An allowlist entry says "this file may name a client", which is
  exactly the wrong claim about a file that serves.

**Content on that page carries its source's attribution, or the value is not
shown.** `packages/sources/src/attribution.ts` already REFUSES an emission that
lost its notice rather than composing one, and the view uses that module rather
than writing a notice beside it. A source this build cannot find in the registry
is a source whose terms this build cannot establish, and "we could not tell" is
not a licence to show the price anyway: the value is withheld and the page says
why.

**Every number this view judges by is configuration with no built-in default.**
The staleness horizon a source is called BROKEN against, the period the rates
are computed over, the default chart range and the bind address are all in
`config/dashboard.json`, and the process refuses to start if any is missing.
CLAUDE.md rule 8 forbids inventing a number and then treating it as decided, and
a horizon buried in code is exactly that with the decision hidden: set it too
long and a dead source reads as quiet, which is the failure this phase's own
fail-safe names.

## Why

1. The phase is placed before the first scraped breadth on purpose. Block rate
   is what says whether the politeness ceilings are right, and adding retailers
   without it is tuning blind. That is only true if the block rate is READABLE,
   which means durable, which means a database.

2. The three states an operator can confuse cost different things and want
   different actions, so they are three columns and three sentences and never
   one: a breaker pause is this system's verdict about a source, an exhausted
   allowance is this system's own budget, and a `source_period_stops` row is the
   vendor's verdict about us. Only the last one is a reason to go and read
   somebody's terms.

3. A source with no recent successful fetch reads as BROKEN and not as quiet.
   That is the roadmap phase's own fail-safe and it is the direction that costs
   an owner a wasted look rather than a month of silent data loss.

4. A source with no record at all inside the period reads as NO DATA and not as
   a zero error rate. Printing 0% would be this system inventing evidence of its
   own good behaviour out of the absence of evidence.

5. Rejected: a metrics endpoint plus somebody else's dashboard. It is the
   obvious shape and it fails the same test twice - it needs a second process
   the owner has to run and keep, and constraint 1 makes anything with a
   recurring cost a non-starter while a self-hosted one is exactly the
   babysitting BRIEF.md section 6 is trying to avoid. It also moves the
   redaction problem into somebody else's renderer.

6. Rejected: no durable pause, and inferring a pause from the fetch outcomes.
   The inference is available - a run of failures then a gap - but it is an
   inference, it cannot state the threshold that was actually in force, and it
   would silently change meaning the next time the breaker's settings changed.

7. Rejected: a text or JSON dump instead of a rendered page. The fourth phase
   assertion asks for a time series, and a chart is what makes a price history
   legible at a glance. A rendered page also puts the attribution obligation
   where it belongs, which a JSON payload consumed by something unknown does
   not.

8. Constraint 7, explicitly: this decision spends nothing and loosens nothing.
   It adds NO outbound request of any kind - nothing in the dashboard package
   can send, and the chokepoint proof holds with no new module on its allowlist
   - so constraint 4 is untouched in the direction that matters. Constraint 5 is
   satisfied by construction: it runs on the owner's own machine, on loopback.
   The migration that supports it is additive, so constraint 6's irreplaceable
   thing, the price history, is not put at risk by it.

## Not a deciding factor

- What the page looks like. The styling is small, inline and unopinionated; the
  criteria are about what is SHOWN and what is not, and none of them is about
  taste.
- Which charting library. None is used and none was considered seriously: the
  series is a handful of points and an inline SVG built from the stored integers
  needs no dependency, no build step and no float on the way to the screen.
- Grafana versus a custom UI, which BRIEF.md section 9 decision 10 leaves open.
  Nothing here forecloses it: the tables this phase adds are ordinary SQL, and
  an owner who later wants a general-purpose dashboard can point one at them.

## Not decided here

Whether this view is the view the owner keeps. It is deliberately small, and the
thing it makes possible - a durable, queryable record of what this system did to
third parties - outlasts whichever renderer sits on top of it. Nor is anything
decided about ALERTING over telemetry: no rule, no threshold and no notification
is derived from any of these tables, and `packages/alerts` is untouched.
