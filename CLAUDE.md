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
