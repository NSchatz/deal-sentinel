# deal-sentinel

A self-hosted price watcher on the owner's homelab: it tracks new-retail listings
across several retailers, builds price history indefinitely, and notifies only
when history says something is genuinely a good deal. BRIEF.md is the guiding
document. It states goals, hard constraints and research findings, and it
recommends rather than decides.

This file was written from BRIEF.md rather than supplied with it. Where the two
disagree, BRIEF.md wins and this file is wrong.

## Working agreement

1. BRIEF.md section 2 is the hard constraint list and is not negotiable: $0/month
   recurring, new retail only, public data only (never behind a login, never
   bypassing auth or captchas), personal-use volumes with jitter, runs on the
   owner's infrastructure, no Amazon PA-API (retired 2026-05-15). Spending
   anything or loosening any of these means asking the owner FIRST.
2. Everything labeled recommendation, option or consider is a default you may
   override with a stated reason. Section 9 lists what is deliberately open.
3. Surface significant design choices as you go. Do not silently lock one in.
4. Per-site code is the part that breaks. Keep every retailer behind a common
   adapter interface, keep parsers pure, and test them against saved fixtures,
   because "site changed, save new fixture, fix parser" is the maintenance loop.
5. Prefer structured sources in this order: official API, stable JSON endpoint,
   embedded JSON-LD, CSS selectors. A headless browser is an escalation.
6. Over-alerting is the failure mode that kills these tools. Every alert carries
   its reason; cooldowns and seasonal suppression are features, not polish.
7. Money is integer cents and timestamps are timezone-aware, in every store.
8. Rate ceilings, thresholds and cooldowns must exist, be conservative, and be
   configurable. The brief deliberately fixes no numbers; do not invent one and
   then treat it as decided.

## Exit codes

Every command this repository publishes answers with one of these, and every
one of them prints this table in its own `--help` (`cli` L1, L1a, L5). The
numbers are deal-sentinel's own: 1 is fixed by Node, which returns it for an
uncaught exception; 2 and 3 are fixed by `packages/db/scripts/backup.sh`,
`packages/db/scripts/restore.sh` and
`docs/decisions/0005-container-image-pinning.md`; 4 is the first free number
below the band Node produces for real programs. What binds is the distinctness,
not the digits.

| code | meaning |
|---|---|
| 0 | it ran and the answer is yes |
| 1 | it could not run or could not finish |
| 2 | the caller got the invocation wrong |
| 3 | it ran, every input was legible, and a constraint said no |
| 4 | it ran and found what it looks for |

The distinction that carries the value is 1 against 3. A scheduler retries "it
could not run" and obeys "it ran and the answer is no", so a command returning
the same code for both makes a check that never executed indistinguishable from
a check that passed. Reserved and never assigned a meaning here, because Node
produces them for real programs: 9, 13, and anything above 128.

`packages/shared/src/exit-codes.ts` holds the one copy of the numbers, their
wording and the help renderer.

## This repo is a submodule of the SDD umbrella

Everything above governs the code. This section is the umbrella's half of the
contract, and it binds any session that reaches this checkout:

- Work here arrives as an approved spec and rides the umbrella stages. A change
  made directly in this checkout with no spec is invisible to the ledger and will
  not land: `just land` moves the pin, nothing else does.
- Tier floor is `sensitive` (`documentation/tier-map.md` in the umbrella). It is
  a FLOOR: a spec that spends money, loosens a section 2 constraint, or raises a
  request ceiling against an anti-bot-protected target proposes `critical` and
  takes the human gate. Constraint 7 is not softened by any tier.
- The direction lives in `documentation/roadmaps/deal-sentinel.md` on the
  umbrella side, derived from BRIEF.md section 6. A spec cites a phase as
  `deal-sentinel#<phase-id>` and INHERITS its acceptance rather than restating
  it, so the brief stays the one source of truth for what a phase means.
- BRIEF.md is the owner's document. When the landscape moves under it (an
  endpoint dies, a free tier changes), say so and propose the change; do not
  silently edit the brief.
