/**
 * The governor's refusals, each carrying the condition in its message.
 *
 * The rule this repository does not bend: warn or typed error, never a
 * confident wrong answer, and never in the direction of more traffic.
 */

/** Configuration is absent, unparseable, or short of a required value. */
export class GovernorConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GovernorConfigError";
  }
}

/** A caller handed the governor something that is not a fetchable URL. */
export class InvalidRequestError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidRequestError";
  }
}

/**
 * Every reason the governor declines a request, as a closed vocabulary. It
 * lives here rather than in `governor.ts` because the robots gate also has to
 * say "this was one of the governor's own refusals" and mean something other
 * than "this host could not be reached": one is about US, one about the HOST,
 * and only one is a verdict worth caching.
 */
export type RefusalReason =
  | "unconfigured-host"
  | "unknown-source"
  | "source-paused"
  | "allowance-exhausted"
  | "robots-unreachable"
  | "robots-disallowed"
  // Refusals at the PROCESS BOUNDARY rather than verdicts about a host: the
  // governor declined to leave under an answer it had already declared
  // expired. Both run toward FEWER requests, the only direction the fail-safe
  // rule permits an uncertain answer to run.
  | "robots-stale"
  | "host-held"
  | "transport-error";
