/**
 * Classifying what happened to an offered fetch, and the ports that write it
 * down.
 *
 * The chokepoint is the only place in this system that knows all four answers,
 * which is why the classification lives beside it rather than in whatever
 * package happens to want a number. An adapter sees a governor refusal and a
 * response; it does not see the refusal reason that stopped a request before it
 * ever reached the adapter, and it never sees the request that was declined at
 * gate 1 because nobody configured that host.
 *
 * THE FOUR CLASSES ARE A PARTITION AND THE DISTINCTIONS ARE THE POINT:
 *
 *   `refused`  THIS SYSTEM declined to send. Nothing left the process, no
 *              allowance was spent, and the governor's own refusal reason IS the
 *              condition. An operator reads this column as "my own settings",
 *              and mixing it into `error` would hide a misconfigured ceiling
 *              behind what looks like a flaky vendor.
 *   `error`    the request LEFT and no usable response came back. The unit is
 *              spent and the household's address made a request.
 *   `blocked`  the far side REFUSED it - a 429, or a status that source's own
 *              published terms document as limit-exceeded. This is the class the
 *              whole phase is for: block rate is what says whether the
 *              politeness ceilings are right, and adding retailers without it is
 *              tuning blind.
 *   `success`  a usable response arrived.
 *
 * `blocked` is decided against the SOURCE'S OWN TERMS and never against a
 * built-in list of statuses, because the sanctioned API answers an exceeded
 * limit with 403 and 403 means something else entirely elsewhere. The terms live
 * in `packages/sources/src/terms.ts`, where a vendor's published document
 * belongs; this function takes them as an argument so that the governor holds no
 * opinion about any particular retailer.
 *
 * 429 is `blocked` for every source, terms or no terms: RFC 6585 section 4
 * defines it as "the user has sent too many requests in a given amount of time",
 * which is the far side refusing on rate and nothing else.
 */

import type { RefusalReason } from "./errors.ts";

/** The four classes, exhaustive, and the same four the schema constrains. */
export type FetchOutcomeClass = "success" | "error" | "blocked" | "refused";

/** What the chokepoint saw, reduced to what the classification needs. */
export type ClassifiableOutcome =
  | { kind: "refused"; reason: RefusalReason; detail: string }
  | { kind: "transport-error"; detail: string }
  | { kind: "response"; status: number };

/** The class, and the condition to record with it. */
export type FetchClassification = {
  outcomeClass: FetchOutcomeClass;
  /** Null only for a plain success, which has no condition to state. */
  condition: string | null;
};

/** RFC 6585 section 4. The far side refusing on rate, whoever the far side is. */
export const TOO_MANY_REQUESTS = 429;

/**
 * Which of the four classes this outcome is, and the condition that goes with
 * it.
 *
 * PURE. It takes what happened and the statuses that source's terms document as
 * limit-exceeded, and it reads no clock, no configuration and no store - so the
 * same outcome classifies the same way in a test, in a run and in a year.
 */
export function classifyFetchOutcome(
  outcome: ClassifiableOutcome,
  limitExceededStatuses: readonly number[] = [],
): FetchClassification {
  if (outcome.kind === "refused") {
    return {
      outcomeClass: "refused",
      // The reason is named FIRST and the detail follows it, so a condition
      // stays legible after it has been truncated by whatever shows it.
      condition: `${outcome.reason}: ${outcome.detail}`,
    };
  }

  if (outcome.kind === "transport-error") {
    return {
      outcomeClass: "error",
      condition: `transport-error: ${outcome.detail}`,
    };
  }

  const status = outcome.status;

  if (status === TOO_MANY_REQUESTS) {
    return {
      outcomeClass: "blocked",
      condition:
        `blocked: the far side answered ${TOO_MANY_REQUESTS}, which RFC 6585 ` +
        "section 4 defines as too many requests in a given amount of time.",
    };
  }

  if (limitExceededStatuses.includes(status)) {
    return {
      outcomeClass: "blocked",
      condition:
        `blocked: the far side answered ${status}, which this source's own ` +
        "published terms document as meaning its limit was exceeded.",
    };
  }

  if (status >= 200 && status <= 299) {
    return { outcomeClass: "success", condition: null };
  }

  return {
    outcomeClass: "error",
    condition:
      `error: the request left this process and the far side answered ` +
      `${status}, which is not a usable response and is not a status this ` +
      "source's terms document as limit-exceeded.",
  };
}

/* -------------------------------------------------------------------------- */
/* The ports the chokepoint writes through                                     */
/* -------------------------------------------------------------------------- */

/** One offered fetch, as the chokepoint hands it over. */
export type FetchOutcomeRecord = {
  sourceId: string;
  outcomeClass: FetchOutcomeClass;
  /** Whole milliseconds, from OFFERED to KNOWN. */
  latencyMs: number;
  occurredAt: Date;
  condition: string | null;
};

/** One breaker pause, as the chokepoint hands it over. */
export type BreakerPauseRecord = {
  sourceId: string;
  pausedAt: Date;
  expiresAt: Date;
  failingCount: number;
  windowOutcomes: number;
  windowMs: number;
  /** The configured threshold as text. Shown, never computed with. */
  failureRateThreshold: string;
  condition: string;
};

/**
 * Where the chokepoint writes what it saw.
 *
 * OPTIONAL IN EVERY DIRECTION, and that is a safety property rather than a
 * convenience: a governor built without one records nothing and behaves exactly
 * as it did before this spec, and a governor built WITH one may not behave
 * differently either. Nothing here returns a value the governor acts on. There
 * is no way for an implementation of this port to make a request leave, to stop
 * one leaving, or to cause one to be offered a second time.
 *
 * `onRecordFailure` exists so that a failed write is not silent to a caller who
 * asked to know, without it being loud to the fetch path. It may not throw
 * either; the governor treats it the same way.
 */
export type FetchTelemetry = {
  /** Write one outcome. May reject: the governor swallows it. */
  record(record: FetchOutcomeRecord): Promise<void> | void;
  /** Write one pause, from the one place a pause is announced. May reject. */
  recordPause?(pause: BreakerPauseRecord): Promise<void> | void;
  /**
   * The statuses this source's own published terms document as limit-exceeded.
   * Supplied by whatever holds those terms; the governor holds none.
   */
  limitExceededStatusesFor?(sourceId: string): readonly number[];
  /** Told when a write failed. Cannot affect the fetch either. */
  onRecordFailure?(error: unknown): void;
};
