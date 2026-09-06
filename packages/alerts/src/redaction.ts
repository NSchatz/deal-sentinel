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
 * and the scrub is TWO RULES that back each other up, the same shape
 * `packages/sources/src/credential.ts` uses for the vendor key:
 *
 *   1. THE SECRET ITSELF, wherever it appears and however it got there;
 *   2. THE QUERY STRING of a credential-bearing parameter, whatever its value -
 *      which still works when the credential in hand is not the one that
 *      produced the text.
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

/** Replace the value of every credential-bearing query parameter. */
export function redactCredentialParameters(text: string): string {
  return text.replace(
    CREDENTIAL_PARAMETER_PATTERN,
    (_match, head: string) => `${head}${CREDENTIAL_PLACEHOLDER}`,
  );
}

/**
 * A redactor for the alert channel: the credential it was given, if any, plus
 * the parameter rule above. Holding the secret is what makes rule 1 possible;
 * the object exposes no way to read it back, so passing a redactor around is
 * not passing the credential around.
 */
export function channelRedactor(secret: string | null): Redactor {
  const trimmed = secret === null ? "" : secret.trim();
  return {
    scrub(text) {
      const withoutParameters = redactCredentialParameters(text);
      if (trimmed.length === 0) return withoutParameters;
      // `split`/`join` rather than a regular expression: a credential is
      // arbitrary text and may contain regex metacharacters, and an escaping
      // helper that got one case wrong would fail open.
      return withoutParameters.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
}

/**
 * The channel named the way a failure report may name it: scheme, host and
 * port, and nothing else.
 *
 * An operator has to know WHICH channel refused them, and the whole URL is the
 * one string that must not be the answer - the path is a topic (which the cited
 * channel's own documentation says "is essentially a password") and the query
 * may be the credential. The origin identifies the server and carries neither.
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
