/**
 * Reading the counts `node --test` prints at the end of a run, so that "the
 * suite was green" can be told apart from "the suite declined to run".
 *
 * Spec S0062-deal-sentinel-ci-gate, AC-9. Seven of the ten files in
 * `test/integration/` stand up a real PostgreSQL container, and three of them -
 * `alert-run`, `alert-cooldown-restart` and `governor-allowance-restart` - are
 * written as `describe(..., { skip }, ...)` where `skip` is decided by
 * `dockerCanRunContainers()`. On a machine whose Docker cannot start a
 * container those three do not fail, they SKIP, and the process still exits
 * zero. A check run that reports that green is reporting that the durability
 * claims this repository exists to make were not exercised at all.
 *
 * So the exit status is not the whole verdict. This module reads the summary
 * the runner prints and lets the caller refuse a run that skipped anything.
 *
 * WHAT IT READS, said here rather than left to be discovered:
 *
 *   - The `spec` reporter's summary block, which is what `pnpm run test` prints
 *     when its output is not a TTY. Seven `<key> <count>` lines followed by a
 *     `duration_ms` line, each prefixed with a marker glyph the count reader
 *     does not depend on.
 *   - The block is located from its LAST `duration_ms` line backwards, and the
 *     lines above it are read only while they keep matching, so a test whose
 *     NAME ends in a number is not mistaken for a count. A run whose output
 *     carries no such block at all is refused rather than assumed fine: output
 *     nobody can read is not evidence of anything.
 *   - AND the per-item skip markers, because the summary alone IS NOT ENOUGH.
 *     `skipped` counts skipped TESTS. A skipped SUITE - which is precisely what
 *     `describe(..., { skip }, ...)` produces, and precisely what the three
 *     Docker-guarded integration files are written as - contributes nothing to
 *     it. `test/fixtures/ci-workflows/test-run-docker-absent.txt.fixture` is a
 *     real capture of one on a machine with no Docker: it reports `skipped 0`
 *     and exits zero while having run nothing at all. The reporter still marks
 *     every skipped item, suite or test, with a leading U+FE63, so that marker
 *     is read too and either signal refuses the run.
 *   - It is a text reader over captured output. It runs nothing, spawns
 *     nothing, and reaches the same verdict on any machine.
 */

/** The seven counts `node --test` reports, in the order it prints them. */
export const SUMMARY_KEYS = [
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
] as const;

export type SummaryKey = (typeof SUMMARY_KEYS)[number];

export type TestRunSummary = Record<SummaryKey, number>;

/**
 * The status a run that skipped a test exits with. `packages/db/scripts/*.sh`
 * already use 2 for a usage error, and `UNPINNED_IMAGE_EXIT_CODE` is 3, so 4
 * says "the suite declined to run part of itself" and nothing else - which is
 * what pinning-conventions P7 asks of a failure that names itself.
 */
export const SKIPPED_TESTS_EXIT_CODE = 4;

const COUNT_LINE = new RegExp(`(?:^|\\s)(${SUMMARY_KEYS.join("|")})\\s+([0-9]+)\\s*$`);
const DURATION_LINE = /(?:^|\s)duration_ms\s+[0-9.]+\s*$/;

/**
 * The summary at the end of `output`, or null when there is no readable one.
 *
 * Null is a real answer and the caller must treat it as a failure: a run whose
 * output carries no summary either crashed before printing one or was captured
 * wrongly, and neither is a run whose green anybody should believe.
 */
export function readTestRunSummary(output: string): TestRunSummary | null {
  const lines = output.split("\n");

  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (DURATION_LINE.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (end === -1) return null;

  const counts = new Map<string, number>();
  for (let index = end - 1; index >= 0; index -= 1) {
    const match = COUNT_LINE.exec(lines[index]);
    // The block is contiguous: the first line above it that is not a count is
    // the end of it, and anything further up is ordinary test output.
    if (match === null) break;
    if (!counts.has(match[1])) counts.set(match[1], Number(match[2]));
  }

  const summary = {} as TestRunSummary;
  for (const key of SUMMARY_KEYS) {
    const value = counts.get(key);
    if (value === undefined) return null;
    summary[key] = value;
  }
  return summary;
}

/**
 * The glyph `node --test`'s spec reporter puts at the head of every item it did
 * not run, suite or test alike: U+FE63, SMALL HYPHEN-MINUS. It is read here
 * because the `skipped` count is not enough on its own - see the module note
 * above, and the committed capture it names.
 */
export const SKIP_MARKER = "﹣";

const SKIP_MARKER_LINE = new RegExp(`^\\s*${SKIP_MARKER}\\s`);

/** Every line the reporter marked as not run, verbatim and in order. */
export function findSkipMarkers(output: string): string[] {
  return output.split("\n").filter((line) => SKIP_MARKER_LINE.test(line));
}

const WHY_A_SKIP_MATTERS =
  "Three integration suites skip themselves rather than failing when this " +
  "machine's Docker cannot start a container, and the process still exits " +
  "zero, so a skip here is a durability claim that was never exercised " +
  "reported as a green. The runner for this check must be one that can start " +
  "containers.";

/**
 * The complaint a caller should print and fail on, or null when the run
 * genuinely reports every test executed.
 */
export function refuseSkippedTests(output: string, source: string): string | null {
  const summary = readTestRunSummary(output);
  if (summary === null) {
    return (
      `${source} carries no readable "node --test" summary, so nothing in it ` +
      "proves the suite ran at all. Output nobody can read is not evidence " +
      `that a check passed. ${WHY_A_SKIP_MATTERS}`
    );
  }

  const markers = findSkipMarkers(output);
  if (markers.length > 0) {
    return (
      `${source} reports ${markers.length} item(s) the runner did not run, ` +
      `beside a summary claiming ${summary.skipped} skipped test(s) - a ` +
      "skipped SUITE never reaches that count, which is why the markers are " +
      `read too:\n${markers.map((line) => `  ${line.trim()}`).join("\n")}\n` +
      WHY_A_SKIP_MATTERS
    );
  }
  if (summary.skipped !== 0 || summary.cancelled !== 0) {
    return (
      `${source} reports ${summary.skipped} skipped and ${summary.cancelled} ` +
      `cancelled test(s) beside ${summary.pass} passing and ${summary.fail} ` +
      `failing. ${WHY_A_SKIP_MATTERS}`
    );
  }
  if (summary.tests === 0) {
    return (
      `${source} reports a summary in which no test ran at all (${summary.suites} ` +
      "suite(s), 0 tests). A check that executed nothing is not a check that " +
      `passed. ${WHY_A_SKIP_MATTERS}`
    );
  }
  return null;
}

/** The one-line confirmation a passing run prints, counts included. */
export function describeTestRun(summary: TestRunSummary): string {
  return (
    `${summary.pass} passing, ${summary.fail} failing, ${summary.skipped} ` +
    `skipped, ${summary.todo} todo, ${summary.cancelled} cancelled ` +
    `across ${summary.suites} suite(s)`
  );
}
