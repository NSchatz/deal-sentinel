/**
 * Composing the notification, and the one thing that stops it being sent.
 *
 * EVERY ALERT CARRIES ITS REASON. CLAUDE.md rule 6 and BRIEF.md section 4 both
 * say it, and the roadmap phase's first assertion spells out what "reason"
 * means here: the rule that fired, the observed price, the reference price it
 * was compared against, and a link to the listing. All four are in the body of
 * every notification this module produces, and the prices are printed from
 * their exact minor units by their own currency's ISO 4217 exponent - no float
 * appears between a stored row and the sentence the owner reads.
 *
 * THE LINK IS THE OWNER'S OR THERE IS NO ALERT. Nothing in this system can
 * derive a page a human opens: a watchlist entry carries the source's own
 * listing key, and the one URL an adapter builds is an API endpoint with a
 * credential in its query string. So the link comes from
 * `watchlist_entries.listing_url` and from nowhere else, and where it is
 * absent, unusable or itself credential-bearing the notification is NOT SENT
 * and the listing is reported by name. An alert whose link goes nowhere is an
 * alert the owner cannot act on, which is the whole promise of the phase; an
 * alert whose link carries a credential is worse than no alert at all.
 *
 * THE CLEARANCE ENDING IS A TAG AND NEVER A TRIGGER. It is attached here, after
 * a rule has already fired, and this module offers no way to produce a
 * notification without a verdict that fired. There is nothing to remember at a
 * call site.
 */

import { formatMinorUnits } from "@deal-sentinel/extractor";

import { clearanceTagFor } from "./clearance.ts";
import type { ClearanceTag } from "./clearance.ts";
import { redactUrlCredentials } from "./redaction.ts";
import type { RuleVerdict } from "./rules.ts";

/** The listing an alert is about, as the evaluation run knows it. */
export type AlertSubject = {
  sourceId: string;
  listingId: string;
  /** The owner's link, or null. Null is why an alert is not sent. */
  listingUrl: string | null;
};

export type AlertNotification = {
  ruleId: string;
  sourceId: string;
  listingId: string;
  /** One line, no line breaks: it is also a header value on some channels. */
  title: string;
  /** The whole alert, self-explaining, link included. */
  body: string;
  /** The owner's link, validated. Also a header value on some channels. */
  listingUrl: string;
  observedMinorUnits: bigint;
  referenceMinorUnits: bigint;
  currency: string;
  clearance: ClearanceTag | null;
};

export type Composition =
  | { composed: true; notification: AlertNotification }
  | {
      composed: false;
      reason: "undeliverable-link";
      listingId: string;
      /** Names the listing and the defect. Never quotes the link itself. */
      detail: string;
    };

/**
 * How long a link may be before this system will not carry it. Generous for a
 * retailer URL with tracking parameters on it, and short of the length at which
 * a "link" is really a pasted document.
 */
const MAX_LINK_CHARS = 2048;

/**
 * Compose the notification a fired verdict owes, or refuse to send one.
 *
 * Takes a verdict that FIRED - the type says so - so there is no path from this
 * module to a notification that no rule produced, and the clearance ending
 * therefore cannot be the reason one exists.
 */
export function composeNotification(
  verdict: Extract<RuleVerdict, { fired: true }>,
  subject: AlertSubject,
  options: { clearanceEndings?: readonly string[] } = {},
): Composition {
  const link = usableLink(subject.listingUrl);
  if (link === null) {
    return {
      composed: false,
      reason: "undeliverable-link",
      listingId: subject.listingId,
      detail:
        `${verdict.ruleId} fired for ${subject.sourceId}/${subject.listingId} ` +
        "and no notification was sent: that watchlist entry carries no link " +
        "the owner can open, or the link it carries is not an absolute http " +
        "or https URL, is longer than " +
        `${MAX_LINK_CHARS} characters, or carries a credential - in its query ` +
        "string or in its userinfo. Nothing is invented in its place. Add the " +
        "listing's own page URL to the watchlist entry and the next run will " +
        "alert on it.",
    };
  }

  const clearance = clearanceTagFor(
    verdict.observed.amountMinorUnits,
    options.clearanceEndings ?? [],
  );

  const observed = formatMinorUnits(
    verdict.observed.amountMinorUnits,
    verdict.observed.currency,
  );
  const reference = formatMinorUnits(
    verdict.reference.amountMinorUnits,
    verdict.reference.currency,
  );

  const title = `${observed} on ${subject.listingId} (${verdict.ruleId})`;

  const lines = [
    `${verdict.ruleId} fired for ${subject.sourceId}/${subject.listingId}.`,
    `Observed ${observed} at ${verdict.observed.observedAt.toISOString()}.`,
    `It beats ${reference}, the lowest of the ${verdict.windowCount} ` +
      `observation(s) in the window, seen ` +
      `${verdict.reference.observedAt.toISOString()}.`,
    link,
  ];

  if (clearance !== null) {
    // Said in the alert itself, because the owner is the one who has to weigh
    // it: this is corroboration for a rule that already fired, and it is
    // community lore that the brief calls unreliable.
    lines.push(
      `Price ends in ${clearance.ending}, which is one of the endings you ` +
        "configured for this source. That is a corroborating tag only: it did " +
        "not trigger this alert and it never can.",
    );
  }

  return {
    composed: true,
    notification: {
      ruleId: verdict.ruleId,
      sourceId: subject.sourceId,
      listingId: subject.listingId,
      title: singleLine(title),
      body: lines.join("\n"),
      listingUrl: link,
      observedMinorUnits: verdict.observed.amountMinorUnits,
      referenceMinorUnits: verdict.reference.amountMinorUnits,
      currency: verdict.observed.currency,
      clearance,
    },
  };
}

/**
 * The owner's link if it is one this system will put in front of them, and null
 * otherwise. Four refusals, and every one of them ends in "no alert":
 *
 *   - absent. There is nothing to derive it from;
 *   - not an absolute http or https URL. A relative path opens nothing, and a
 *     `javascript:` or `data:` link is not a listing;
 *   - longer than the bound. A notification is a phone screen;
 *   - carrying a credential, in EITHER of the two places a URL keeps one: a
 *     credential-bearing query parameter (the vendor API URL pasted into the
 *     wrong field) or the userinfo component, `https://user:password@host/path`.
 *     A notification is the one place either must never reach - a phone, a push
 *     service and a notification history are three copies nobody can recall -
 *     and scrubbing is not the answer here: a link the owner is meant to TAP has
 *     to be the real one, so a link that cannot be sent whole is not sent.
 */
function usableLink(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LINK_CHARS) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The redactor is the AUTHORITY on what counts as credential-bearing, so the
  // check and the scrub cannot drift apart: if scrubbing changes the URL, the
  // URL carries something that must not be sent. `redactUrlCredentials` covers
  // both places a URL keeps a credential, so a userinfo link is refused here on
  // the same authority a `?token=` one is.
  if (redactUrlCredentials(url.href) !== url.href) return null;

  return url.href;
}

/** A title is one line: on several channels it is also a header value. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}
