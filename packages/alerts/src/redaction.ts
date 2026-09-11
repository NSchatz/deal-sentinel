/**
 * Everywhere a credential is forbidden to appear on the alert path, and the
 * scrub that makes that a property of the code rather than a habit.
 *
 * A notification endpoint is operator-supplied and MAY BE A SECRET IN ITSELF: a
 * webhook URL is a bearer credential wearing a URL's clothes. That URL travels
 * where nobody chose to put it - the governor quotes `url.href` inside its
 * refusal details, a transport error quotes it too - and both come back here as
 * text to report. So every string this package reports or stores goes through
 * `scrub`, which is four rules that back each other up:
 *
 *   1. the secret itself, wherever it appears;
 *   2. the value of a credential-bearing query parameter, whatever it is;
 *   3. the userinfo of any URL in the text, which rules 1 and 2 both miss: a
 *      channel credential travels in a header, and userinfo is not a query;
 *   4. the configured endpoint, and any URL sharing its origin, cut down to that
 *      origin. Rules 1 to 3 are denylists, and the fourth place a URL keeps a
 *      credential defeats every denylist there is: THE PATH. A topic "is
 *      essentially a password" on the channel this repository's roadmap cites.
 *      So the endpoint is not filtered, it is REPLACED.
 *
 * The guarantee is therefore that the endpoint does not appear in a string this
 * package reports or stores, however the governor phrased its refusal. It is
 * NOT that an ARBITRARY URL is safe to print once scrubbed, which is why the
 * notification path REFUSES a credential-bearing listing link rather than
 * scrubbing one into the owner's alert.
 */

/** What replaces a credential. Recognisable on sight, not a plausible secret. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/** Matched case-insensitively: a query string is the destination's grammar. */
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

export type Redactor = {
  scrub(text: string): string;
};

/**
 * Matched in ARBITRARY TEXT, because what arrives at `scrub` is a sentence with
 * a URL quoted inside it. The class stops at anything that cannot appear in
 * userinfo (RFC 3986 3.2.1), so a `@` in a path is not mistaken for one.
 */
const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/?#@]+)@/g;

export function redactCredentialParameters(text: string): string {
  return text.replace(
    CREDENTIAL_PARAMETER_PATTERN,
    (_match, head: string) => `${head}${CREDENTIAL_PLACEHOLDER}`,
  );
}

export function redactUrlUserinfo(text: string): string {
  return text.replace(
    URL_USERINFO_PATTERN,
    (_match, scheme: string) => `${scheme}${CREDENTIAL_PLACEHOLDER}@`,
  );
}

/**
 * What "credential-bearing URL" MEANS here, applied inside `scrub` and as the
 * test by which `usableLink` refuses a listing link: one definition, so the
 * scrub and the refusal cannot drift. It is a denylist, not a claim that what
 * comes back is safe to print.
 */
export function redactUrlCredentials(text: string): string {
  return redactCredentialParameters(redactUrlUserinfo(text));
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Built from the SCHEME AND HOST rather than from `origin` as a literal, so a
 * quoted form carrying userinfo or a port is matched too. The tail refuses to
 * END on punctuation that closes a sentence rather than a URL.
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
 * Rule 4. The governor quotes `url.href` verbatim and neither knows nor should
 * know which component the operator made a secret; reducing to the origin needs
 * to know none of that either.
 */
export function redactEndpointUrls(text: string, endpoint: string): string {
  if (endpoint.length === 0) return text;

  const replacement = channelOrigin(endpoint);
  // The literal the operator wrote, by exact match: a string that never parsed
  // still has to disappear, and split/join needs no escaping.
  const withoutLiteral = text.split(endpoint).join(replacement);

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // Unreachable through the loader, which refuses a non-absolute endpoint.
    return withoutLiteral;
  }
  if (url.origin === "null") return withoutLiteral;

  return withoutLiteral.replace(endpointUrlPattern(url), replacement);
}

/**
 * Holding the secret is what makes rule 1 possible; nothing here reads it or
 * the endpoint back, so passing a redactor around is not passing the credential
 * around. The endpoint is optional: a redactor is also built with no channel.
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
      // arbitrary text, and an escaping helper that got one case wrong would
      // fail open.
      return withoutUrlCredentials.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
}

/**
 * Asked on the PARSED URL rather than through the redactor: an endpoint with a
 * credential in its query or path is an ordinary webhook URL, which this system
 * accepts and never prints. Userinfo is the case REFUSED outright, by the
 * channel and by the start check, so it is the case this predicate names.
 */
export function carriesUserinfo(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    // Unreachable through the loader. A string that is not a URL has none.
    return false;
  }
}

/**
 * The channel named the way a failure report may name it. An operator has to
 * know WHICH channel refused them, and the whole URL is the one string that
 * must not be the answer. This is also what rule 4 replaces the endpoint WITH.
 */
export function channelOrigin(endpoint: string): string {
  try {
    const origin = new URL(endpoint).origin;
    // A scheme with no origin of its own answers the literal string "null".
    return origin === "null" ? "the configured channel" : origin;
  } catch {
    // Answered without echoing the string: the one thing that must not happen
    // here is printing it.
    return "the configured channel";
  }
}
