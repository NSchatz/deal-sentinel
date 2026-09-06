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
 * and the scrub is THREE RULES that back each other up, the same shape
 * `packages/sources/src/credential.ts` uses for the vendor key:
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
 *
 * WHAT THIS GUARANTEES, said exactly. `scrub` removes the credential it holds,
 * the value of a credential-bearing query parameter, and the userinfo of a URL.
 * It does NOT claim that a URL is safe to print once scrubbed - a path can be a
 * topic and a topic "is essentially a password" on the channel this repository's
 * roadmap cites - which is why a failure report names the channel with
 * `channelOrigin` and never with its endpoint, and why the notification path
 * REFUSES a credential-bearing listing link rather than scrubbing one into the
 * owner's alert. Scrubbing is the backstop for text somebody else composed;
 * refusing is what this package does with text of its own.
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
 */
export function redactUrlCredentials(text: string): string {
  return redactCredentialParameters(redactUrlUserinfo(text));
}

/**
 * A redactor for the alert channel: the credential it was given, if any, plus
 * the two URL rules above. Holding the secret is what makes rule 1 possible;
 * the object exposes no way to read it back, so passing a redactor around is
 * not passing the credential around.
 */
export function channelRedactor(secret: string | null): Redactor {
  const trimmed = secret === null ? "" : secret.trim();
  return {
    scrub(text) {
      const withoutUrlCredentials = redactUrlCredentials(text);
      if (trimmed.length === 0) return withoutUrlCredentials;
      // `split`/`join` rather than a regular expression: a credential is
      // arbitrary text and may contain regex metacharacters, and an escaping
      // helper that got one case wrong would fail open.
      return withoutUrlCredentials.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
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
 */
export function channelOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    // Unreachable through the loader, which refuses an endpoint that is not an
    // absolute http or https URL. Answered without echoing the string, because
    // the one thing that must not happen here is printing it.
    return "the configured channel";
  }
}
