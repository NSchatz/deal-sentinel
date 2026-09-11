/**
 * What each source's OWN PUBLISHED TERMS require of this system.
 *
 * Deliberately not in `config/`: configuration is what the owner chose, this
 * is what a third party published, and an absent ceiling must not read the
 * same as a source whose terms declare none. Every value carries its quote.
 */

export type SourceTerms = {
  attributeTo: string;
  attributionRequired: boolean;
  /**
   * The CEILING on holding raw content, in hours, not the setting: a
   * configuration above it is refused, and so is a source whose terms declare
   * one while the configuration declares none. Null where the terms declare no
   * ceiling.
   */
  rawContentCeilingHours: number | null;
  /** An upper bound on what may be configured, never a target. */
  documentedCallsPerSecond: number | null;
  documentedCallsPerDay: number | null;
  /** Never retried: the vendor has answered, and asking again cannot help. */
  limitExceededStatuses: readonly number[];
  /** Provenance, carried with the fact. */
  citations: readonly string[];
};

/** The sanctioned API's source id, as `config/governor.json` already names it. */
export const BESTBUY_API_SOURCE_ID = "bestbuy-api";

export const SOURCE_TERMS: Readonly<Record<string, SourceTerms>> = {
  [BESTBUY_API_SOURCE_ID]: {
    attributeTo: "Best Buy",
    // "clearly and conspicuously attribute the source of all Content as
    // received from Best Buy" (Display of Content; Attribution and Goodwill)
    attributionRequired: true,
    // "not to exceed seventy-two (72) hours solely as necessary to provide
    // better response times for displaying such Content" (Prohibited Uses)
    rawContentCeilingHours: 72,
    // Rate Limit table: 50,000 calls per day, 5 calls per second.
    documentedCallsPerSecond: 5,
    documentedCallsPerDay: 50_000,
    // "an error response with a 403 status code" once the limit is reached
    // (Rate Limit).
    limitExceededStatuses: [403],
    citations: [
      "https://developer.bestbuy.com/legal",
      "https://bestbuyapis.github.io/api-documentation/",
    ],
  },
};

export function termsFor(sourceId: string): SourceTerms | null {
  return SOURCE_TERMS[sourceId] ?? null;
}
