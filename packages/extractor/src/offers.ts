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
 * and a tag scanner over saved markup is the smallest thing that keeps it pure.
 * A page whose markup defeats these scanners produces `no-offer`, which is a
 * visible gap rather than a wrong number.
 */

/** One offer's raw fields, exactly as the markup carried them. */
export type OfferCandidate = {
  /**
   * Every DISTINCT price value this one offer stated, in document order. An
   * offer that states none is `no-price`. An offer that states two spellings of
   * the same price ("129.99" on a `<meta>` and "$129.99" in the visible text)
   * is one price, and `extractOffer` establishes that by comparing them in the
   * currency's own minor units rather than as strings. An offer that states two
   * DIFFERENT prices does not state exactly one offer price.
   */
  prices: string[];
  /**
   * Every DISTINCT priceCurrency value this one offer stated, trimmed and upper
   * cased. More than one is not "its ISO 4217 currency".
   */
  currencies: string[];
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
  const price = readJsonLdPrice(record);
  const currency = scalarOf(record["priceCurrency"]);
  return {
    // A JSON-LD offer is an object, so each field carries at most one value.
    prices: price.value === null ? [] : [price.value],
    currencies: currency === null ? [] : [normaliseCode(currency)],
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
function readJsonLdPrice(record: Record<string, unknown>): {
  value: string | null;
  isRange: boolean;
} {
  const direct = scalarOf(record["price"]);
  if (direct !== null) return { value: direct, isRange: false };

  return readRange(scalarOf(record["lowPrice"]), scalarOf(record["highPrice"]));
}

/** The same range rule, shared by both readers so they cannot drift apart. */
function readRange(
  low: string | null,
  high: string | null,
): { value: string | null; isRange: boolean } {
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

/**
 * A deliberately small microdata reader, and the one rule that makes it safe:
 * **every property is scoped to the offer element that encloses it.**
 *
 * Each element whose `itemtype` names a schema.org Offer or AggregateOffer
 * becomes ONE candidate, and that candidate is built only from the `itemprop`
 * elements inside that element's own extent, skipping the subtree of any nested
 * `itemscope` (a nested item's properties belong to the nested item, per the
 * microdata data model). So:
 *
 *   - a page with two offers at two different prices yields two DIFFERENT
 *     candidates, which `extractOffer` reports as `ambiguous-offer`; and
 *   - an unrelated priced item elsewhere on the page cannot supply this offer's
 *     price, because its `itemprop` is not inside this offer's extent.
 *
 * A document-wide scan of every `itemprop` gets both of those wrong in the
 * SILENT direction - it attributes the first price it meets to every offer on
 * the page - which is the price-history poisoning this phase exists to prevent.
 */
function findMicrodataOffers(markup: string): OfferCandidate[] {
  const tags = tokenizeTags(markup);
  const candidates: OfferCandidate[] = [];

  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.kind === "close") continue;
    if (!isOfferElement(tag)) continue;

    // A void or self-closing offer element has no extent to read from; an
    // ordinary one runs to its matching close tag.
    const end =
      tag.kind === "open" ? findElementEnd(tags, index, tags.length) : index + 1;
    candidates.push(readMicrodataOffer(markup, tags, index + 1, end));
  }

  return candidates;
}

const OFFER_ITEMTYPE = /(?:^|\/)schema\.org\/(?:Aggregate)?Offer$/i;

function isOfferElement(tag: MarkupTag): boolean {
  const itemtype = attributeValue(tag.attributes, "itemtype");
  if (itemtype === null) return false;
  // `itemtype` may carry several space-separated types.
  return itemtype
    .trim()
    .split(/\s+/)
    .some((type) => OFFER_ITEMTYPE.test(type));
}

/** Build one candidate from the properties directly inside one offer element. */
function readMicrodataOffer(
  markup: string,
  tags: MarkupTag[],
  from: number,
  to: number,
): OfferCandidate {
  const values = new Map<string, string[]>();

  let index = from;
  while (index < to) {
    const tag = tags[index];
    if (tag.kind === "close") {
      index += 1;
      continue;
    }

    const itemprop = attributeValue(tag.attributes, "itemprop");
    if (itemprop !== null) {
      const value = propertyValue(markup, tag);
      if (value !== null) {
        // `itemprop` is a token list: itemprop="price lowPrice" is legal.
        for (const name of itemprop.trim().split(/\s+/)) {
          addDistinct(values, name, value);
        }
      }
    }

    if (tag.kind === "open" && hasAttribute(tag.attributes, "itemscope")) {
      // A nested item owns its own properties. Skip its whole subtree: this is
      // the line that stops a seller, a shipping offer or a second variant from
      // donating fields to this offer.
      index = findElementEnd(tags, index, to);
      continue;
    }

    index += 1;
  }

  const prices = values.get("price") ?? [];
  const range =
    prices.length > 0
      ? { value: null, isRange: false }
      : readRange(firstOf(values, "lowPrice"), firstOf(values, "highPrice"));

  return {
    prices: prices.length > 0 ? prices : range.value === null ? [] : [range.value],
    currencies: (values.get("priceCurrency") ?? []).map(normaliseCode),
    availability: firstOf(values, "availability") ?? "",
    priceIsRange: range.isRange,
    reader: "microdata",
  };
}

/**
 * One property's value: the `content` attribute, else `href` (the shape
 * `<link itemprop="availability" href="https://schema.org/InStock">` uses),
 * else the text the element encloses.
 */
function propertyValue(markup: string, tag: MarkupTag): string | null {
  const content =
    attributeValue(tag.attributes, "content") ??
    attributeValue(tag.attributes, "href") ??
    textAfter(markup, tag.end);
  if (content === null) return null;
  const value = content.trim();
  return value.length === 0 ? null : value;
}

function addDistinct(
  values: Map<string, string[]>,
  name: string,
  value: string,
): void {
  const existing = values.get(name);
  if (existing === undefined) {
    values.set(name, [value]);
    return;
  }
  if (!existing.includes(value)) existing.push(value);
}

function firstOf(values: Map<string, string[]>, name: string): string | null {
  const found = values.get(name);
  return found === undefined || found.length === 0 ? null : found[0];
}

/* -------------------------------------------------------------------------- */
/* The tag scanner                                                            */
/* -------------------------------------------------------------------------- */

type MarkupTag = {
  /** Lower-cased element name. */
  name: string;
  /** The attribute text between the element name and the closing `>`. */
  attributes: string;
  /**
   * `open` elements have an extent and may contain properties; `void` elements
   * (`<meta>`, `<link>`, `<img>`, and any tag written self-closing) do not;
   * `close` is an end tag.
   */
  kind: "open" | "close" | "void";
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
};

/** HTML void elements: they never have an end tag, so they never open a scope. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text, not markup, and is skipped whole. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;

/**
 * Split markup into its tags, in document order. Comments, doctypes and the
 * contents of raw-text elements are skipped, so a `<` inside a JSON-LD block or
 * a comment cannot be mistaken for a tag.
 */
function tokenizeTags(markup: string): MarkupTag[] {
  const tags: MarkupTag[] = [];
  let cursor = 0;

  while (cursor < markup.length) {
    const open = markup.indexOf("<", cursor);
    if (open === -1) break;

    if (markup.startsWith("<!--", open)) {
      const close = markup.indexOf("-->", open + 4);
      cursor = close === -1 ? markup.length : close + 3;
      continue;
    }
    if (markup.startsWith("<!", open) || markup.startsWith("<?", open)) {
      const close = findTagEnd(markup, open + 1);
      cursor = close === -1 ? markup.length : close + 1;
      continue;
    }

    const closing = markup.startsWith("</", open);
    const nameStart = open + (closing ? 2 : 1);
    const nameMatch = TAG_NAME.exec(markup.slice(nameStart));
    if (nameMatch === null) {
      cursor = open + 1;
      continue;
    }

    const close = findTagEnd(markup, nameStart + nameMatch[0].length);
    if (close === -1) break;

    const name = nameMatch[0].toLowerCase();
    const attributes = markup.slice(nameStart + nameMatch[0].length, close);
    const selfClosing = attributes.trimEnd().endsWith("/");
    tags.push({
      name,
      attributes,
      kind: closing
        ? "close"
        : selfClosing || VOID_ELEMENTS.has(name)
          ? "void"
          : "open",
      start: open,
      end: close + 1,
    });
    cursor = close + 1;

    if (!closing && !selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      const endTag = new RegExp(`</${name}\\b`, "i").exec(markup.slice(cursor));
      cursor = endTag === null ? markup.length : cursor + endTag.index;
    }
  }

  return tags;
}

/** The index of the `>` that ends a tag, ignoring `>` inside quoted values. */
function findTagEnd(markup: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < markup.length; index += 1) {
    const character = markup[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

/**
 * The token index just past the end tag matching `tags[from]`, or `limit` when
 * the element is never closed. Unclosed markup therefore reads as a WIDER
 * extent, which can only add candidates and make a page ambiguous - the safe
 * direction - never narrow one offer into borrowing another's price.
 */
function findElementEnd(tags: MarkupTag[], from: number, limit: number): number {
  const { name } = tags[from];
  let depth = 0;
  for (let index = from; index < limit; index += 1) {
    const tag = tags[index];
    if (tag.name !== name) continue;
    if (tag.kind === "open") depth += 1;
    else if (tag.kind === "close") {
      depth -= 1;
      if (depth <= 0) return index + 1;
    }
  }
  return limit;
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(
    attributes,
  );
  return match === null ? null : match[1];
}

/** A valueless attribute, such as the `itemscope` in `<div itemscope ...>`. */
function hasAttribute(attributes: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, "i").test(attributes);
}

function textAfter(markup: string, from: number): string | null {
  const end = markup.indexOf("<", from);
  const text = markup.slice(from, end === -1 ? undefined : end);
  return text.trim().length === 0 ? null : text;
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
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
