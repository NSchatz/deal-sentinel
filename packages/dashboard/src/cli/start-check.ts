#!/usr/bin/env node
/**
 * `pnpm run dashboard:start-check`
 *
 * Reads the committed dashboard configuration and says what it permits: the
 * address and port that would be bound, whether that address is loopback, the
 * staleness horizon a source is judged BROKEN against, the period the rates are
 * computed over and the default chart range.
 *
 * Contacts nothing. Exits non-zero on a refusal, so a container whose dashboard
 * configuration is short of a setting does not start and then quietly serve a
 * page built on numbers nobody chose.
 */

import process from "node:process";

import { DashboardConfigError } from "../errors.ts";
import { dashboardStartCheck } from "../start-check.ts";

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
  const report = dashboardStartCheck(process.argv[2]);
  const lines = [
    `dashboard configuration ${report.configPath} is complete.`,
    `  bind: ${report.config.bindAddress}:${report.config.port}`,
    `  exposure: ${report.exposure}`,
    `  a source reads BROKEN when its last success is older than ` +
      `${humanise(report.config.stalenessHorizonMs)}.`,
    `  rates are computed over ${humanise(report.config.ratePeriodMs)}.`,
    `  a chart shows ${humanise(report.config.defaultChartRangeMs)} unless a ` +
      "range is asked for.",
    `  a source's detail lists up to ${report.config.conditionHistoryLimit} ` +
      "recent conditions, pauses and stops.",
    "  this process makes no outbound request of any kind.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  if (error instanceof DashboardConfigError) {
    process.stderr.write(`refusing to start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
