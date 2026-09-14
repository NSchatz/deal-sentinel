#!/usr/bin/env node
/**
 * `pnpm run governor:start-check`
 *
 * Reads the committed governor configuration and refuses, loudly, if it is
 * unparseable or short of a required value: 3, because it ran, every input was
 * legible and a constraint said no. A path the caller named and this process
 * cannot read is 2 instead - the invocation was wrong, and nothing about the
 * configuration was learned. Either way a container that cannot fetch politely
 * does not start and then fetch impolitely.
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

import { GovernorConfigError, GovernorConfigUnreadableError } from "../errors.ts";
import { DEFAULT_CONFIG_PATH, governorStartCheck } from "../system.ts";

export const HELP: HelpSpec = {
  command: "pnpm governor:start-check",
  summary:
    "read the governor configuration and report the ceilings it permits, or " +
    "refuse to start",
  usage: "pnpm governor:start-check [CONFIG]",
  args: [
    {
      name: "CONFIG",
      required: false,
      means: "path to the governor configuration; defaults to config/governor.json",
    },
  ],
  flags: [HELP_FLAG],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_REFUSED],
  example: "pnpm governor:start-check config/governor.json",
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

  const supplied = invocation.positional[0];
  const configPath = supplied ?? DEFAULT_CONFIG_PATH;

  try {
    const report = governorStartCheck(configPath);
    process.stdout.write(
      `governor configuration ${report.configPath} is complete.\n` +
        `  hosts with a ceiling: ${report.hosts.join(", ")}\n` +
        `  configured sources:   ${report.sources.join(", ")}\n` +
        `  metered sources:      ${
          report.meteredSources.length === 0 ? "(none)" : report.meteredSources.join(", ")
        }\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof GovernorConfigUnreadableError) {
      // A path the CALLER named is their mistake to fix; the committed default
      // going missing is this installation failing to run at all.
      const code = supplied === undefined ? EXIT_ERROR : EXIT_USAGE;
      process.stderr.write(
        `${HELP.command}: cannot read the configuration path ${error.path}. ${error.message}\n`,
      );
      return code;
    }
    if (error instanceof GovernorConfigError) {
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
