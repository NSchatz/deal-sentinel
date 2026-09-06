/**
 * Attribution, and the refusal that makes it mean something.
 *
 * The sanctioned API's terms: "You must clearly and conspicuously attribute the
 * source of all Content as received from Best Buy." That is an obligation on
 * DISPLAY and EXPORT, not on storage, so it lives here - beside the only two
 * paths this phase creates that put content in front of anybody - rather than
 * on the write path.
 *
 * The design decision worth stating: an emission that has lost its attribution
 * is REFUSED and not repaired. Filling the notice in here would be the
 * comfortable choice and would make the check ceremonial, because every path
 * would pass whether or not it had thought about attribution. A path that
 * forgot must not emit, and it must say so loudly enough that somebody fixes
 * the path. `UnattributedEmissionError` names the source and the party.
 *
 * The notice is checked for NAMING the party rather than for equalling a
 * string. A caller carrying "provided by a retailer" has attributed nothing,
 * and a caller carrying the registry's own notice inside a longer sentence has
 * attributed correctly; only one of those two rules is about the obligation.
 *
 * Money is formatted from the integer minor units by the currency's own ISO
 * 4217 exponent, digit by digit. No float ever appears on a display path here:
 * a number that is exact in the database and rounded on the screen is a lie
 * told by the last line of the system, and it is the line people read.
 */

import { formatMinorUnits } from "@deal-sentinel/extractor";

// Re-exported so this package's public surface is unchanged. The function
// itself lives beside `toMinorUnits`, whose inverse it is: both readings of a
// price are then decided by one exponent table, and a second caller that prints
// money (the alert channel) cannot pick up a different idea of a minor unit.
export { formatMinorUnits };

import { UnattributedEmissionError } from "./errors.ts";
import type { SourceRegistry } from "./registry.ts";

/** One observation, on its way to a screen or a file. */
export type ExportItem = {
  sourceId: string;
  listingId: string;
  amountMinorUnits: bigint;
  currency: string;
  observedAt: Date;
  vendorPriceUpdatedAt: Date | null;
  /**
   * The attribution this item carries. NULL is a legal value of this type on
   * purpose: it is what a path that forgot looks like, and a type that could
   * not express it would move the failure to run time somewhere else.
   */
  attribution: string | null;
};

/**
 * Build an item that carries the attribution its source requires.
 *
 * The supported way to make one. A caller that goes around it can still build
 * the object by hand, which is exactly why the guard below exists.
 */
export function attributedItem(
  registry: SourceRegistry,
  item: Omit<ExportItem, "attribution">,
): ExportItem {
  const entry = registry.require(item.sourceId);
  return {
    ...item,
    attribution: entry.attribution.required ? entry.attribution.notice : null,
  };
}

/**
 * Refuse an emission that would carry a source's content without that source's
 * attribution. Returns the notice to render where one is required.
 */
export function assertAttributed(
  registry: SourceRegistry,
  item: ExportItem,
): string | null {
  const entry = registry.require(item.sourceId);
  const requirement = entry.attribution;
  if (!requirement.required) return null;

  const carried = item.attribution;
  if (carried === null || carried.trim().length === 0) {
    throw new UnattributedEmissionError(
      item.sourceId,
      requirement.attributeTo,
      `refusing to emit content for ${item.listingId} from ${item.sourceId}: ` +
        `that source's terms require its content to be clearly and ` +
        `conspicuously attributed to ${requirement.attributeTo}, and this ` +
        "emission carries no attribution at all. The emission is refused " +
        "rather than sent unattributed.",
    );
  }

  if (!carried.includes(requirement.attributeTo)) {
    throw new UnattributedEmissionError(
      item.sourceId,
      requirement.attributeTo,
      `refusing to emit content for ${item.listingId} from ${item.sourceId}: ` +
        `the attribution carried is ${JSON.stringify(carried)}, which does ` +
        `not name ${JSON.stringify(requirement.attributeTo)}. A notice that ` +
        "does not name the party attributes nothing.",
    );
  }

  return carried;
}

/**
 * The export path: every item, grouped by source, each group headed by that
 * source's attribution.
 *
 * The notice is at the head of the group and not in a footnote, because the
 * obligation says "clearly and conspicuously" and a reader who stops after the
 * first line has still seen it.
 */
export function renderObservationExport(
  registry: SourceRegistry,
  items: readonly ExportItem[],
): string {
  const bySource = new Map<string, ExportItem[]>();
  for (const item of items) {
    // Checked BEFORE anything is rendered, so a single unattributed item means
    // nothing is emitted rather than most of it.
    assertAttributed(registry, item);
    const held = bySource.get(item.sourceId);
    if (held === undefined) bySource.set(item.sourceId, [item]);
    else held.push(item);
  }

  const blocks: string[] = [];
  for (const [sourceId, group] of bySource) {
    const notice = group[0].attribution;
    blocks.push(
      [
        `## ${sourceId}`,
        ...(notice === null ? [] : [notice]),
        "",
        ...group.map((item) => renderListingLine(item)),
      ].join("\n"),
    );
  }

  return `# deal-sentinel observations\n\n${blocks.join("\n\n")}\n`;
}

/**
 * The display path: one observation, on one line, attributed.
 *
 * Separate from the export above and not a special case of it, because the two
 * obligations are the same but the shapes are not - and both have to pass the
 * same guard for the guard to be worth anything.
 */
export function renderListingSummary(
  registry: SourceRegistry,
  item: ExportItem,
): string {
  const notice = assertAttributed(registry, item);
  const line = renderListingLine(item);
  return notice === null ? line : `${line} - ${notice}`;
}

function renderListingLine(item: ExportItem): string {
  const updated =
    item.vendorPriceUpdatedAt === null
      ? "vendor price-update instant not published"
      : `vendor price updated ${item.vendorPriceUpdatedAt.toISOString()}`;
  return (
    `${item.observedAt.toISOString()}  ${item.listingId}  ` +
    `${formatMinorUnits(item.amountMinorUnits, item.currency)}  (${updated})`
  );
}

