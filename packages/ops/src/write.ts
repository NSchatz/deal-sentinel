/**
 * Putting the page where the owner opens it, or refusing and leaving nothing.
 *
 * TWO PROPERTIES, and both are about the bad day rather than the good one.
 *
 * The write is ATOMIC: the document goes to a temporary name in the same
 * directory and is renamed over the target, so a reader either sees the page
 * that was there before or the whole new one. A half-written page is worse than
 * a stale one, because it looks current.
 *
 * A REFUSAL LEAVES NOTHING BEHIND. If the directory is absent or not writable,
 * nothing is created anywhere and the failure names the path it was given.
 * Creating the directory would be the wrong kindness: a page written somewhere
 * nobody expected is a page nobody reads, and the owner's own path is the one
 * fact this command must not guess at.
 */

import { accessSync, constants, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The exit status a caller uses for an output location it cannot write. */
export const OUTPUT_UNWRITABLE_EXIT_CODE = 3;

export class DashboardOutputError extends Error {
  readonly exitCode = OUTPUT_UNWRITABLE_EXIT_CODE;
  readonly outputPath: string;

  constructor(outputPath: string, reason: string) {
    super(
      `the dashboard cannot be written to ${outputPath}: ${reason}. Nothing was ` +
        "created. Create that directory, or point dashboard.outputPath in " +
        "config/ops.json at one that exists - this command does not make one, " +
        "because a page written somewhere nobody expected is a page nobody reads.",
    );
    this.name = "DashboardOutputError";
    this.outputPath = outputPath;
  }
}

/**
 * Can the page be written here? Asked BEFORE anything is read from the store,
 * so a run that is going to fail costs no query and no connection.
 */
export function assertOutputWritable(outputPath: string): void {
  const directory = path.dirname(path.resolve(outputPath));
  if (!existsSync(directory)) {
    throw new DashboardOutputError(outputPath, `${directory} does not exist`);
  }
  try {
    accessSync(directory, constants.W_OK);
  } catch {
    throw new DashboardOutputError(outputPath, `${directory} is not writable`);
  }
  if (existsSync(outputPath)) {
    try {
      accessSync(outputPath, constants.W_OK);
    } catch {
      throw new DashboardOutputError(outputPath, "the existing page is not writable");
    }
  }
}

/** Write the page atomically, or throw having left nothing behind. */
export function writeDashboard(html: string, outputPath: string): string {
  assertOutputWritable(outputPath);
  const resolved = path.resolve(outputPath);
  const staging = `${resolved}.partial-${process.pid}`;
  try {
    writeFileSync(staging, html, "utf8");
    renameSync(staging, resolved);
    return resolved;
  } catch (error) {
    if (existsSync(staging)) unlinkSync(staging);
    throw new DashboardOutputError(
      outputPath,
      error instanceof Error ? error.message : String(error),
    );
  }
}
