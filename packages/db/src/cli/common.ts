/**
 * What both history commands share: the name of the marker they talk about, and
 * the stated-state record they write when the database cannot be reached.
 *
 * `observability` O4 - a failed dependency is a stated state, not an exception
 * trace - is the reason the record names the dependency, what was tried and
 * what happens next. A caller reading only the exit code learns "could not
 * run"; a human reading stderr learns which thing was not there.
 */

import { DATABASE_URL_VARIABLE, redactUrl } from "../connection.ts";

/** The table whose presence means "the one-time initialization finished". */
export const INITIALIZATION_MARKER = "public.history_initialization";

/** Syscall-level answers that mean the database was never spoken to. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENOENT",
]);

export function unreachable(error: unknown): boolean {
  const code: unknown =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && UNREACHABLE_CODES.has(code);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The O4 record. `url` is redacted here rather than by the caller so that no
 * command can print a password by forgetting to.
 */
export function describeDependencyFailure(options: {
  command: string;
  url: string;
  tried: string;
  next: string;
  error: unknown;
}): string {
  const headline = unreachable(options.error)
    ? "could not reach the history database"
    : "reached the history database and could not finish";

  return [
    `${options.command}: ${headline}.`,
    `  dependency: the history database at ${redactUrl(options.url)}, from ${DATABASE_URL_VARIABLE}`,
    `  tried:      ${options.tried}`,
    `  failed:     ${messageOf(options.error)}`,
    `  next:       ${options.next}`,
    "",
  ].join("\n");
}
