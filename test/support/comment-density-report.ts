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
 *   1  a path could not be read, or a file could not be tokenized
 */

import { fileURLToPath } from "node:url";

import {
  ELIGIBILITY_DEFAULTS,
  collectCommentDensityFiles,
  describeCommentDensityFindings,
  describeMeasurements,
  measureFiles,
} from "./comment-density.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const config = ELIGIBILITY_DEFAULTS;

const collected = collectCommentDensityFiles(REPO_ROOT, config);
const measured = measureFiles(collected.files, config);
const findings = [...collected.findings, ...measured.findings];

process.stdout.write(`${describeMeasurements(measured.measurements)}\n`);

const worst = measured.measurements[0];
process.stdout.write(
  `\nfloor ${config.floor} counted lines, ${measured.measurements.length} eligible file(s), ` +
    `${measured.belowFloor.length} under the floor, ${measured.excluded.length} excluded\n` +
    (worst === undefined
      ? "maximum ratio: none, the eligible set is empty\n"
      : `maximum ratio ${worst.ratio.toFixed(1)} points on ${worst.path}\n`),
);

for (const exclusion of measured.excluded) {
  process.stdout.write(`excluded ${exclusion.path}: ${exclusion.reason}\n`);
}

if (findings.length > 0) {
  process.stderr.write(`${describeCommentDensityFindings(findings)}\n`);
  process.exit(1);
}
