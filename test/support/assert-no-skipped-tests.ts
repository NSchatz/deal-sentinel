/**
 * The `test` check run's second question: not "did the suite exit zero", but
 * "did the suite run".
 *
 * Spec S0062-deal-sentinel-ci-gate, AC-9. `.github/workflows/test.yml` pipes
 * `pnpm run test` through `tee` and then hands the captured output here. The
 * exit status has already been checked by then (the workflow's shell carries
 * `-eo pipefail`); what is left to establish is that nothing skipped itself,
 * which is exactly what a runner with no usable Docker daemon produces and
 * exactly what a green cannot distinguish itself from.
 *
 * Statuses, each naming one failure mode, per pinning-conventions P7:
 *   0  every test executed
 *   2  this command was called wrongly
 *   4  the run skipped a test, or printed no summary anybody can read
 *
 * The reading is in `test-run-summary.ts` and is unit-tested against real
 * captured output in `test/unit/ci-workflows.test.ts`; this file is only the
 * command-line skin on it.
 */

import { readFileSync } from "node:fs";

import {
  SKIPPED_TESTS_EXIT_CODE,
  describeTestRun,
  readTestRunSummary,
  refuseSkippedTests,
} from "./test-run-summary.ts";

const USAGE =
  "usage: node test/support/assert-no-skipped-tests.ts <captured-test-output-file>\n" +
  "Refuses a test run that skipped anything, or whose output carries no " +
  '"node --test" summary at all.';

const [source] = process.argv.slice(2);

if (source === undefined || source === "") {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

let output: string;
try {
  output = readFileSync(source, "utf8");
} catch (error) {
  process.stderr.write(
    `cannot read ${source}: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
  );
  process.exit(2);
}

const problem = refuseSkippedTests(output, source);
if (problem !== null) {
  process.stderr.write(`${problem}\n`);
  process.exit(SKIPPED_TESTS_EXIT_CODE);
}

const summary = readTestRunSummary(output)!;
process.stdout.write(`${source}: ${describeTestRun(summary)}\n`);
