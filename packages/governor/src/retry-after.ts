/**
 * `Retry-After`, in BOTH legal forms.
 *
 * RFC 9110 section 10.2.3: `Retry-After = HTTP-date / delay-seconds`, where
 * `delay-seconds = 1*DIGIT` is "a non-negative decimal integer, representing
 * time in seconds". Both examples the section gives are real:
 *
 *     Retry-After: Fri, 31 Dec 1999 23:59:59 GMT
 *     Retry-After: 120
 *
 * A parser that reads only integers silently ignores half of them and retries
 * immediately, which is exactly how a throttle becomes a block. That is why the
 * date form is graded in its own case.
 *
 * Ruling R4 of spec S0023-deal-sentinel-governor-2: a value that parses as
 * neither form, or names an instant already past, falls back to the configured
 * back-off rather than being retried at once. RFC 9110 would permit retrying
 * immediately on a past date; that reading is refused here, because the host
 * that sent the header is the host asking for less traffic and this repository
 * never gives a confident wrong answer in the direction of more requests.
 */

export type RetryAfterReading =
  | { form: "delay-seconds"; holdMs: number }
  | { form: "http-date"; holdMs: number }
  | { form: "past-date"; holdMs: null }
  | { form: "unparseable"; holdMs: null };

/**
 * Read a `Retry-After` value against the instant the response arrived.
 *
 * `holdMs` is null where the caller must fall back to its configured back-off:
 * the value did not parse, or it named an instant that has already gone by.
 */
export function readRetryAfter(value: string, receivedAtMs: number): RetryAfterReading {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { form: "unparseable", holdMs: null };

  // delay-seconds = 1*DIGIT. Nothing else: "120s", "+120" and "1.5" are not
  // this form, and reading them as one would invent a number the server never
  // sent.
  if (/^\d+$/.test(trimmed)) {
    return { form: "delay-seconds", holdMs: Number(trimmed) * 1000 };
  }

  // HTTP-date = IMF-fixdate / obs-date. `Date.parse` accepts IMF-fixdate and
  // the asctime form; a value it cannot read is treated as unparseable and
  // takes the configured back-off, never zero.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return { form: "unparseable", holdMs: null };

  const holdMs = parsed - receivedAtMs;
  if (holdMs <= 0) return { form: "past-date", holdMs: null };
  return { form: "http-date", holdMs };
}

/**
 * The hold a response earns: the header where it is readable, in the future and
 * not zero, and the configured back-off in every other case the caller asks
 * about.
 *
 * `readRetryAfter` above stays faithful to RFC 9110, which makes
 * `Retry-After: 0` a legal `delay-seconds` value meaning "now". THIS function
 * is the policy layer, and it refuses that reading for the same reason ruling
 * R4 refuses an already-past date: the host that sent the header is the host
 * asking for less traffic, and a hold of zero would make a 429 that names a
 * value STRICTLY more aggressive than the same 429 with no header at all, which
 * cannot be what either the standard or this repository means. A confident
 * wrong answer in the direction of more requests is the one this package is not
 * allowed to give.
 */
export function holdForResponse(
  status: number,
  retryAfterHeader: string | undefined,
  receivedAtMs: number,
  defaultBackoffMs: number,
): { holdMs: number; reason: string } | null {
  if (retryAfterHeader !== undefined) {
    const reading = readRetryAfter(retryAfterHeader, receivedAtMs);
    if (reading.holdMs !== null && reading.holdMs > 0) {
      return {
        holdMs: reading.holdMs,
        reason: `Retry-After (${reading.form}) asked for ${reading.holdMs}ms`,
      };
    }
    if (reading.holdMs !== null) {
      return {
        holdMs: defaultBackoffMs,
        reason:
          `Retry-After (${reading.form}) asked for ${reading.holdMs}ms, which ` +
          "is no wait at all, so the configured back-off of " +
          `${defaultBackoffMs}ms applies instead`,
      };
    }
    return {
      holdMs: defaultBackoffMs,
      reason:
        `Retry-After was ${reading.form} (${JSON.stringify(retryAfterHeader)}), ` +
        `so the configured back-off of ${defaultBackoffMs}ms applies instead`,
    };
  }

  if (status === 429) {
    return {
      holdMs: defaultBackoffMs,
      reason: `429 with no Retry-After: the configured back-off of ${defaultBackoffMs}ms applies`,
    };
  }

  return null;
}
