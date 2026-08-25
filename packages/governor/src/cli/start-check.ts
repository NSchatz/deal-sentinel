#!/usr/bin/env node
/**
 * `pnpm run governor:start-check`
 *
 * Reads the committed governor configuration and refuses, loudly, if it is
 * absent, unparseable or short of a required value. Exits non-zero on a
 * refusal, so a container that cannot fetch politely does not start and then
 * fetch impolitely.
 */

import process from "node:process";

import { GovernorConfigError } from "../errors.ts";
import { DEFAULT_CONFIG_PATH, governorStartCheck } from "../system.ts";

const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;

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
} catch (error) {
  if (error instanceof GovernorConfigError) {
    process.stderr.write(`refusing to start: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
