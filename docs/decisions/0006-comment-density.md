# 0006 - Comment density: what was measured, and what was trimmed

This repository's TypeScript is held to a comment-density ceiling. The number
is DERIVED from the measurement below rather than picked: a threshold nobody
can re-derive is a number somebody invented, and `CLAUDE.md` working agreement
8 asks for thresholds that exist, are conservative and are configurable.

**The trade: a file may not be mostly prose, however good the prose is.** A
comment earns its place by saying WHY. One that restates the line under it
costs a reader attention and goes stale on its own.

## What is counted

- COUNTED LINE: a non-blank line.
- COMMENT LINE: a counted line every non-whitespace byte of which lies inside a
  comment as the TypeScript tokenizer reports it. A line carrying code and a
  trailing comment is a code line.
- RATIO: comment lines over counted lines, in percentage points.
- ELIGIBLE SET: every committed `.ts`, `.mts`, `.cts` and `.tsx` file outside
  `node_modules`, `dist`, `build`, `coverage` and `backups`, minus generated
  output, minus the samples parked under `.fixture`, minus files under the
  floor.
- FLOOR: 20 counted lines. One comment line in an N-line file moves its ratio
  by 100/N points, so below 20 lines a single line moves it by more than five
  points and the ratio is noise rather than a measurement.
- CAP: 50 points. Ported from the umbrella's own `check_comment_density()`,
  where it is the ceiling that errors; it is the bound a committed ceiling may
  never exceed.

The counting is in `test/support/comment-density.ts` and is graded against
planted samples by `test/unit/comment-density.test.ts`. It TOKENIZES rather
than matching bytes, because `//` inside a string or a URL, `/*` inside a
template literal, a slash pair inside a character class and comment-looking JSX
text are all code, and a byte scanner reads every one of them as prose. The
umbrella's first attempt at this check did exactly that and scored five mostly
code files between 64 and 85 percent.

## The measurement

| field | value |
|---|---|
| maximum ratio | 67.1 |
| eligible files | 130 |
| files under the floor | 1 |
| files excluded | 0 |
| floor | 20 |
| commit measured | c4c88ebf572984e97ca086d861540122235904e9 |
| command | pnpm run comment-density:report |

That command prints the table below and the summary under it. It reads
committed text, opens no connection and starts nothing, so it reaches the same
numbers on any machine that can check the tree out.

The one file under the floor is `packages/db/drizzle.config.ts`, at 16 counted
lines. Nothing is excluded as generated output: this repository commits no
generated TypeScript, and the exclusion exists for the day it does.

## The trim set

Every eligible file the measurement put above the cap, with the ratio it
carried before anything was edited. Nothing outside this list had a comment
touched.

| file | ratio before | ratio after |
|---|---|---|
| packages/sources/src/terms.ts | 67.1 | |
| packages/alerts/src/clearance.ts | 66.7 | |
| packages/alerts/src/redaction.ts | 65.5 | |
| packages/shared/src/index.ts | 63.3 | |
| tests/regress_0002_F6.ts | 62.7 | |
| packages/governor/src/ports.ts | 59.7 | |
| packages/db/src/schema.ts | 59.4 | |
| packages/db/src/retention.ts | 59.2 | |
| packages/sources/src/adapter.ts | 57.5 | |
| packages/sources/src/credential.ts | 56.3 | |
| packages/sources/src/retention.ts | 56.1 | |
| tests/regress_0023_F11.ts | 55.2 | |
| packages/governor/src/errors.ts | 55.1 | |
| tests/regress_0002_F5.ts | 51.6 | |
| tests/regress_0023_F12.ts | 50.6 | |

A comment in this repository is not inert text. `test/support/pinning.ts` reads
the names in `KNOWN_IMAGE_NAMES` wherever they are written, comments included,
and a name that appears nowhere is a finding of its own, so prose naming a
container image is load-bearing and stays.

## The distribution

Every eligible file, worst first: ratio, comment lines over counted lines, path.

```
 67.1    55/82    packages/sources/src/terms.ts
 66.7    36/54    packages/alerts/src/clearance.ts
 65.5   169/258   packages/alerts/src/redaction.ts
 63.3    62/98    packages/shared/src/index.ts
 62.7    42/67    tests/regress_0002_F6.ts
 59.7    77/129   packages/governor/src/ports.ts
 59.4   231/389   packages/db/src/schema.ts
 59.2    45/76    packages/db/src/retention.ts
 57.5    46/80    packages/sources/src/adapter.ts
 56.3    63/112   packages/sources/src/credential.ts
 56.1    37/66    packages/sources/src/retention.ts
 55.2    53/96    tests/regress_0023_F11.ts
 55.1    27/49    packages/governor/src/errors.ts
 51.6    49/95    tests/regress_0002_F5.ts
 50.6    40/79    tests/regress_0023_F12.ts
 49.2    61/124   tests/regress_0023_F1.ts
 48.8    21/43    packages/alerts/src/errors.ts
 47.6   138/290   packages/governor/src/allowance.ts
 47.4    55/116   tests/regress_0023_F9.ts
 46.6    48/103   packages/governor/src/retry-after.ts
 45.9   329/716   packages/governor/src/governor.ts
 44.3    43/97    packages/db/src/observations.ts
 44.2    69/156   tests/regress_0023_F2.ts
 44.0    40/91    packages/extractor/src/index.ts
 42.5   105/247   packages/alerts/src/channel.ts
 42.4    67/158   test/support/test-run-summary.ts
 42.3    90/213   packages/alerts/src/rules.ts
 41.2    28/68    packages/sources/src/errors.ts
 40.3    75/186   packages/governor/src/robots-parse.ts
 39.9    67/168   packages/sources/src/time-zone.ts
 39.4    63/160   packages/sources/src/attribution.ts
 39.2    29/74    packages/governor/src/allowance-store-memory.ts
 38.5    20/52    test/support/assert-no-skipped-tests.ts
 37.7    69/183   packages/alerts/src/notification.ts
 37.3   231/619   packages/governor/src/no-direct-http.ts
 36.5    27/74    packages/governor/src/system.ts
 36.2    54/149   test/unit/regress_0036_F5.ts
 36.2    79/218   packages/governor/src/robots.ts
 35.9    51/142   tests/regress_0023_F8.ts
 35.5    83/234   packages/sources/src/bestbuy/adapter.ts
 34.4    54/157   packages/governor/src/allowance-store-postgres.ts
 33.7    33/98    packages/governor/src/breaker.ts
 33.0    32/97    packages/sources/src/start-check.ts
 32.9    50/152   tests/regress_0002_F1.ts
 32.4    89/275   packages/sources/src/bestbuy/mapping.ts
 31.1    51/164   packages/alerts/src/start-check.ts
 30.7    87/283   tests/regress_0023_F10.ts
 30.5    39/128   packages/db/src/source-stops.ts
 30.2    32/106   packages/db/src/alert-state.ts
 29.4    37/126   packages/governor/src/host-scheduler.ts
 29.3    12/41    test/support/comment-density-report.ts
 28.8    49/170   packages/db/src/watchlist.ts
 28.3    26/92    packages/db/src/initialize.ts
 27.8    59/212   test/support/postgres-container.ts
 27.6    81/293   packages/sources/src/run.ts
 27.3    18/66    packages/alerts/src/index.ts
 27.3    12/44    packages/db/src/errors.ts
 27.3   123/451   packages/extractor/src/offers.ts
 27.3    21/77    packages/sources/src/wiring.ts
 26.7     8/30    packages/governor/src/cli/start-check.ts
 25.9    22/85    packages/governor/src/transport.ts
 25.1    84/335   tests/regress_0023_F15.ts
 24.8    25/101   test/support/fake-clock.ts
 24.6    70/285   packages/extractor/src/currency.ts
 24.2     8/33    packages/db/src/connection.ts
 24.2    16/66    packages/db/src/start-check.ts
 23.8    34/143   packages/db/src/write-path.ts
 23.4    29/124   test/support/loopback-server.ts
 22.9    44/192   tests/regress_0023_probe_ordinal8_boundary.ts
 22.8    13/57    packages/sources/src/cli/start-check.ts
 22.7    30/132   tests/regress_0002_F2.ts
 22.7    75/331   tests/regress_0023_F17.ts
 22.5   229/1020  test/support/pinning.ts
 22.2    10/45    packages/db/src/cli/init.ts
 22.0     9/41    packages/db/src/cli/start-check.ts
 21.7    81/373   tests/regress_0023_F13.ts
 21.7    18/83    packages/sources/src/index.ts
 20.9    18/86    packages/alerts/src/cli/start-check.ts
 20.6    43/209   test/integration/alert-cooldown-restart.test.ts
 20.6    51/248   test/support/source-3-harness.ts
 20.5   102/497   test/unit/no-direct-http.test.ts
 19.5   102/522   test/unit/allowance.test.ts
 19.2    20/104   packages/governor/src/index.ts
 19.1    54/282   packages/alerts/src/run.ts
 19.1    26/136   test/support/alert-harness.ts
 19.0    67/353   test/support/comment-density.ts
 18.9   107/567   test/unit/robots-cache.test.ts
 18.4    42/228   test/integration/governor-allowance-restart.test.ts
 18.3    31/169   tests/regress_0023_probe_ordinal8_f15.ts
 17.9    26/145   test/unit/retry-after-date.test.ts
 17.8    29/163   test/unit/source-3-attribution.test.ts
 17.7    43/243   test/unit/regress_0036_F1.ts
 17.6    31/176   test/support/governor-harness.ts
 17.3    42/243   test/support/seed.ts
 17.1    62/362   test/unit/robots-unreachable.test.ts
 16.7    57/341   test/unit/breaker.test.ts
 16.7    30/180   test/integration/alert-run.test.ts
 16.7    24/144   test/unit/robots-unavailable.test.ts
 16.4    88/538   packages/alerts/src/config.ts
 16.1    18/112   test/unit/provisioning.test.ts
 16.0    37/231   test/integration/source-3-retention.test.ts
 15.5    57/368   test/unit/backpressure-429.test.ts
 15.4    30/195   test/integration/init-and-start-check.test.ts
 15.2    27/178   test/unit/retry-after-seconds.test.ts
 14.9   102/685   test/unit/pinning.test.ts
 14.8    76/513   packages/sources/src/registry.ts
 14.7    42/286   test/unit/source-3-mapping.test.ts
 14.3    41/286   test/unit/alert-composition.test.ts
 14.3    68/475   packages/governor/src/config.ts
 14.2    40/282   test/unit/source-3-credential.test.ts
 13.6    32/236   test/integration/source-3-observation.test.ts
 13.5    53/393   test/unit/alert-rules.test.ts
 13.0    42/322   test/unit/governor-config.test.ts
 12.8    74/576   test/unit/ci-workflows.test.ts
 12.4    28/225   packages/extractor/test/extract-offer.test.ts
 12.3    20/162   test/unit/governor-chokepoint.test.ts
 12.3    34/276   test/integration/source-3-403.test.ts
 12.1   125/1036  test/support/ci-workflows.ts
 11.9    28/235   test/integration/restore-proof.test.ts
 11.7    24/205   test/unit/governor-rate-ceiling.test.ts
 11.5    42/365   test/integration/source-3-watchlist-run.test.ts
 10.9    40/367   test/unit/source-3-registry.test.ts
 10.8     9/83    packages/db/src/index.ts
 10.7    27/253   test/unit/comment-density.test.ts
 10.6    78/734   test/unit/alert-channel.test.ts
 10.3    49/475   tests/regress_0023_probe_ordinal8.ts
  8.8    22/250   test/integration/observation-write-path.test.ts
  8.6    30/347   test/unit/robots-matching.test.ts
  8.1    25/308   test/unit/alert-config.test.ts
  4.2     7/167   packages/db/test/write-path.test.ts
```
