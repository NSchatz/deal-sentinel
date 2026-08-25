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
