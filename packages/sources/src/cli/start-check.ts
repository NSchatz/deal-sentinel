#!/usr/bin/env node
/**
 * `pnpm run sources:start-check`
 *
 * Reads the committed source registry and the committed governor
 * configuration, checks both against every source's own published terms, and
 * refuses with 3 when either is legible and wrong, so a container that would
 * store content past a ceiling somebody promised a third party - or fetch
 * faster than that party permits - does not start and then do it. A path the
 * caller named and this process cannot read is 2: the invocation was wrong and
 * nothing about either configuration was learned.
 *
 * A source with no credential is REPORTED and exits 0: one source that cannot
 * run must not stop the others, and a start gate that closed on it would stop
 * the whole household's collection over one absent key.
 */

import process from "node:process";

import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  HELP_FLAG,
  readInvocation,
  renderHelp,
  renderUsageError,
} from "@deal-sentinel/shared";
import type { ExitCode, HelpSpec } from "@deal-sentinel/shared";
import { GovernorConfigError, GovernorConfigUnreadableError } from "@deal-sentinel/governor";

import { SourceConfigError, SourceConfigUnreadableError } from "../errors.ts";
import { sourcesStartCheck } from "../start-check.ts";

export const HELP: HelpSpec = {
  command: "pnpm sources:start-check",
  summary:
    "check the source registry and the governor configuration against every " +
    "source's published terms, and report what they permit",
  usage: "pnpm sources:start-check [SOURCES_CONFIG] [GOVERNOR_CONFIG]",
  args: [
    {
      name: "SOURCES_CONFIG",
      required: false,
      means: "path to the source registry; defaults to config/sources.json",
    },
    {
      name: "GOVERNOR_CONFIG",
      required: false,
      means: "path to the governor configuration; defaults to config/governor.json",
    },
  ],
  flags: [HELP_FLAG],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_REFUSED],
  example: "pnpm sources:start-check config/sources.json config/governor.json",
};

function describe(report: ReturnType<typeof sourcesStartCheck>): string {
  const lines = [`source configuration ${report.configPath} is complete.`];
  for (const source of report.sources) {
    const ceiling =
      source.retentionHours === null
        ? "raw content retained (its terms declare no ceiling)"
        : `raw content kept ${source.retentionHours}h` +
          (source.ceilingHours === null ? "" : ` of a permitted ${source.ceilingHours}h`);
    lines.push(
      `  ${source.sourceId}: ${source.host}, ${source.currency}, ` +
        `${source.timeZone}, ${ceiling}` +
        (source.attributionRequired ? ", attribution required" : ""),
    );
    lines.push(
      `    credential ${source.credentialVariable}: ` +
        (source.credentialPresent
          ? "present"
          : "ABSENT - this source will not run, and every other source will"),
    );
  }
  for (const limit of report.limits) {
    lines.push(
      `  ${limit.sourceId} is configured for at most ` +
        `${limit.configuredCallsPerSecond} calls/second of a documented ` +
        `${limit.documentedCallsPerSecond}, and ${limit.configuredCallsPerDay} ` +
        `calls/day of a documented ${limit.documentedCallsPerDay}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

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

  const [sourcesPath, governorPath] = invocation.positional;

  try {
    process.stdout.write(describe(sourcesStartCheck({ sourcesPath, governorPath })));
    return EXIT_OK;
  } catch (error) {
    if (
      error instanceof SourceConfigUnreadableError ||
      error instanceof GovernorConfigUnreadableError
    ) {
      // A path the CALLER named is their mistake to fix; a committed default
      // going missing is this installation failing to run at all.
      const named = error.path === sourcesPath || error.path === governorPath;
      process.stderr.write(
        `${HELP.command}: cannot read the configuration path ${error.path}. ${error.message}\n`,
      );
      return named ? EXIT_USAGE : EXIT_ERROR;
    }
    if (error instanceof SourceConfigError || error instanceof GovernorConfigError) {
      process.stderr.write(`refusing to start: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    process.stderr.write(
      `${HELP.command}: could not finish. ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ERROR;
  }
}

process.exitCode = main();
