/**
 * Reading a vendor's timestamp into an instant, and the reason that needs the
 * source's own time zone.
 *
 * The sanctioned API publishes `priceUpdateDate` - "Date and time product price
 * was last updated" - and its documentation writes such values WITHOUT a zone
 * or an offset (`itemUpdateDate>2017-02-06T16:00:00`). JavaScript reads a
 * date-time string with no offset as LOCAL time, so `new Date(...)` on one of
 * these answers with whatever zone the container happens to run in: the same
 * vendor string becomes a different instant on a laptop and in a homelab, and
 * the column it lands in is `timestamptz`, which keeps the wrong answer without
 * keeping any evidence that it is wrong.
 *
 * So a zone-less vendor timestamp is read in THE SOURCE'S declared IANA local
 * time zone, which the source registry already requires for a different but
 * related reason (a 90-day low is anchored to the retailer's local day). One
 * declaration, both jobs, and no ambient dependence on the host's zone anywhere
 * in this package.
 *
 * A timestamp that DOES carry an offset is taken at its word: the vendor has
 * answered the question, and the declared zone is not consulted.
 *
 * WHAT THIS DOES NOT SOLVE, stated rather than left to be found: at a
 * daylight-saving transition a zone-less local time is either ambiguous (it
 * happens twice) or nonexistent (it never happens). The two-pass conversion
 * below resolves both to a single instant, deterministically, and can be up to
 * one hour out for the one hour a year in which a vendor's own timestamp is
 * itself ambiguous. Nothing better is available from a string that does not say
 * which side of the transition it is on, and the alternative - refusing the
 * observation - would throw away a good price over a timestamp that is only
 * ever advisory beside the fetch instant.
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The vendor's documented shape, plus the two an ISO-8601 producer might send
 * instead: a space in place of the `T`, and an explicit offset or `Z`.
 * Deliberately strict - a shape this does not recognise is reported as
 * unreadable rather than guessed at.
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Is this a time zone this runtime resolves as an IANA name? */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) return false;
  try {
    formatterFor(timeZone.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a vendor timestamp into an instant, or null when the text is not one.
 *
 * Null is a first-class answer here and is not an error: a source that stops
 * publishing a price-update timestamp, or publishes one in a shape this reader
 * does not know, must not cost the price observation itself. The caller records
 * the observation with the vendor instant ABSENT, which is exactly what it
 * would do had the field not been there at all - and never fills it in from the
 * fetch instant, which would be this system inventing a vendor's claim.
 */
export function readVendorTimestamp(
  text: unknown,
  timeZone: string,
): Date | null {
  if (typeof text !== "string") return null;
  const match = TIMESTAMP_PATTERN.exec(text.trim());
  if (match === null) return null;

  const [, year, month, day, hour, minute, second = "0", fraction = "", offset] =
    match;
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, "0"));

  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: milliseconds,
  };

  if (parts.month < 1 || parts.month > 12) return null;
  if (parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 60) return null;

  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    Math.min(parts.second, 59),
    parts.millisecond,
  );

  // A calendar date that does not exist ("2026-02-30") rolls over in
  // `Date.UTC`, which would silently turn a broken vendor string into a
  // plausible instant. Refuse it instead.
  const rolled = new Date(naive);
  if (
    rolled.getUTCFullYear() !== parts.year ||
    rolled.getUTCMonth() !== parts.month - 1 ||
    rolled.getUTCDate() !== parts.day
  ) {
    return null;
  }

  if (offset !== undefined) {
    if (offset.toUpperCase() === "Z") return new Date(naive);
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const offsetMs =
      sign * (Number(digits.slice(0, 2)) * 3_600_000 + Number(digits.slice(2)) * 60_000);
    return new Date(naive - offsetMs);
  }

  if (!isValidTimeZone(timeZone)) return null;
  return zonedNaiveToInstant(naive, timeZone.trim());
}

/**
 * Turn "this wall-clock reading, in this zone" into an instant.
 *
 * Two passes, and the second one is not optional. The offset of a zone depends
 * on the instant, and the instant is what is being solved for, so the first
 * pass measures the offset at a guess and the second checks that the corrected
 * instant still carries the offset the correction assumed. Where it does not -
 * the guess landed on the far side of a transition - the measured offset is
 * used instead. A third pass cannot change the answer: transitions are at least
 * a day apart in every published zone and the correction moves the guess by at
 * most a day's worth of offset.
 */
export function zonedNaiveToInstant(naiveUtcMs: number, timeZone: string): Date {
  const firstOffset = zoneOffsetAt(naiveUtcMs, timeZone);
  const firstGuess = naiveUtcMs - firstOffset;
  const secondOffset = zoneOffsetAt(firstGuess, timeZone);
  if (secondOffset === firstOffset) return new Date(firstGuess);
  return new Date(naiveUtcMs - secondOffset);
}

/** The zone's offset from UTC, in milliseconds, at one instant. */
export function zoneOffsetAt(instantMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const held = FORMATTERS.get(timeZone);
  if (held !== undefined) return held;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `h23` and not `hour12: false`: the latter has produced "24" for midnight
    // in shipped ICU versions, and a 24 here would be a silent day's error.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}
