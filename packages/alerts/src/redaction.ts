/**
 * Everywhere a credential is forbidden to appear on the alert path, and the
 * scrub that makes that a property of the code rather than a habit.
 *
 * A notification channel is the single most dangerous place in this system for
 * a secret. The endpoint is operator-supplied and MAY BE A SECRET IN ITSELF -
 * a webhook URL is a bearer credential wearing a URL's clothes, and the channel
 * this repository's roadmap cites documents an `?auth=` query parameter as one
 * of its own authentication options. That URL then travels into places nobody
 * chose to put it: the governor quotes `url.href` inside its refusal details,
 * and a transport error message quotes it too. Both of those come back to this
 * package as text to report.
 *
 * So every string this package reports or stores goes through `scrub` first,
 * and the scrub is FOUR RULES that back each other up, the first three the same
 * shape `packages/sources/src/credential.ts` uses for the vendor key:
 *
 *   1. THE SECRET ITSELF, wherever it appears and however it got there;
 *   2. THE QUERY STRING of a credential-bearing parameter, whatever its value -
 *      which still works when the credential in hand is not the one that
 *      produced the text;
 *   3. THE USERINFO of any URL in the text - `scheme://user:password@host` -
 *      whatever the user and password are. A URL carries a credential in three
 *      places and rules 1 and 2 reach only two of them: userinfo is not the
 *      secret this redactor was handed (a channel credential travels in a
 *      header) and it is not a query parameter, so without this rule an
 *      operator's basic-auth endpoint quoted back inside a governor refusal or
 *      a transport error walks straight into a reported failure detail.
 *   4. THE CONFIGURED ENDPOINT, and any URL sharing its origin, cut down to
 *      that origin. Rules 1 to 3 are all DENYLISTS - a named secret, a named
 *      parameter, a named component - and the fourth place a URL keeps a
 *      credential defeats every denylist there is: THE PATH. A topic "is
 *      essentially a password" on the channel this repository's roadmap cites,
 *      a webhook path is a bearer token at three other vendors, and a query
 *      parameter one character off rule 2's list (`auth_token`, not `token`)
 *      is not on it either. Nobody can list those. So the endpoint is not
 *      filtered, it is REPLACED: whatever the governor or the transport quoted,
 *      what comes back out is the origin and nothing after it.
 *
 * WHAT THIS GUARANTEES, said exactly. `scrub` removes the credential it holds,
 * the value of a credential-bearing query parameter, the userinfo of a URL, and
 * everything after the origin of the channel's own endpoint. THE ENDPOINT DOES
 * NOT APPEAR IN A STRING THIS PACKAGE REPORTS OR STORES, however the governor
 * phrased its refusal - which is what lets a failure report name the channel
 * with `channelOrigin` and mean it. It still does NOT claim that an ARBITRARY
 * URL is safe to print once scrubbed: rules 1 to 3 are all any of us can do for
 * a URL nobody configured, which is why the notification path REFUSES a
 * credential-bearing listing link rather than scrubbing one into the owner's
 * alert. Scrubbing is the backstop for text somebody else composed; refusing is
 * what this package does with text of its own.
 *
 * Deliberately NOT imported from `packages/sources`. That package sits above
 * this one in the dependency order (it depends on the db and the governor and
 * nothing depends on it), and a channel that imported a retailer adapter's
 * package to borrow a regular expression would invert the layering for a
 * twenty-line function. The rule LIST differs too: `auth` belongs here because
 * a notification server documents it, and does not belong in a vendor API
 * redactor that has never seen one.
 */

/** What replaces a credential. Recognisable on sight, not a plausible secret. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/**
 * Query parameters whose VALUE is a credential, whatever the value is. Matched
 * case-insensitively: a query string is the destination's grammar, not ours.
 */
const CREDENTIAL_PARAMETERS = [
  "auth",
  "apiKey",
  "api_key",
  "key",
  "token",
  "access_token",
  "password",
];

const CREDENTIAL_PARAMETER_PATTERN = new RegExp(
  `([?&](?:${CREDENTIAL_PARAMETERS.join("|")})=)[^&#\\s]*`,
  "gi",
);

/** Turns any string into one that carries no credential. */
export type Redactor = {
  scrub(text: string): string;
};

/**
 * The userinfo component of a URL: everything between `scheme://` and the `@`
 * that ends it. Matched in ARBITRARY TEXT rather than on a parsed `URL`, because
 * what arrives at `scrub` is a sentence with a URL quoted inside it - a governor
 * refusal detail, or a transport error whose message quotes the whole href.
 *
 * The character class stops at anything that cannot appear in userinfo (RFC 3986
 * section 3.2.1), so a `@` in a path or a query - `.../p?to=a@b.example` - is not
 * mistaken for one: the class cannot cross the `/` or `?` that precedes it.
 */
const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/?#@]+)@/g;

/** Replace the value of every credential-bearing query parameter. */
export function redactCredentialParameters(text: string): string {
  return text.replace(
    CREDENTIAL_PARAMETER_PATTERN,
    (_match, head: string) => `${head}${CREDENTIAL_PLACEHOLDER}`,
  );
}

/** Replace the userinfo of every URL in the text, user name and password both. */
export function redactUrlUserinfo(text: string): string {
  return text.replace(
    URL_USERINFO_PATTERN,
    (_match, scheme: string) => `${scheme}${CREDENTIAL_PLACEHOLDER}@`,
  );
}

/**
 * Both URL rules at once: userinfo, then credential-bearing query values.
 *
 * This is what "credential-bearing URL" MEANS in this package, and it is applied
 * in exactly two places: inside `scrub`, and as the test by which `usableLink`
 * refuses a listing link. One definition, so the scrub and the refusal cannot
 * drift apart.
 *
 * Note what it is NOT: a claim that what comes back is safe to print. It is a
 * denylist, and a credential in a URL's PATH is on nobody's denylist. For the
 * one URL this package knows the identity of - the configured endpoint -
 * `redactEndpointUrls` replaces rather than filters, and that is the rule the
 * guarantee at the top of this file rests on.
 */
export function redactUrlCredentials(text: string): string {
  return redactCredentialParameters(redactUrlUserinfo(text));
}

/** Escapes a string for use as a literal inside a regular expression. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every URL sharing the endpoint's origin, matched wherever it sits in a
 * sentence somebody else composed.
 *
 * Built from the endpoint's SCHEME AND HOST rather than from `origin` as a
 * literal, so that a quoted form carrying userinfo (`https://user:pw@host/x`,
 * where the origin string is not even a substring) or an explicit port is
 * matched too. The tail is everything up to whitespace, refusing to END on the
 * punctuation that closes a sentence rather than a URL - so `.../topic.` gives
 * back the sentence's full stop and `(.../topic)` gives back its bracket.
 */
function endpointUrlPattern(url: URL): RegExp {
  const scheme = escapeForRegExp(url.protocol.slice(0, -1));
  const host = escapeForRegExp(url.hostname);
  return new RegExp(
    `${scheme}://(?:[^\\s/?#@]+@)?${host}(?::\\d+)?` +
      `(?:[^\\s<>"']*[^\\s<>"'.,;:!?)\\]}])?`,
    "gi",
  );
}

/**
 * Rule 4: the configured endpoint, and anything else on its origin, reduced to
 * that origin.
 *
 * This is the rule that makes "a failure report never carries the endpoint"
 * true rather than intended. The governor quotes `url.href` verbatim inside an
 * `unconfigured-host` refusal and inside a transport error, and neither knows or
 * should know which component of that URL the operator made a secret. Reducing
 * to the origin needs to know none of that either: the origin names WHICH server
 * refused, which is the only thing the report owes the operator, and the path,
 * the query and the userinfo all go, listed or not.
 */
export function redactEndpointUrls(text: string, endpoint: string): string {
  if (endpoint.length === 0) return text;

  const replacement = channelOrigin(endpoint);
  // The literal the operator wrote, first and by exact match: a string that
  // never parsed still has to disappear, and split/join needs no escaping.
  const withoutLiteral = text.split(endpoint).join(replacement);

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // Unreachable through the loader, which refuses an endpoint that is not an
    // absolute http or https URL. There is no origin to reduce anything to.
    return withoutLiteral;
  }
  if (url.origin === "null") return withoutLiteral;

  return withoutLiteral.replace(endpointUrlPattern(url), replacement);
}

/**
 * A redactor for the alert channel: the credential it was given, if any, the
 * endpoint it was given, if any, and the URL rules above. Holding the secret is
 * what makes rule 1 possible; the object exposes no way to read either of them
 * back, so passing a redactor around is not passing the credential around.
 *
 * The endpoint is optional because a redactor is also built to scrub text with
 * no channel in the picture; given one, rule 4 applies and the guarantee at the
 * top of this file holds. `governedChannel` always passes it.
 */
export function channelRedactor(
  secret: string | null,
  endpoint: string | null = null,
): Redactor {
  const trimmed = secret === null ? "" : secret.trim();
  return {
    scrub(text) {
      // Rule 4 FIRST, while the endpoint in the text is still the string the
      // operator wrote. A rule that ran before it would insert `[redacted]`
      // into the middle of that URL and leave rule 4 hunting a string nobody
      // ever configured, with the path still sitting beside it.
      const withoutEndpoint =
        endpoint === null ? text : redactEndpointUrls(text, endpoint);
      const withoutUrlCredentials = redactUrlCredentials(withoutEndpoint);
      if (trimmed.length === 0) return withoutUrlCredentials;
      // `split`/`join` rather than a regular expression: a credential is
      // arbitrary text and may contain regex metacharacters, and an escaping
      // helper that got one case wrong would fail open.
      return withoutUrlCredentials.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
}

/**
 * Does this endpoint keep a credential in its userinfo component?
 *
 * Asked on the PARSED URL rather than through the redactor, and deliberately:
 * the redactor's rules also cover a credential-bearing query parameter and the
 * path, and an endpoint carrying one of those is an ordinary webhook URL, which
 * this system accepts and never prints. Userinfo is the case that is REFUSED -
 * by the channel, which will not send to one, and by the start check, which will
 * not let a box start pointed at one - so it is the case this predicate names.
 *
 * It lives here, beside the redaction rules, so that the two refusals and the
 * scrub cannot drift apart the way a copy in each caller would.
 */
export function carriesUserinfo(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    // Unreachable through the loader, which refuses an endpoint that does not
    // parse. A string that is not a URL carries no userinfo either.
    return false;
  }
}

/**
 * The channel named the way a failure report may name it: scheme, host and
 * port, and nothing else.
 *
 * An operator has to know WHICH channel refused them, and the whole URL is the
 * one string that must not be the answer - the userinfo is a credential outright,
 * the path is a topic (which the cited channel's own documentation says "is
 * essentially a password") and the query may be the credential too. The origin
 * identifies the server and carries none of the three.
 *
 * This is also what rule 4 replaces the endpoint WITH, so it is the one place
 * that decides how much of a channel's URL is ever printed.
 */
export function channelOrigin(endpoint: string): string {
  try {
    const origin = new URL(endpoint).origin;
    // A scheme with no origin of its own answers the literal string "null",
    // which names nothing and is not something to print at an operator.
    return origin === "null" ? "the configured channel" : origin;
  } catch {
    // Unreachable through the loader, which refuses an endpoint that is not an
    // absolute http or https URL. Answered without echoing the string, because
    // the one thing that must not happen here is printing it.
    return "the configured channel";
  }
}
