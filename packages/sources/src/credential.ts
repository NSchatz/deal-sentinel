/**
 * The vendor credential: where it is read from, and everywhere it is forbidden
 * to appear.
 *
 * The sanctioned API takes its key IN THE QUERY STRING, which makes the
 * credential part of every URL this adapter builds - and a URL is the most
 * copied string in an HTTP client's world: in the request, echoed back by this
 * vendor as `canonicalUrl`, quoted by a transport error, printed by any
 * reasonable log line. So the key is not kept out of logs by remembering not to
 * print it. Every string leaving this package goes through `Redactor.scrub`,
 * which is two rules that back each other up:
 *
 *   1. the SECRET ITSELF, wherever it appears, which catches a value echoed
 *      back inside a response body under a key nobody predicted;
 *   2. the QUERY PARAMETER, whatever its value, which still works when the
 *      credential in hand is not the one that produced the text - a rotated
 *      key, a second key, a fixture recorded against a third.
 *
 * `scrub` is total: any string in, one string out, so no caller can forget a
 * case and no path here formats a URL into a message without it.
 */

import { MissingCredentialError } from "./errors.ts";

/** What replaces a credential. Recognisable on sight, and not a plausible key. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/** Matched case-insensitively: a query string is the vendor's grammar. */
const CREDENTIAL_PARAMETERS = ["apiKey", "api_key", "key", "token", "access_token"];

const CREDENTIAL_PARAMETER_PATTERN = new RegExp(
  `([?&](?:${CREDENTIAL_PARAMETERS.join("|")})=)[^&#\\s]*`,
  "gi",
);

export type Redactor = {
  scrub(text: string): string;
};

/**
 * For the paths where no credential is in hand - a governor refusal, a
 * configuration error - so even those cannot print a key that reached them
 * another way.
 */
export const PARAMETER_REDACTOR: Redactor = {
  scrub(text) {
    return redactCredentialParameters(text);
  },
};

/**
 * Holding the secret is what makes rule 1 possible; nothing here reads it back,
 * so passing a redactor around is not passing the credential around.
 */
export function credentialRedactor(secret: string): Redactor {
  const trimmed = secret.trim();
  return {
    scrub(text) {
      const withoutParameters = redactCredentialParameters(text);
      if (trimmed.length === 0) return withoutParameters;
      // `split`/`join` rather than a regular expression: a credential is
      // arbitrary text, and an escape helper that got one case wrong would fail
      // open.
      return withoutParameters.split(trimmed).join(CREDENTIAL_PLACEHOLDER);
    },
  };
}

export function redactCredentialParameters(text: string): string {
  return text.replace(
    CREDENTIAL_PARAMETER_PATTERN,
    (_match, head: string) => `${head}${CREDENTIAL_PLACEHOLDER}`,
  );
}

/**
 * The refusal is the point. An absent key must not produce an unauthenticated
 * request: this vendor answers an invalid key with the same 403 it uses for an
 * exceeded call limit, so the attempt would spend a real request to learn what
 * the environment already knows, and land the source in a stop it did not earn.
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

/** Present, without reading it: which sources can run before any of them do. */
export function credentialPresent(
  variable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[variable];
  return value !== undefined && value.trim().length > 0;
}
