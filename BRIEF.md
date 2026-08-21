# Deal Sentinel: Project Brief and Architecture Guide

Version: 2.0 (August 2026). Replaces the prescriptive v1.x spec. This document is intentionally high-level: it states goals, hard constraints, and research findings, and offers recommendations rather than decisions. The implementer (Claude Code, working with the owner) chooses the concrete design.

How to use this document: Treat "Constraints" (Section 2) as non-negotiable requirements. Treat everything labeled "recommendation," "option," or "consider" as a default you may override with a stated reason. Surface significant design choices to the owner as you go rather than silently locking them in. Section 9 lists decisions deliberately left open.

## 1. Vision

A self-hosted service on the owner's homelab that watches prices for new retail products the owner cares about (tools, furniture, building materials), builds up price history over time, and sends a notification when something is a genuinely good deal: a historical low, an unusual drop, a clearance event, or a known buying window. It should narrow the deal hunt, not replace judgment. Owner context: professional TypeScript/Node engineer, Proxmox homelab with Docker, Home Assistant on the LAN, located in the Woodstock, GA area (store-level pricing for nearby stores is relevant, since clearance is store-specific).

What "good" looks like after a few months of running:

- A watchlist of tracked products across several retailers, each with visible price history.
- Notifications that are rare, trustworthy, and always explain why they fired.
- Near-zero babysitting for the stable data sources, and a known, quick repair routine for the fragile ones.

## 2. Hard Constraints (requirements, not suggestions)

1. $0/month recurring. No subscriptions, no paid API plans, no paid tiers of anything. Free tiers of legitimate services are fine. The single allowed exception: an optional, one-time, pay-as-you-go residential proxy top-up (traffic that never expires), and only if a target actually blocks the home IP.
2. New retail only. No secondhand marketplaces, no auction tooling, no automated purchasing.
3. Public data only. Never scrape behind a login, never create accounts for scraping, never bypass auth, paywalls, or captchas by credentialed means. This is both the legal comfort line (US case law around hiQ v. LinkedIn and Van Buren supports low-volume collection of public data) and the project's ethic.
4. Personal-use volumes. Polite request rates with jitter, small daily totals per site. Part of the point is keeping the household's home IP in good standing.
5. Runs on the owner's infrastructure. Docker on a Proxmox VM/LXC; data survives restarts; nothing exposed beyond the LAN by default.
6. Do not build on Amazon's PA-API. It was deprecated April 30, 2026 and retired May 15, 2026. Any PA-API code is dead on arrival.
7. Spending or loosening anything above requires asking the owner first.

## 3. The Data Landscape (research findings, current as of mid-2026)

Think of retail sources in difficulty tiers. Recommendation: build from the top of this list downward, so easy wins fund the motivation for hard ones.

### Tier 1: friendly (start here)

- Best Buy: a real, free, official developer API with product pricing, sale/clearance flags, and availability. The easiest win in the whole project.
- JSON-LD retailers: many mid-size sites embed schema.org Product/Offer data in their pages (observed working: Harbor Freight, Northern Tool, Acme Tools, Rockler, Woodcraft, IKEA, West Elm). One generic extractor with small per-site presets can cover all of them. Sitemaps make product discovery easy.
- Signal feeds (not prices, but deal intelligence): Slickdeals search RSS (append `&rss=1` to a search URL), DealNews RSS, and a lumber commodity index from the free FRED API (retail dimensional lumber follows the index with a lag, useful for timing framing/plywood/OSB purchases).

### Tier 2: unofficial but accessible

- Target: the site runs on a public-facing JSON API ("RedSky") whose key is embedded in page source. Supports store-level pricing via store/zip parameters, which matters for clearance. Parameters drift occasionally; captchas appear if you look like a datacenter. A residential home IP at polite volume is usually fine.
- Menards 11% rebate detection: the signature building-materials event, recurring roughly monthly, never pre-announced. Detecting it (a simple page check for the promo) is more valuable than predicting it; Home Depot and Lowe's price-match the ad in-region for an instant 11%.

### Tier 3: hard (Akamai-protected; expect maintenance)

- Home Depot and Lowe's: both behind Akamai Bot Manager. Home Depot's site is powered by an internal GraphQL gateway that is store-aware; replicating a browser's request (captured from devtools) through a TLS-impersonating client is the established DIY approach. Expect it to break every few weeks to months, with a repair loop of an hour or two. Pricing and clearance are store-specific, which is exactly why these targets are worth the effort.
- Wayfair: strong anti-bot; recommend deferring indefinitely and relying on sale-calendar knowledge plus spot checks.
- Amazon: with PA-API gone and Keepa's API costing ~EUR 49/month (violates constraint 1), the honest options are a fragile low-volume DIY page scraper for a handful of ASINs, or skipping Amazon and tracking equivalents elsewhere. Recommendation: skip in v1; Slickdeals RSS surfaces most Amazon deal events anyway, and Keepa/camelcamelcamel websites remain free for manual history lookups.

Free fallback utility: SerpApi's free tier (250 searches/month) includes Home Depot and Walmart engines at no surcharge; useful as an ad-hoc price check and as a stopgap when a DIY scraper is broken. Never upgrade it to paid.

Anti-bot, in one paragraph: modern bot defense (Akamai especially) keys primarily on TLS/HTTP2 fingerprints, secondarily on sensor cookies, IP reputation, and behavior. Practical countermeasures, in escalating order of effort: browser-impersonating HTTP clients (the curl_cffi / tls-client family) with current Chrome profiles; cookie jars seeded from a real browser session; real-browser automation that hides automation fingerprints (nodriver/zendriver, Camoufox, Patchright; avoid the deprecated puppeteer-stealth). The home IP is already residential; a PAYG residential proxy (DataImpulse is ~$1/GB, non-expiring) is the escalation if the home IP gets blocked. Datacenter proxies are pre-burned against Akamai/Cloudflare and are a waste of money.

## 4. What the System Must Do (capabilities, not implementations)

1. Collect prices on a schedule, per tracked listing, with per-site politeness (rate ceilings, jitter), retries, and a way to pause a misbehaving source automatically (some form of circuit breaker on block/error rates).
2. Store every observation as a time series per listing (product x retailer x optional store), keeping history indefinitely; history is the product's core value. Record enough raw context to debug parser breaks.
3. Detect deals with rules that compare against history, not just "price changed." Ideas worth supporting (pick and tune during implementation): all-time/365-day/90-day lows; drops vs a rolling average; statistical outliers (z-score style) to cut noise; absolute target prices; back-in-stock; clearance signals. Two pieces of domain nuance: (a) seasonal sale windows (below) should raise the bar for ordinary percent-drop alerts so routine holiday sales don't page the owner, while true historical lows always alert; (b) Home Depot's famous clearance price-ending ladder (.06/.03/.02/.01) is community lore that is widely reported unreliable in 2026, so endings should only ever be a weak corroborating tag, never a trigger on their own. Penny items never display correctly online.
4. Notify with the reason attached (rule, current price, reference price, link), on channels the owner already lives in. Cooldowns per listing/rule so nothing spams.
5. Observe itself: fetch success/block rates per source, quota usage for free tiers, and easy price-history visualization.

Seasonal calendar to encode (informational): tools peak at Black Friday/Cyber Monday, Father's Day, spring, Prime Day (July), Labor Day; furniture peaks at Memorial Day and Labor Day (largest), Presidents' Day, July 4th, Wayfair's Way Day, Black Friday; building materials are driven less by calendar and more by Menards 11% windows and commodity lumber moves.

## 5. Architecture Considerations and Recommendations

Each area below lists reasonable options and a recommended default. None of these are mandates.

Language and structure. TypeScript/Node matches the owner's daily stack and is the recommended core. Python has the stronger scraping ecosystem (curl_cffi, zendriver); a pragmatic pattern is a TS core with a small Python sidecar service for browser-impersonated fetching, but a pure-TS or pure-Python build are both defensible. Monorepo vs single service: implementer's choice; keep retailer integrations isolated behind a common adapter interface either way, because per-site code is the part that breaks and gets replaced.

Storage. PostgreSQL is the recommended default: relational joins for products/listings/rules plus perfectly adequate time-series performance at this scale, and the owner knows it. SQLite is a legitimate lighter choice for a single-container MVP. TimescaleDB is a zero-regret later upgrade if the history table ever feels slow; InfluxDB adds a second query model for little benefit here. Whatever the store, keep money as integer cents and timestamps timezone-aware.

Scheduling and jobs. Options span plain cron containers, node-cron in-process, or a real queue (BullMQ + Redis) with per-source rate limiting, retries, and backoff. Recommendation: start as simple as possible for the MVP; adopt a queue when per-retailer rate control and retry semantics start feeling hand-rolled. Temporal-class orchestration is overkill.

Fetch layer. Recommend a per-retailer adapter pattern: each adapter declares its strategy (official API, JSON endpoint, JSON-LD page, headless) and its politeness ceiling, and returns one normalized price observation. Prefer structured sources in this order: official API > stable JSON endpoint > embedded JSON-LD/state blobs > CSS selectors (most brittle). Keep parsers pure and testable against saved fixture files, because "site changed, save new fixture, fix parser" is the recurring maintenance loop. Headless browsers are an escalation, not a default; most of this project's targets don't need one.

Detection engine. Recommend pure functions over (current observation, history window, rule config) so rules are unit-testable with synthetic series. Thresholds (drop percentages, z cutoffs, cooldown lengths) should be config, tuned in use; the brief deliberately does not fix numbers.

Notifications. ntfy (self-hosted, good phone app) is the recommended primary. Apprise as an abstraction gives Discord/Pushover/email for free later. A Home Assistant webhook unlocks automations (TTS announcements, dashboards) since HA already runs on this LAN. Starting with just a Discord webhook is also fine; the design should make channels additive.

Dashboard. Grafana over the database is the near-zero-effort recommendation for history charts and ops panels (block rates, quota gauges). A custom web UI (Astro/SvelteKit) is optional polish, justified only if the owner wants in-browser watchlist management.

Quota discipline. Anything metered, including self-imposed daily caps on hard targets, deserves central enforcement with warn-at-80% and a single "stopped for the month/day" notification, so a config mistake can't silently exhaust a free tier or hammer a site.

## 6. Suggested Milestones (loose, not a contract)

1. Validate cheaply (optional, one evening): run changedetection.io in Docker against ~10 real product pages with notifications, purely to learn which sites are friendly from this network and to prove the phone-notification loop. Throwaway.
2. MVP: easy sources only (Best Buy API, a few JSON-LD sites, maybe Target), persistent history, one or two rules (historical low, percent drop), one notification channel, basic charts. The bar: it catches a real deal you care about.
3. Intelligence: signal feeds (Slickdeals, Menards 11%, lumber index), seasonal suppression, smarter rules, ops visibility, cooldowns tuned by lived experience.
4. Hard targets: Home Depot DIY (devtools-captured request through an impersonating client, store-scoped, tight daily cap), then Lowe's using the same machinery once HD has been stable for a while. This is where the maintenance cost lives; enter it deliberately.
5. Optional reach: Amazon DIY (recommend against), Wayfair (recommend against), custom UI, retention pruning, TimescaleDB.

## 7. Risks and Maintenance Expectations

- Akamai-protected DIY scrapers break every few weeks to months. The trade for $0/month is a recurring hour or two of recapture-and-refix. Fixture-based parser tests make each repair small. If a must-have retailer ever costs more than ~4 hours/month, that is the signal to revisit a paid API for that one source (Traject-style retailer APIs run ~$15-23/month; the adapter pattern makes it a swap, not a rewrite).
- Unofficial endpoints (Target RedSky) drift: parameter or key changes, fixed by recapturing from devtools.
- Clearance ground truth is store-specific and partly invisible online; the system narrows the hunt, but the deepest finds still get verified in-store.
- Over-alerting is the failure mode that kills these tools. Cooldowns, seasonal suppression, and "reason attached to every alert" are as important as data collection.
- Legal posture (informational, not legal advice): public data, no logins, polite volume keeps this well inside the established US case-law comfort zone; the realistic downside of a site objecting is an IP block.

## 8. Reference Material

- changedetection.io: closest existing tool; study its fetcher abstraction, JSONPath extraction, conditional triggers, and Apprise integration. Could literally serve as the MVP.
- Discount Bandit (Laravel): per-store config pattern and alert "why" tagging.
- PriceBuddy: clean "one product, many retailer URLs" data model with history charts.
- Apify's marketplace actors for Home Depot/Target: free-to-read living documentation of current endpoint shapes when something breaks.
- Community intel: Slickdeals clearance threads, r/tools, penny-list trackers; treat all clearance-ending lore as heuristics.

## 9. Decisions Intentionally Left Open

The implementer should decide these during the build, in conversation with the owner where it matters:

- Exact database schema and ORM/migration tooling.
- Monorepo layout, package boundaries, and the adapter interface's precise shape.
- Whether/when to introduce Redis + a job queue vs staying on simple scheduling.
- Concrete rate ceilings, cadence tiers, rule thresholds, and cooldown durations (this brief only requires that they exist, be conservative, and be configurable).
- Whether the impersonating fetcher is a library in-process or a sidecar service, and in which language.
- Which JSON-LD retailers to onboard first, and whether Target lands in the MVP or milestone 3.
- Whether Amazon is included at all.
- Notification channel(s) for v1 and the alert message format.
- Grafana-only vs any custom UI.
- When (if ever) to buy the one-time proxy top-up, within constraint 1.
