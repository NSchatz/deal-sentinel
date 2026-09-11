/**
 * The measurement behind the committed ceiling, reproducible on demand.
 *
 * Prints every eligible file worst first, what the floor and the exclusions
 * left out, and the maximum the ceiling is derived from. The decision record
 * under `docs/decisions/` names this command for exactly that reason: a
 * threshold nobody can re-derive is a number somebody invented.
 *
 * Statuses:
 *   0  the sweep read the tree and printed the distribution
 *   1  a path could not be read, a file could not be tokenized, or a file is
 *      over the committed ceiling
 */

import { fileURLToPath } from "node:url";

import {
  checkCommentDensity,
  describeCommentDensityFindings,
  describeMeasurements,
  readCommentDensityConfig,
  summariseCommentDensity,
} from "./comment-density.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const config = readCommentDensityConfig(REPO_ROOT);
const report = checkCommentDensity(REPO_ROOT, config);

process.stdout.write(`${describeMeasurements(report.measurements)}\n\n`);

const worst = report.measurements[0];
process.stdout.write(
  `${summariseCommentDensity(report, config)}\n` +
    (worst === undefined
      ? "maximum ratio: none, the eligible set is empty\n"
      : `maximum ratio ${worst.ratio.toFixed(1)} points on ${worst.path}\n`),
);

for (const exclusion of report.excluded) {
  process.stdout.write(`excluded ${exclusion.path}: ${exclusion.reason}\n`);
}

if (report.findings.length > 0) {
  process.stderr.write(`${describeCommentDensityFindings(report.findings)}\n`);
  process.exit(1);
}
