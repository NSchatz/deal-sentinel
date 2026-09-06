#!/usr/bin/env node
/**
 * `pnpm run sources:start-check`
 *
 * Reads the committed source registry and the committed governor
 * configuration, checks both against every source's own published terms, and
 * refuses loudly when either is wrong. Exits non-zero on a refusal, so a
 * container that would store content past a ceiling somebody promised a third
 * party - or fetch faster than that party permits - does not start and then do
 * it.
 *
 * A source with no credential is REPORTED and does not fail the check: one
 * source that cannot run must not stop the others.
 */

import process from "node:process";

import { SourceConfigError } from "../errors.ts";
import { sourcesStartCheck } from "../start-check.ts";

try {
  const report = sourcesStartCheck({
    sourcesPath: process.argv[2],
    governorPath: process.argv[3],
  });

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

  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  if (error instanceof SourceConfigError) {
    process.stderr.write(`refusing to start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
