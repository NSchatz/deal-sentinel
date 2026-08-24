# 0002: Implementation language and layout

Status: decided
Decision owner: the owner (Noah)
Resolves: BRIEF.md section 9, decision 1 (implementation language and layout)
Recorded by: S0016-deal-sentinel-decisions-1

Section 9 is a bullet list, so "decision 1" names the language-and-layout half
of it: "Monorepo layout, package boundaries, and the adapter interface's
precise shape", together with the "in which language" clause of "Whether the
impersonating fetcher is a library in-process or a sidecar service, and in
which language". The database half is decision 2, recorded in
`0003-database-engine-and-migration-tooling.md`.

Numbering: this record was commissioned as `0001-<slug>.md`. That number was
already taken by `0001-history-storage-and-layout.md`, so it takes the next
free slot instead. The number is a filename, not the section 9 item.

## Decision

deal-sentinel is built in TypeScript on Node (`>=22.6.0`, ESM), one language
and one runtime, with no second-runtime service. The layout is a monorepo:
small single-purpose packages under `packages/` in one workspace, retailer
integrations kept behind a common adapter interface, parsers kept pure and
tested against committed fixtures, and cross-package composition done in the
repo-root `test/` directory. The concrete package boundaries in place today
(`shared`, `extractor`, `db`) were fixed by `0001-history-storage-and-layout.md`
and are not reopened here; what this record settles is the shape those
boundaries live in and the language they are written in.

## Reasoning

1. Section 5 states the merit directly: "TypeScript/Node matches the owner's
   daily stack and is the recommended core." The owner then decided it in their
   own words ("typescript / node / postgresql"); per
   `0001-history-storage-and-layout.md`, the record of authority for those
   words is the umbrella file
   `work/specs/S0002-deal-sentinel-history-1/operator-decision-section-9-language-and-storage.md`.
   This file records the choice and its reasoning; it does not create it.

2. One language and one runtime is the maintainable shape for a homelab tool
   with a single maintainer. Section 7 and the repo's working agreement both
   name the recurring maintenance loop as "site changed, save new fixture, fix
   parser". Every additional runtime adds a second dependency tree, a second
   container to keep patched, and a second way for that loop to stall on a
   weeknight. Nothing in section 4's capability list needs a second runtime.

3. Rejected: pure Python. Section 5's stated merit for it is real - "Python has
   the stronger scraping ecosystem (curl_cffi, zendriver)" - and it still
   loses. The core of this system is not scraping; it is history plus rules
   over that history (section 5's detection engine is "pure functions over
   (current observation, history window, rule config)"), and that code gains
   nothing from Python's fetching libraries. Against that, Python is not the
   owner's daily stack, so every later maintenance touch would be more
   expensive for the one person doing it, and the working code already at this
   pin (the extractor, the store, the guarded write path) would have to be
   rewritten to buy a capability no current target requires.

4. Rejected: a TypeScript core with a Python sidecar service for
   browser-impersonated fetching. Section 5 calls this "a pragmatic pattern"
   and it is the option this repo would adopt first if it ever needs one. It is
   rejected as the DEFAULT because it pays the two-runtime cost up front,
   before any target has actually blocked polite in-process requests. Section 5
   orders fetch strategies "official API > stable JSON endpoint > embedded
   JSON-LD/state blobs > CSS selectors (most brittle)" and says headless
   browsers are "an escalation, not a default; most of this project's targets
   don't need one". A dedicated impersonating sidecar is the escalation beyond
   that escalation, and building it speculatively means maintaining it for
   every target that never needed it.

5. Constraint 4 (personal-use volumes; "part of the point is keeping the
   household's home IP in good standing") is the load-bearing reason this
   record is single-runtime rather than merely single-language. Whatever code
   owns the fetch layer owns what the household's residential IP does to third
   parties: the request rate, the jitter, the per-site daily cap, and the
   backoff when a site pushes back. In-process TypeScript keeps all of that in
   one place, under one configuration and one test suite, so a politeness
   ceiling is enforced by construction rather than by convention. A Python
   sidecar would move browser-impersonated fetching into a second process with
   its own HTTP client, its own defaults, and its own idea of politeness; the
   ceilings would then have to be implemented and audited twice, and the second
   implementation is the one that would silently drift. One runtime means one
   quota gate and one place to audit before the home IP is the thing that pays.

6. That constraint-4 argument is also the reason this record does NOT close
   section 9's separate question of "whether the impersonating fetcher is a
   library in-process or a sidecar service". The default that follows from this
   decision is in-process. If a target one day blocks polite in-process
   requests, moving fetching out of process (in any language) changes which
   code owns request behavior against third-party sites, which is exactly the
   constraint 4 surface, so it takes its own decision record and has to make
   the politeness argument again on its own terms. It is not settled here by
   implication.

7. Layout follows section 5's own framing: "Monorepo vs single service:
   implementer's choice; keep retailer integrations isolated behind a common
   adapter interface either way, because per-site code is the part that breaks
   and gets replaced." A monorepo of small packages is chosen over a single
   flat service because it makes that isolation a package boundary rather than
   a habit: a pure parser package that has no database import cannot be made
   impure by an accidental import, and the part expected to break can be
   replaced without touching the store or the rules.

8. Cost: nothing here is metered. Node, TypeScript and the workspace tooling
   are free and run on hardware the owner already owns, so constraint 1
   ($0/month recurring) is untouched and no paid option is in play for this
   decision. Nothing needs escalating to the owner under constraint 7.

## Not a deciding factor

- Raw scraping-library power. Python wins that comparison on section 5's own
  words, and it still lost, because the fetching problem this project actually
  has is politeness against a handful of structured sources, not defeating
  hard anti-bot targets.
- Runtime performance. At personal-use volumes the bottleneck is the deliberate
  delay between requests, not the language. Any of the three options would have
  been fast enough by an enormous margin.
- Package manager. Installs here run with pnpm while `package.json` keeps the
  `workspaces` field; that deviation and its reason are already recorded in
  `0001-history-storage-and-layout.md` and are not revisited here.

## Not decided here

Nothing else in section 9 is settled by this record: not queue-versus-plain
scheduling, not the notification channels or alert format, not which JSON-LD
retailers are onboarded first or whether Target lands in the MVP, not whether
Amazon is included at all, not Grafana-only versus a custom UI, and not when
(if ever) the one-time proxy top-up is bought.
