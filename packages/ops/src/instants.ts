/**
 * Showing an instant, and showing how long ago it was.
 *
 * EVERY INSTANT ON THIS PAGE NAMES ITS ZONE. A bare local time is read
 * differently by the same person in two seasons and by two people in one house
 * if one of them is travelling, and a price history is a series of instants
 * whose ORDER is the whole point. The zone is the one configured for the
 * dashboard, and it is written beside the value rather than assumed.
 *
 * The shape is fixed here rather than left to a locale: `2026-09-01 08:00:00
 * EDT` sorts as text in the same order it sorts in time, which is what makes a
 * column of them readable as a series.
 */

const PARTS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
} as const;

/** One instant, in the configured zone, with that zone named beside it. */
export function showInstant(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { ...PARTS, timeZone }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return (
    `${value("year")}-${value("month")}-${value("day")} ` +
    `${value("hour")}:${value("minute")}:${value("second")} ${value("timeZoneName")}`
  );
}

const UNITS: readonly [string, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/**
 * How long something is, in the two largest units that say anything. Whole
 * numbers only: "2 days 3 hours" and never "2.13 days", because the point of
 * the figure is how alarming it is rather than how precise.
 */
export function showDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  const said: string[] = [];
  let left = Math.floor(milliseconds);
  for (const [unit, size] of UNITS) {
    if (said.length === 2) break;
    const count = Math.floor(left / size);
    if (count === 0 && said.length === 0) continue;
    if (count === 0) continue;
    said.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    left -= count * size;
  }
  return said.length === 0 ? "0 seconds" : said.join(" ");
}
