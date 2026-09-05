/**
 * The governor's refusals, each one carrying the condition in its message.
 *
 * The rule this repository does not bend (`documentation/roadmaps/
 * deal-sentinel.research.md`, "Failure modes and the required fail-safe"):
 * warn or typed error, never a confident wrong answer, and never in the
 * direction of more traffic. Every refusal here is that rule at one point in
 * the path.
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
 * Every reason the governor declines to make a request, as a closed vocabulary.
 *
 * It lives here rather than in `governor.ts` because more than the chokepoint
 * needs to name it: the robots gate has to be able to say "this was one of the
 * governor's own refusals" and mean something other than "this host could not
 * be reached". Those two are opposite facts about the world - one is about US,
 * one is about the HOST - and only one of them is a verdict worth caching.
 * `governor.ts` re-exports this name, so the public surface is unchanged.
 */
export type RefusalReason =
  | "unconfigured-host"
  | "unknown-source"
  | "source-paused"
  | "allowance-exhausted"
  | "robots-unreachable"
  | "robots-disallowed"
  // The last two are refusals at the PROCESS BOUNDARY rather than verdicts
  // about a host or a source. Each one says that the governor could not bring
  // one of its own answers back to the present before this request left, and
  // that it declined to leave under an answer it had already declared expired.
  // Both run toward FEWER requests, which is the only direction this
  // repository's fail-safe rule permits an uncertain answer to run.
  | "robots-stale"
  | "host-held"
  | "transport-error";
