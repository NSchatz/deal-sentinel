/**
 * The common source interface.
 *
 * CLAUDE.md rule 4: "Per-site code is the part that breaks. Keep every retailer
 * behind a common adapter interface, keep parsers pure, and test them against
 * saved fixtures." So an adapter is one method over one listing, its parser is a
 * separate pure function, and everything a run needs to decide what to do next
 * is in the OUTCOME rather than in an exception. A thrown error carries no
 * vocabulary a run can branch on without matching message text.
 *
 * An adapter takes a `Governor` and reaches the network only through
 * `Governor.request`. It does not take a transport, it does not import an HTTP
 * client, and `test/unit/no-direct-http.test.ts` fails the suite if any file in
 * this package names one.
 *
 * The five outcomes are exhaustive and each one has exactly one right response,
 * which is why they are five and not a boolean plus a message:
 *
 *   `observed`         a price resolved. Write it.
 *   `extraction-failed` the payload did not resolve to exactly one exact price
 *                      in one ISO 4217 currency. Record the typed reason and
 *                      write NOTHING - a gap is visible a week later and a
 *                      wrong number is not.
 *   `governor-refused` one of the six gates declined. Nothing left the process.
 *                      Do not retry inside this run: every refusal reason is a
 *                      condition that waiting inside one run cannot clear, and
 *                      three of them exist precisely to reduce traffic.
 *   `limit-exceeded`   the SOURCE said the limit is exceeded. Stop the source
 *                      for the period, notify once, never retry.
 *   `source-error`     anything else the source answered. Record and continue
 *                      with the remaining entries.
 */

import type { RefusalReason } from "@deal-sentinel/governor";
import type { ExtractionFailureReason } from "@deal-sentinel/shared";

/** A resolved observation, ready for the write path. */
export type ObservationDraft = {
  amountMinorUnits: bigint;
  currency: string;
  /** schema.org ItemAvailability as received; empty means the source declared none. */
  availability: string;
  /** The vendor's own price-update instant, or null where it publishes none. */
  vendorPriceUpdatedAt: Date | null;
  /**
   * Enough of the payload to debug a mapping break, REDACTED and bounded. No
   * credential ever reaches this string: it is what lands in a stored column.
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
 * One retailer, behind one method.
 *
 * Deliberately NOT named for the verb the governor's own check forbids
 * elsewhere in this repository: `observe` says what this returns - an
 * observation or a typed reason there is none - rather than how it got it.
 */
export type SourceAdapter = {
  readonly sourceId: string;
  observe(listingId: string): Promise<SourceOutcome>;
};
