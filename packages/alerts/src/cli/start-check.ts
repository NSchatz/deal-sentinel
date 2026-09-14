#!/usr/bin/env node
/**
 * `pnpm run alerts:start-check`
 *
 * Reads the committed alert configuration and the committed governor
 * configuration and says what they permit: every rule with its window, its
 * minimum observation count and its cooldown, the clearance endings the
 * operator supplied, and whether a channel is configured at all.
 *
 * Contacts NOTHING - no database, no credential, no network - so it answers on
 * a box that has not started yet. A configuration it read and refused is 3, so
 * a container whose alert configuration is short of a setting does not start
 * and then quietly evaluate nothing; a path the caller named and this process
 * cannot read is 2 instead.
 *
 * A channel that is not configured, or whose credential is absent, is REPORTED
 * and exits 0: the owner is entitled to see what their rules would do before
 * they have chosen where the alerts go.
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

import { AlertConfigError, AlertConfigUnreadableError } from "../errors.ts";
import { alertsStartCheck } from "../start-check.ts";

export const HELP: HelpSpec = {
  command: "pnpm alerts:start-check",
  summary:
    "report every alert rule, the clearance endings and the delivery channel " +
    "the committed configuration permits",
  usage: "pnpm alerts:start-check [ALERTS_CONFIG] [GOVERNOR_CONFIG]",
  args: [
    {
      name: "ALERTS_CONFIG",
      required: false,
      means: "path to the alert configuration; defaults to config/alerts.json",
    },
    {
      name: "GOVERNOR_CONFIG",
      required: false,
      means: "path to the governor configuration; defaults to config/governor.json",
    },
  ],
  flags: [HELP_FLAG],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_REFUSED],
  example: "pnpm alerts:start-check config/alerts.json config/governor.json",
};

/** Milliseconds as something a human reads without counting zeros. */
function humanise(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms % size === 0 && ms >= size) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

function describe(report: ReturnType<typeof alertsStartCheck>): string {
  const lines = [`alert configuration ${report.configPath} is complete.`];

  for (const rule of report.rules) {
    lines.push(
      `  ${rule.ruleId} (${rule.kind}): window ${humanise(rule.windowMs)}, at ` +
        `least ${rule.minimumObservations} observation(s) in it, must beat the ` +
        `window low by ${rule.improvementMinorUnits} minor unit(s), then quiet ` +
        `for ${humanise(rule.cooldownMs)}.`,
    );
  }

  if (report.clearanceSources.length === 0) {
    lines.push(
      "  clearance endings: none configured. Nothing in this system asserts a " +
        "price-ending pattern for any retailer; the endings are yours to add " +
        "and they corroborate an alert, never trigger one.",
    );
  } else {
    for (const source of report.clearanceSources) {
      lines.push(
        `  clearance endings for ${source.sourceId}: ` +
          `${source.endings.join(", ")} (corroborating tag only).`,
      );
    }
  }

  if (!report.channel.configured) {
    lines.push(
      "  channel: NONE CONFIGURED, so nothing is delivered. Set " +
        "channel.endpoint, and add that host's ceiling to config/governor.json.",
    );
  } else {
    lines.push(`  channel: ${report.channel.method} to ${report.channel.origin}.`);
    lines.push(
      `    credential ${report.channel.credentialVariable ?? "(none required)"}: ` +
        (report.channel.credentialVariable === null
          ? "this channel is configured to need none"
          : report.channel.credentialPresent
            ? "present"
            : "ABSENT - nothing will be delivered until it is set"),
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

  const [alertsPath, governorPath] = invocation.positional;

  try {
    process.stdout.write(describe(alertsStartCheck({ alertsPath, governorPath })));
    return EXIT_OK;
  } catch (error) {
    if (
      error instanceof AlertConfigUnreadableError ||
      error instanceof GovernorConfigUnreadableError
    ) {
      // A path the CALLER named is their mistake to fix; a committed default
      // going missing is this installation failing to run at all.
      const named = error.path === alertsPath || error.path === governorPath;
      process.stderr.write(
        `${HELP.command}: cannot read the configuration path ${error.path}. ${error.message}\n`,
      );
      return named ? EXIT_USAGE : EXIT_ERROR;
    }
    if (error instanceof AlertConfigError || error instanceof GovernorConfigError) {
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
