/**
 * Finding offer candidates in a page's markup.
 *
 * Two readers, in the order BRIEF.md section 5 prefers structured sources:
 * embedded JSON-LD first, schema.org microdata second. Neither reader guesses:
 * a reader that finds nothing returns nothing, and `extractOffer` turns that
 * into a typed failure.
 *
 * There is no HTML parser dependency here on purpose. This package is held to
 * committed fixtures, it does no network and no filesystem access of its own,
 * and a scanner over saved markup is the smallest thing that keeps it pure.
 * A page whose markup defeats these scanners produces `no-offer`, which is a
 * visible gap rather than a wrong number.
 */

/** One offer's raw fields, exactly as the markup carried them. */
export type OfferCandidate = {
  /** The price field verbatim, or null when the offer carries none. */
  price: string | null;
  /** The priceCurrency field verbatim, or null when the offer carries none. */
  currency: string | null;
  /**
   * The availability field verbatim (outer whitespace trimmed and nothing
   * else), or "" when the offer declares no availability.
   */
  availability: string;
  /**
   * True when the offer states a price RANGE whose ends differ (an
   * AggregateOffer with lowPrice != highPrice). That is not exactly one offer
   * price, and `extractOffer` reports `ambiguous-offer` for it.
   */
  priceIsRange: boolean;
  /** Which reader produced this candidate. Diagnostic only. */
  reader: "json-ld" | "microdata";
};

const JSON_LD_BLOCK =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

const OFFER_TYPES = new Set(["offer", "aggregateoffer"]);

export function findOfferCandidates(markup: string): OfferCandidate[] {
  const fromJsonLd = findJsonLdOffers(markup);
  if (fromJsonLd.length > 0) return fromJsonLd;
  return findMicrodataOffers(markup);
}

/* -------------------------------------------------------------------------- */
/* JSON-LD                                                                    */
/* -------------------------------------------------------------------------- */

function findJsonLdOffers(markup: string): OfferCandidate[] {
  const candidates: OfferCandidate[] = [];
  for (const block of matchAll(JSON_LD_BLOCK, markup)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      // A block that is not JSON is not an offer. Skip it rather than guess at
      // its contents with a regex.
      continue;
    }
    collectJsonLdOffers(parsed, candidates, new Set());
  }
  return candidates;
}

function collectJsonLdOffers(
  node: unknown,
  out: OfferCandidate[],
  seen: Set<object>,
): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectJsonLdOffers(entry, out, seen);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);

  const record = node as Record<string, unknown>;

  if (isOfferNode(record)) {
    out.push(readJsonLdOffer(record));
    // Keep walking even after a hit: an offer can carry nested offers (a
    // variant list), and finding the second one is what makes a multi-offer
    // page visible as ambiguous instead of silently resolving to the first.
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "@context") continue;
    collectJsonLdOffers(value, out, seen);
  }
}

function isOfferNode(record: Record<string, unknown>): boolean {
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  for (const entry of types) {
    if (typeof entry !== "string") continue;
    const bare = entry.split("/").pop() ?? entry;
    if (OFFER_TYPES.has(bare.toLowerCase())) return true;
  }
  return false;
}

function readJsonLdOffer(record: Record<string, unknown>): OfferCandidate {
  const price = readPrice(record);
  return {
    price: price.value,
    currency: scalarOf(record["priceCurrency"]),
    availability: scalarOf(record["availability"]) ?? "",
    priceIsRange: price.isRange,
    reader: "json-ld",
  };
}

/**
 * An AggregateOffer states a range. A range whose ends agree is one price; a
 * range whose ends differ is not "exactly one offer price", so it is reported
 * as a range and `extractOffer` answers `ambiguous-offer`.
 */
function readPrice(record: Record<string, unknown>): {
  value: string | null;
  isRange: boolean;
} {
  const direct = scalarOf(record["price"]);
  if (direct !== null) return { value: direct, isRange: false };

  const low = scalarOf(record["lowPrice"]);
  const high = scalarOf(record["highPrice"]);
  if (low !== null && high !== null && low === high) {
    return { value: low, isRange: false };
  }
  if (low !== null || high !== null) return { value: null, isRange: true };
  return { value: null, isRange: false };
}

/**
 * Read a scalar JSON-LD value as the string the markup carried. Numbers are
 * accepted because schema.org's `price` has expected types "Number or Text",
 * and are rendered by JavaScript's shortest round-trip form; a number that
 * renders in exponent form is refused rather than reinterpreted.
 */
function scalarOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const rendered = String(value);
    return rendered.includes("e") || rendered.includes("E") ? null : rendered;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // { "@id": "https://schema.org/InStock" } and { "@value": "12.99" } are
    // both shapes real markup uses.
    const id = record["@id"];
    if (typeof id === "string") return id.trim();
    const inner = record["@value"];
    if (typeof inner === "string" || typeof inner === "number") {
      return scalarOf(inner);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Microdata                                                                  */
/* -------------------------------------------------------------------------- */

const ITEMTYPE_OFFER =
  /<[a-z][^>]*\bitemtype\s*=\s*["'][^"']*schema\.org\/(?:Aggregate)?Offer["'][^>]*>/gi;

const ITEMPROP_TAG =
  /<([a-z][a-z0-9]*)\b([^>]*\bitemprop\s*=\s*["'][^"']*["'][^>]*)>/gi;

/**
 * A deliberately small microdata reader: it recognises a page whose offer is
 * expressed as `itemtype="https://schema.org/Offer"` with `itemprop` fields,
 * and it counts the offer elements so a multi-offer page is still visible as
 * more than one candidate. It does not scope each itemprop to its own offer
 * element, so a page with several microdata offers yields several identical
 * candidates and resolves to `ambiguous-offer` - the safe direction.
 */
function findMicrodataOffers(markup: string): OfferCandidate[] {
  const offerElements = matchAll(ITEMTYPE_OFFER, markup);
  if (offerElements.length === 0) return [];

  let price: string | null = null;
  let currency: string | null = null;
  let availability = "";

  for (const tag of matchAll(ITEMPROP_TAG, markup)) {
    const attributes = tag[2];
    const prop = attributeValue(attributes, "itemprop");
    if (prop === null) continue;
    const content =
      attributeValue(attributes, "content") ??
      attributeValue(attributes, "href") ??
      textAfter(markup, tag.index + tag[0].length);
    if (content === null) continue;
    const value = content.trim();
    if (value.length === 0) continue;

    if (prop === "price" && price === null) price = value;
    else if (prop === "priceCurrency" && currency === null) currency = value;
    else if (prop === "availability" && availability === "") {
      availability = value;
    }
  }

  const candidate: OfferCandidate = {
    price,
    currency,
    availability,
    priceIsRange: false,
    reader: "microdata",
  };
  return offerElements.map(() => ({ ...candidate }));
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(
    attributes,
  );
  return match === null ? null : match[1];
}

function textAfter(markup: string, from: number): string | null {
  const end = markup.indexOf("<", from);
  const text = markup.slice(from, end === -1 ? undefined : end);
  return text.trim().length === 0 ? null : text;
}

/* -------------------------------------------------------------------------- */

function matchAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags);
  let match = scanner.exec(text);
  while (match !== null) {
    found.push(match);
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
    match = scanner.exec(text);
  }
  return found;
}
