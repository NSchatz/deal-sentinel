/**
 * The price-ending clearance tag: borrowed lore, demoted to corroboration.
 *
 * BRIEF.md section 4 states the fact this module is built around: a retailer's
 * clearance price-ending ladder "is community lore that is widely reported
 * unreliable in 2026, so endings should only ever be a weak corroborating tag,
 * never a trigger on their own".
 *
 * So this module CANNOT trigger anything, and that is a property of its shape
 * rather than of care at the call site: it returns a tag or null, it takes no
 * rule and produces no verdict, and the only caller is the composition step,
 * which runs after some rule has already fired. There is no function here that
 * a notification could be built from.
 *
 * THE PATTERNS ARE THE OPERATOR'S, AND THIS SYSTEM ASSERTS NONE. The committed
 * configuration ships an empty list for every source. Writing a named
 * retailer's ladder into this tree would be stating a fact the brief does not
 * have, on the strength of community lore the brief itself calls unreliable -
 * CLAUDE.md rule 8, in the one place where being wrong looks like being right.
 * An owner who trusts a particular ending puts it in their own configuration.
 */

/** A matched ending, in the form the notification carries it. */
export type ClearanceTag = {
  /** The configured ending that matched, e.g. "97". */
  ending: string;
  /** The whole amount it matched, in minor units, for the message. */
  amountMinorUnits: bigint;
};

/**
 * Does this amount end in one of the operator's configured endings?
 *
 * Matched against the DECIMAL DIGITS OF THE MINOR-UNIT INTEGER, which is the
 * only reading that needs no float: a USD price of 12.97 is 1297 minor units
 * and ends in "97". A currency with no subdivision has no cents to end in, and
 * the same rule still applies to its own digits, which is the honest thing to
 * do with a pattern whose whole basis is a retailer's habit rather than a
 * standard.
 *
 * An empty list - what this repository ships - matches nothing at all.
 */
export function clearanceTagFor(
  amountMinorUnits: bigint,
  endings: readonly string[],
): ClearanceTag | null {
  if (endings.length === 0) return null;
  const digits = (amountMinorUnits < 0n ? -amountMinorUnits : amountMinorUnits).toString();
  for (const ending of endings) {
    if (ending.length === 0) continue;
    if (digits.length >= ending.length && digits.endsWith(ending)) {
      return { ending, amountMinorUnits };
    }
  }
  return null;
}
