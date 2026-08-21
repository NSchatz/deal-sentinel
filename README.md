# deal-sentinel

A self-hosted price watcher for the homelab. It tracks new-retail listings (tools, furniture, building materials) across several retailers, keeps their price history indefinitely, and notifies only when history says a price is genuinely good: a historical low, an unusual drop, a clearance signal, or a known buying window.

History is the product. A price change is not news; a price that is the lowest in a year is. Every alert carries the reason it fired, because over-alerting is what kills tools like this.

Runs entirely on the owner's infrastructure at $0/month recurring, against public data only, at personal-use request volumes. Those are constraints, not goals: see `BRIEF.md` section 2.

- `BRIEF.md` - the guiding document: vision, hard constraints, the retailer landscape by difficulty tier, capabilities, architecture recommendations, milestones, and the decisions left open.
- `CLAUDE.md` - the working agreement, and how work reaches this repo through the SDD umbrella.
- `docs/decisions/` - one file per significant decision. `docs/fixtures-notes/` - what broke, what the recapture was, so the next repair is shorter.

Status: phase 0. Nothing is built yet.
