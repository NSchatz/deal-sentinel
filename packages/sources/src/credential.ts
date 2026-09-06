/**
 * The vendor credential: where it is read from, and everywhere it is forbidden
 * to appear.
 *
 * The sanctioned API takes its key IN THE QUERY STRING - the vendor's own
 * documented call is `.../v1/products/8880044.json?show=sku,name,salePrice&
 * apiKey=YourAPIKey` - which makes the credential part of every URL this
 * adapter builds. A URL is the single most-copied string in an HTTP client's
 * world: it is in the request, it is echoed by this vendor inside the response
 * body as `canonicalUrl`, it is what a transport error message quotes, and it
 * is what any reasonable log line would print. So the credential is not "kept
 * out of logs" by remembering not to print it. Every string that leaves this
 * package is put through `Redactor.scrub` first, and the scrub is TWO rules
 * that back each other up:
 *
 *   1. the SECRET ITSELF, wherever it appears and however it got there. This is
 *      the rule that catches a value echoed back inside a response body under a
 *      key nobody predicted;
 *   2. the QUERY PARAMETER, whatever its value. This is the rule that still
 *      works when the credential in hand is not the one that produced the text
 *      - a rotated key, a second key, a fixture recorded against a third - and
 *      it is what makes a URL safe to print before anyone has proved which key
 *      built it.
 *
 * Neither rule alone is enough, which is why there are two. `scrub` is total:
 * it takes any string and returns one, so a caller cannot forget to handle a
 * case, and there is no path in this package that formats a URL or a body into
 * a message without it.
 */

import { MissingCredentialError } from "./errors.ts";

/** What replaces a credential. Recognisable on sight, and not a plausible key. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/**
 * Query parameters whose VALUE is a credential, whatever the value is. Matched
 * case-insensitively because a query string is the vendor's grammar and not
 * this system's.
 */
const CREDENTIAL_PARAMETERS = ["apiKey", "api_key", "key", "token", "access_token"];

const CREDENTIAL_PARAMETER_PATTERN = new RegExp(
  `([?&](?:${CREDENTIAL_PARAMETERS.join("|")})=)[^&#\\s]*`,
  "gi",
);

/** Turns any string into one that carries no credential. */
export type Redactor = {
  scrub(text: string): string;
};

/**
 * A redactor that knows nothing but the query-parameter rule. Used where no
 * credential is in hand - a governor refusal, a configuration error - so that
 * even those paths cannot print a key that reached them another way.
 */
export const PARAMETER_REDACTOR: Redactor = {
  scrub(text) {
    return redactCredentialParameters(text);
  },
};

/**
 * A redactor for one source's credential. Holding the secret is what makes rule
 * 1 possible; the object exposes no way to read it back, so passing a redactor
 * around is not passing the credential around.
 */
export function credentialRedactor(secret: string): Redactor {
  const trimmed = secret.trim();
  return {
    scrub(text) {
      const withoutParameters = redactCredentialParameters(text);
      if (trimmed.length === 0) return withoutParameters;
      // `split`/`join` rather than a regular expression: a credential is
      // arbitrary text and may contain regex metacharacters, and an escape
      // helper that got one case wrong would fail open.
      return withoutParameters.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
}

/** Replace the value of every credential-bearing query parameter. */
export function redactCredentialParameters(text: string): string {
  return text.replace(
    CREDENTIAL_PARAMETER_PATTERN,
    (_match, head: string) => `${head}${CREDENTIAL_PLACEHOLDER}`,
  );
}

/**
 * Read a source's credential from the environment, or refuse to run the source.
 *
 * The refusal is the point of the function. An absent key does not produce an
 * unauthenticated request: this vendor answers an invalid key with the same 403
 * it uses for an exceeded call limit, so an unauthenticated attempt spends a
 * real request to learn a fact the environment already knows, and lands the
 * source in a stop it did not earn.
 */
export function readCredential(
  sourceId: string,
  variable: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[variable];
  if (value === undefined || value.trim().length === 0) {
    throw new MissingCredentialError(sourceId, variable);
  }
  return value.trim();
}

/**
 * Whether a credential is present, without reading it. For a caller that wants
 * to report which sources can run before it starts running any of them.
 */
export function credentialPresent(
  variable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[variable];
  return value !== undefined && value.trim().length > 0;
}
