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
 * a box that has not started yet. Exits non-zero on a refusal, so a container
 * whose alert configuration is short of a setting does not start and then
 * quietly evaluate nothing.
 *
 * A channel that is not configured, or whose credential is absent, is REPORTED
 * and does not fail the check: the owner is entitled to see what their rules
 * would do before they have chosen where the alerts go.
 */

import process from "node:process";

import { AlertConfigError } from "../errors.ts";
import { alertsStartCheck } from "../start-check.ts";

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

try {
  const report = alertsStartCheck({
    alertsPath: process.argv[2],
    governorPath: process.argv[3],
  });

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

  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  if (error instanceof AlertConfigError) {
    process.stderr.write(`refusing to start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
