/**
 * The measurement behind the committed ceiling, reproducible on demand.
 *
 * Prints every eligible file worst first, what the floor and the exclusions
 * left out, and the maximum the ceiling is derived from. The decision record
 * under `docs/decisions/` names this command for exactly that reason: a
 * threshold nobody can re-derive is a number somebody invented.
 *
 * A finding is 4 and not 1. "It ran and found what it looks for" is a different
 * answer from "it could not run", and a caller that sees 1 for a file over the
 * ceiling cannot tell it apart from a sweep that never read the tree.
 */

import { fileURLToPath } from "node:url";

import {
  EXIT_ERROR,
  EXIT_FINDING,
  EXIT_OK,
  EXIT_USAGE,
  HELP_FLAG,
  readInvocation,
  renderHelp,
  renderUsageError,
} from "@deal-sentinel/shared";
import type { ExitCode, HelpSpec } from "@deal-sentinel/shared";

import {
  checkCommentDensity,
  describeCommentDensityFindings,
  describeMeasurements,
  readCommentDensityConfig,
  summariseCommentDensity,
} from "./comment-density.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const HELP: HelpSpec = {
  command: "pnpm comment-density:report",
  summary:
    "measure every eligible file's comment ratio and report the distribution " +
    "the committed ceiling is derived from",
  usage: "pnpm comment-density:report [ROOT]",
  args: [
    {
      name: "ROOT",
      required: false,
      means:
        "tree to sweep; defaults to this repository. A tree carrying its own " +
        "config/comment-density.json is measured against that file",
    },
  ],
  flags: [HELP_FLAG],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_FINDING],
  example: "pnpm comment-density:report",
};

function main(): ExitCode {
  const invocation = readInvocation(process.argv.slice(2), HELP);
  if (invocation.kind === "help") {
    process.stdout.write(renderHelp(HELP));
    return EXIT_OK;
  }
  if (invocation.kind === "usage-error") {
    process.stderr.write(renderUsageError(HELP, invocation.problem));
    return EXIT_USAGE;
  }

  const root = invocation.positional[0] ?? REPO_ROOT;

  let config;
  let report;
  try {
    config = readCommentDensityConfig(root);
    report = checkCommentDensity(root, config);
  } catch (error) {
    // No report was produced at all, so there is nothing to have a finding
    // about. This is the code AC-9 requires 4 to be distinct from.
    process.stderr.write(
      `${HELP.command}: could not produce a report. ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ERROR;
  }

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
    return EXIT_FINDING;
  }
  return EXIT_OK;
}

process.exitCode = main();
