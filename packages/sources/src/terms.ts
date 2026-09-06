/**
 * What each source's OWN PUBLISHED TERMS require of this system.
 *
 * This table is not configuration and is deliberately not in `config/`. A
 * configuration file says what the owner chose; this says what a third party
 * published, and the owner does not get to choose it. Keeping the two apart is
 * what makes "configured without a ceiling its terms declare" a condition this
 * system can DETECT: if both facts lived in the same file, an absent ceiling
 * and a source with no ceiling would be the same document.
 *
 * Every value below is quoted from the documents carried into the spec folder
 * for S0033-deal-sentinel-source-3, and the quote is beside it. Changing one
 * means the vendor changed their terms, and that is a commit that says so.
 */

/** What one source's terms oblige, and what its documentation publishes. */
export type SourceTerms = {
  /** A human name for the party the content is received from. */
  attributeTo: string;
  /**
   * Whether the terms require content from this source to be attributed
   * wherever it is displayed or exported.
   */
  attributionRequired: boolean;
  /**
   * The longest this system may hold this source's raw content, in hours, or
   * null where the terms declare no ceiling.
   *
   * This is the CEILING, not the setting. The owner configures a retention
   * period at or below it; a configuration above it is refused, and a source
   * whose terms declare a ceiling and whose configuration declares none is
   * refused too, because content held under no ceiling at all is the one
   * outcome the clause exists to prevent.
   */
  rawContentCeilingHours: number | null;
  /**
   * The rate the vendor publishes, as an upper bound on what this system may
   * be configured to do. Null where the vendor publishes no such number.
   */
  documentedCallsPerSecond: number | null;
  documentedCallsPerDay: number | null;
  /**
   * The HTTP statuses this vendor documents as meaning "the limit is exceeded,
   * stop". A status here is never retried: the vendor has answered, and asking
   * again is the one action that cannot help.
   */
  limitExceededStatuses: readonly number[];
  /** Where each fact above was read. Provenance, carried with the fact. */
  citations: readonly string[];
};

/** The sanctioned API's source id, as `config/governor.json` already names it. */
export const BESTBUY_API_SOURCE_ID = "bestbuy-api";

export const SOURCE_TERMS: Readonly<Record<string, SourceTerms>> = {
  [BESTBUY_API_SOURCE_ID]: {
    attributeTo: "Best Buy",
    // "You must clearly and conspicuously attribute the source of all Content
    // as received from Best Buy." (Display of Content; Attribution and
    // Goodwill)
    attributionRequired: true,
    // "store or cache any Content except on a temporary basis not to exceed
    // seventy-two (72) hours solely as necessary to provide better response
    // times for displaying such Content." (Prohibited Uses)
    rawContentCeilingHours: 72,
    // The Rate Limit table: 50,000 calls per day and 5 calls per second for the
    // Products, Reviews, Stores, Categories, Recommendations and Buying Options
    // family.
    documentedCallsPerSecond: 5,
    documentedCallsPerDay: 50_000,
    // "If a request is made after the limit is reached, it results in an error
    // response with a 403 status code" (Rate Limit), and the documentation's
    // own error table: 403 is "The API key is not valid, or the allocated call
    // limit has been exceeded."
    limitExceededStatuses: [403],
    citations: [
      "https://developer.bestbuy.com/legal",
      "https://bestbuyapis.github.io/api-documentation/",
    ],
  },
};

/** The terms for a source, or null where this system holds none for it. */
export function termsFor(sourceId: string): SourceTerms | null {
  return SOURCE_TERMS[sourceId] ?? null;
}
