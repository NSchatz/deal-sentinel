/**
 * The common source interface.
 *
 * CLAUDE.md rule 4: "Per-site code is the part that breaks. Keep every retailer
 * behind a common adapter interface, keep parsers pure, and test them against
 * saved fixtures." So an adapter is one method over one listing and everything
 * a run needs to decide what to do next is in the OUTCOME rather than in an
 * exception, which carries no vocabulary a run can branch on without matching
 * message text. It reaches the network only through `Governor.request`, and
 * `no-direct-http.test.ts` fails the suite if this package names a client.
 *
 * The five outcomes are exhaustive and each has exactly one right response,
 * which is why they are five rather than a boolean and a message:
 *
 *   `observed`          write it;
 *   `extraction-failed` record the typed reason and write NOTHING: a gap is
 *                       visible a week later and a wrong number is not;
 *   `governor-refused`  nothing left the process, and no refusal reason clears
 *                       by waiting inside one run, so do not retry;
 *   `limit-exceeded`    the SOURCE said so: stop it, notify once, never retry;
 *   `source-error`      record and continue with the remaining entries.
 */

import type { RefusalReason } from "@deal-sentinel/governor";
import type { ExtractionFailureReason } from "@deal-sentinel/shared";

export type ObservationDraft = {
  amountMinorUnits: bigint;
  currency: string;
  /** schema.org ItemAvailability as received; empty means none was declared. */
  availability: string;
  vendorPriceUpdatedAt: Date | null;
  /**
   * Enough of the payload to debug a mapping break, REDACTED and bounded: no
   * credential ever reaches this string, which lands in a stored column.
   */
  rawContext: string;
};

export type SourceOutcome =
  | { kind: "observed"; listingId: string; draft: ObservationDraft }
  | {
      kind: "extraction-failed";
      listingId: string;
      reason: ExtractionFailureReason;
      detail: string;
    }
  | {
      kind: "governor-refused";
      listingId: string;
      reason: RefusalReason;
      detail: string;
    }
  | { kind: "limit-exceeded"; listingId: string; status: number; detail: string }
  | {
      kind: "source-error";
      listingId: string;
      status: number | null;
      detail: string;
    };

/**
 * One retailer, behind one method. `observe` says what this returns - an
 * observation, or a typed reason there is none - rather than how it got it, and
 * is deliberately not the verb the governor's own check forbids elsewhere.
 */
export type SourceAdapter = {
  readonly sourceId: string;
  observe(listingId: string): Promise<SourceOutcome>;
};
