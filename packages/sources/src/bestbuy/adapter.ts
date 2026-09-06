/**
 * The sanctioned API adapter: the first thing in this repository that can put a
 * real price into the history, and the first that can reach a third party.
 *
 * IT TAKES A `Governor` AND NOTHING THAT CAN SEND. Every byte it receives came
 * back through `Governor.request`, on the far side of the host ceiling, the
 * randomised delay, the robots decision, the back-pressure hold, the breaker
 * and the allowance. It holds no transport, imports no client, and there is a
 * repository-wide check that fails the suite if this file ever names one.
 *
 * THE CREDENTIAL TRAVELS IN THE QUERY STRING, because that is the only place
 * this vendor accepts it: its own documented call is
 * `.../v1/products/8880044.json?show=sku,name,salePrice&apiKey=YourAPIKey`. So
 * the key is inside every URL this file builds, and the URL is inside the
 * response the vendor echoes back as `canonicalUrl`, inside any transport error
 * message, and inside anything a caller might print. Not one string leaves this
 * method without passing through the redactor first - the stored raw context,
 * every outcome's `detail`, and the reason recorded on a stop. That is why the
 * redactor is a constructor argument rather than a call somebody has to
 * remember at each return.
 *
 * THE REQUEST ASKS FOR THE FIVE FIELDS IT READS AND NO MORE. `show=` is the
 * vendor's own projection, and narrowing it is two safeguards in one: the
 * response cannot carry a review body, a reviewer name or an account
 * identifier - the fixture invariant this repository holds over stored content
 * - and the raw context that lands in a column is small enough to be worth
 * keeping for the seventy-two hours the terms allow.
 */

import type { Governor } from "@deal-sentinel/governor";

import type { SourceAdapter, SourceOutcome } from "../adapter.ts";
import { credentialRedactor, readCredential } from "../credential.ts";
import type { Redactor } from "../credential.ts";
import type { SourceEntry } from "../registry.ts";
import { BESTBUY_API_SOURCE_ID } from "../terms.ts";
import { mapVendorPayload } from "./mapping.ts";

/**
 * The vendor attributes this adapter asks for. Every one is read by
 * `mapVendorPayload`, except `name`, which is what a display or export path
 * shows a human beside the price.
 */
export const REQUESTED_ATTRIBUTES = [
  "sku",
  "name",
  "salePrice",
  "regularPrice",
  "onSale",
  "priceUpdateDate",
] as const;

/**
 * How much of a response body is kept as raw context. Under the column's own
 * 8192-character bound, because a projected product document is small and a
 * cap that is never reached is a cap nobody has thought about.
 */
export const RAW_CONTEXT_BUDGET = 4096;

/**
 * A Best Buy sku, as the vendor describes it: "Best Buy unique 7-digit product
 * identifier". Bounded at both ends rather than assumed to be seven, because a
 * watchlist entry is owner-supplied text that is about to become part of a URL
 * path, and the only safe answer to "what if it is not a sku" is to not build
 * the URL.
 */
const SKU_PATTERN = /^[0-9]{1,12}$/;

export type BestBuyAdapterDependencies = {
  governor: Governor;
  entry: SourceEntry;
  /**
   * The credential, already read. Passed in rather than read here so that a
   * caller must have obtained it - and been refused if it was absent - before
   * an adapter exists at all.
   */
  credential: string;
};

/**
 * Build the adapter, or refuse.
 *
 * `readCredential` throws `MissingCredentialError` when the variable is absent
 * or empty, so the refusal happens HERE, before anything can be sent. An
 * unauthenticated request would be answered 403 by this vendor - the same
 * status it uses for an exceeded call limit - so sending one would both spend a
 * real request and land the source in a stop it did not earn.
 */
export function createBestBuyAdapter(
  governor: Governor,
  entry: SourceEntry,
  env: NodeJS.ProcessEnv = process.env,
): SourceAdapter {
  const credential = readCredential(entry.sourceId, entry.credentialVariable, env);
  return bestBuyAdapter({ governor, entry, credential });
}

export function bestBuyAdapter(
  dependencies: BestBuyAdapterDependencies,
): SourceAdapter {
  const { governor, entry, credential } = dependencies;
  const redactor: Redactor = credentialRedactor(credential);
  const sourceId = entry.sourceId;
  const limitExceeded = new Set(entry.terms?.limitExceededStatuses ?? [403]);

  return {
    sourceId,

    async observe(listingId): Promise<SourceOutcome> {
      const sku = listingId.trim();
      if (!SKU_PATTERN.test(sku)) {
        // Nothing is sent. A watchlist entry that is not a sku cannot be turned
        // into this vendor's URL, and turning it into one anyway would put
        // owner-supplied text into a path.
        return {
          kind: "source-error",
          listingId,
          status: null,
          detail:
            `${JSON.stringify(listingId)} is not a Best Buy sku, which the ` +
            "vendor documents as a numeric product identifier. No request was " +
            "made for it.",
        };
      }

      const url = buildProductUrl(entry.baseUrl, sku, credential);

      const outcome = await governor.request({ url, sourceId });

      if (!outcome.ok) {
        // Every one of the governor's refusal reasons lands here, including
        // `transport-error`. None of them is retried inside a run: three of
        // them exist to reduce traffic, two say an answer this governor holds
        // has expired, and the rest are conditions a wait inside one run
        // cannot clear.
        return {
          kind: "governor-refused",
          listingId,
          reason: outcome.reason,
          detail: redactor.scrub(outcome.detail),
        };
      }

      const { status, body } = outcome.response;

      if (limitExceeded.has(status)) {
        return {
          kind: "limit-exceeded",
          listingId,
          status,
          detail: redactor.scrub(
            `${sourceId} answered ${status} for sku ${sku}. The vendor ` +
              "documents that status as \"the API key is not valid, or the " +
              "allocated call limit has been exceeded\", and its terms " +
              "document it as the answer to an exceeded rate limit. Neither " +
              "reading is improved by asking again.",
          ),
        };
      }

      if (status < 200 || status > 299) {
        return {
          kind: "source-error",
          listingId,
          status,
          detail: redactor.scrub(
            `${sourceId} answered ${status} for sku ${sku}: ` +
              `${summarise(body)}`,
          ),
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        return {
          kind: "extraction-failed",
          listingId,
          reason: "no-offer",
          detail: redactor.scrub(
            `the body returned for sku ${sku} is not parseable as JSON, so it ` +
              "carries no product document: " +
              `${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }

      const mapped = mapVendorPayload(payload, sku, {
        currency: entry.currency,
        timeZone: entry.timeZone,
      });

      if (!mapped.ok) {
        return {
          kind: "extraction-failed",
          listingId,
          reason: mapped.reason,
          detail: redactor.scrub(mapped.detail),
        };
      }

      return {
        kind: "observed",
        listingId,
        draft: {
          amountMinorUnits: mapped.amountMinorUnits,
          currency: mapped.currency,
          availability: mapped.availability,
          vendorPriceUpdatedAt: mapped.vendorPriceUpdatedAt,
          // The whole response body, redacted and bounded. The redaction is
          // not belt-and-braces: this vendor echoes the request URL back
          // inside the document as `canonicalUrl`, credential and all.
          rawContext: bound(redactor.scrub(body)),
        },
      };
    },
  };
}

/**
 * The vendor's own single-product call, built.
 *
 * Every component that comes from outside is encoded: the sku has already been
 * checked against `SKU_PATTERN`, and the credential goes through
 * `URLSearchParams`, which escapes it. A key with a `&` in it would otherwise
 * end the parameter and send the rest as another one.
 */
export function buildProductUrl(
  baseUrl: string,
  sku: string,
  credential: string,
): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`products/${encodeURIComponent(sku)}.json`, root);
  url.searchParams.set("show", REQUESTED_ATTRIBUTES.join(","));
  url.searchParams.set("apiKey", credential);
  return url.href;
}

/** The source id this adapter serves, re-exported where a caller wires it up. */
export { BESTBUY_API_SOURCE_ID };

function bound(text: string): string {
  if (text.length <= RAW_CONTEXT_BUDGET) return text;
  const marker = `\n<!-- truncated at ${RAW_CONTEXT_BUDGET} characters -->`;
  return text.slice(0, RAW_CONTEXT_BUDGET - marker.length) + marker;
}

/**
 * A response body, cut down for a message. Bounded hard: an error path is
 * exactly where an enormous body would otherwise be pasted into a notification.
 */
function summarise(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "the body was empty.";
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 200)}...`;
}
