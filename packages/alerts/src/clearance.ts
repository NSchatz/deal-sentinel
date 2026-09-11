/**
 * The price-ending clearance tag: borrowed lore, demoted to corroboration.
 *
 * BRIEF.md section 4 calls a retailer's clearance ending ladder "community
 * lore that is widely reported unreliable", to be "a weak corroborating tag,
 * never a trigger on their own". This module therefore cannot trigger anything
 * by its SHAPE rather than by care at the call site: it returns a tag or null,
 * takes no rule and produces no verdict. The patterns are the operator's and
 * this system asserts none, so the committed configuration ships an empty list.
 */

export type ClearanceTag = {
  ending: string;
  amountMinorUnits: bigint;
};

/**
 * Matched against the DECIMAL DIGITS OF THE MINOR-UNIT INTEGER, the only
 * reading that needs no float: 12.97 USD is 1297 minor units and ends in "97".
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
