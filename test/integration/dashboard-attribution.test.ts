/**
 * Acceptance criterion 18 of spec S0042-deal-sentinel-ops-5, GRADED IN A REAL
 * BROWSER ENGINE:
 *
 *   WHEN the rendered page shows any value observed from a source whose
 *   published terms require attribution THE SYSTEM SHALL render that source's
 *   required attribution, naming the party, visibly in the same view; and IF the
 *   attribution for such a value is missing THEN THE SYSTEM SHALL refuse to show
 *   the value rather than show it unattributed.
 *
 * "Visibly in the same view" is the reason this is a browser criterion and not a
 * markup one. A notice present in the HTML, or in a second document, or in a
 * box the cascade collapsed to nothing, discharges nothing: the vendor's terms
 * say "clearly and conspicuously", and only the engine can say whether anything
 * was conspicuous. So the assertions below are that the notice has a painted box
 * ABOVE the prices it attributes, in the same viewport, with the party named in
 * the text a human reads.
 *
 * The second half is the one that makes the first mean anything. The refusal
 * lives in `packages/sources/src/attribution.ts`, which REFUSES an emission that
 * lost its notice rather than composing one - and the dashboard uses that module
 * rather than writing a notice beside it, so a display path that forgot cannot
 * pass by accident.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { Browser, Page } from "playwright";

import { addWatchlistEntry, createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { SOURCE_TERMS } from "@deal-sentinel/sources";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import {
  isShown,
  launchBrowser,
  openPage,
  renderedText,
  seedObservationRows,
  startTestDashboard,
} from "../support/dashboard-harness.ts";
import type { DashboardHarness } from "../support/dashboard-harness.ts";
import {
  SECOND_SOURCE_ID,
  bestBuyGovernorConfig,
  twoSourceRegistry,
} from "../support/source-3-harness.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 86_400_000;

/** The party the sanctioned API's own terms name. Not a string this suite chose. */
const ATTRIBUTE_TO = SOURCE_TERMS["bestbuy-api"].attributeTo;

/** A source with rows in the history that the registry no longer carries. */
const RETIRED_SOURCE = "retired-source";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let dashboard: DashboardHarness;
let browser: Browser;

before(async () => {
  container = await startPostgres("ops-5-attribution");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 attribution suite" });
  database = createDatabase(pool);

  // Attribution REQUIRED by this source's own published terms.
  await addWatchlistEntry(database, { sourceId: "bestbuy-api", listingId: "8880044" });
  // Attribution NOT required: this repository holds no terms for it.
  await addWatchlistEntry(database, {
    sourceId: SECOND_SOURCE_ID,
    listingId: "unattributed-ok",
  });
  // On the watchlist, in the history, and NOT in the registry: this build cannot
  // say what its terms require.
  await addWatchlistEntry(database, {
    sourceId: RETIRED_SOURCE,
    listingId: "retired-listing",
  });

  await seedObservationRows(container.url, [
    {
      sourceId: "bestbuy-api",
      listingId: "8880044",
      amountMinorUnits: 799n,
      currency: "USD",
      observedAt: new Date(NOW.getTime() - DAY),
    },
    {
      sourceId: SECOND_SOURCE_ID,
      listingId: "unattributed-ok",
      amountMinorUnits: 4200n,
      currency: "USD",
      observedAt: new Date(NOW.getTime() - DAY),
    },
    {
      sourceId: RETIRED_SOURCE,
      listingId: "retired-listing",
      amountMinorUnits: 31_337n,
      currency: "USD",
      observedAt: new Date(NOW.getTime() - DAY),
    },
  ]);

  dashboard = await startTestDashboard({
    pool,
    governor: bestBuyGovernorConfig(),
    registry: twoSourceRegistry(),
    now: () => NOW,
  });
  browser = await launchBrowser();
}, { timeout: 300_000 });

after(async () => {
  if (browser) await browser.close();
  if (dashboard) await dashboard.close();
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function open(sourceId: string, listingId: string): Promise<Page> {
  return await openPage(
    browser,
    dashboard.server.origin,
    `/listing?source=${encodeURIComponent(sourceId)}&listing=${encodeURIComponent(listingId)}`,
  );
}

describe("criterion 18: a value from an attributed source is attributed, visibly", () => {
  it("renders the notice, naming the party the terms name", async () => {
    const page = await open("bestbuy-api", "8880044");
    try {
      assert.equal(await isShown(page, "[data-attribution]"), true);
      const notice = (await page.locator("[data-attribution]").innerText()).trim();
      assert.match(
        notice,
        new RegExp(ATTRIBUTE_TO),
        `the notice rendered is ${JSON.stringify(notice)}, which does not name ` +
          `${ATTRIBUTE_TO}. A notice that does not name the party attributes ` +
          "nothing.",
      );
      // And in the text a human actually reads off the page.
      assert.match(await renderedText(page), new RegExp(ATTRIBUTE_TO));
    } finally {
      await page.close();
    }
  });

  it("renders it IN THE SAME VIEW as the value, and above it", async () => {
    // "Clearly and conspicuously" is a claim about a rendered page. A notice in
    // a footnote below a chart, in a second document, or off-screen would pass
    // any assertion made against the markup and none made here.
    const page = await open("bestbuy-api", "8880044");
    try {
      const notice = await page.locator("[data-attribution]").boundingBox();
      const price = await page.locator("[data-price]").first().boundingBox();
      const chart = await page.locator("[data-price-chart]").boundingBox();
      assert.ok(notice !== null && price !== null && chart !== null);

      assert.ok(notice.height > 0 && notice.width > 0, "the notice has no box");
      assert.ok(
        notice.y < chart.y,
        `the notice is at y=${notice.y} and the chart at y=${chart.y}: a reader ` +
          "who stops after the chart has not seen it",
      );
      assert.ok(notice.y < price.y, "the notice is below the price it attributes");

      const viewport = page.viewportSize();
      assert.ok(viewport !== null);
      assert.ok(
        notice.y >= 0 && notice.y < viewport.height,
        "the notice is outside the viewport when the value is inside it",
      );
    } finally {
      await page.close();
    }
  });

  it("does not require one where the source's terms require none", async () => {
    // The other half of "required": a notice on every page whether or not any
    // source asked for one would make the check ceremonial.
    const page = await open(SECOND_SOURCE_ID, "unattributed-ok");
    try {
      assert.equal(await page.locator("[data-attribution]").count(), 0);
      // And the value IS shown, because nothing forbids it.
      assert.match(await renderedText(page), /USD 42\.00/);
    } finally {
      await page.close();
    }
  });
});

describe("criterion 18: a value whose attribution is missing is not shown", () => {
  it("refuses to show the value rather than showing it unattributed", async () => {
    const page = await open(RETIRED_SOURCE, "retired-listing");
    try {
      assert.equal(await isShown(page, "[data-unattributed]"), true);
      assert.match(await renderedText(page), /Refusing to show any observed value/);
    } finally {
      await page.close();
    }
  });

  it("renders no price, no chart and no point for it", async () => {
    const page = await open(RETIRED_SOURCE, "retired-listing");
    try {
      assert.equal(await page.locator("[data-price]").count(), 0);
      assert.equal(await page.locator("[data-price-chart]").count(), 0);
      assert.equal(await page.locator("[data-datum]").count(), 0);
      // The stored amount is 31337 minor units. Neither the integer nor any
      // scaling of it appears anywhere a reader can see.
      const text = await renderedText(page);
      assert.doesNotMatch(text, /313\.37/);
      assert.doesNotMatch(text, /31337/);
    } finally {
      await page.close();
    }
  });

  it("the row IS there, which is what makes the refusal a refusal", async () => {
    // Without this, "no price rendered" would be satisfied by an empty table.
    const client = new pg.Client({ connectionString: container.url });
    await client.connect();
    try {
      const result = await client.query(
        "select amount_minor_units::text as amount from price_observations " +
          "where source_id = $1",
        [RETIRED_SOURCE],
      );
      assert.equal(result.rows.length, 1);
      assert.equal((result.rows[0] as { amount: string }).amount, "31337");
    } finally {
      await client.end();
    }
  });

  it("says WHY, so the operator can put the source back in the configuration", async () => {
    const page = await open(RETIRED_SOURCE, "retired-listing");
    try {
      const reason = (await page.locator("[data-unattributed-reason]").innerText()).trim();
      assert.match(reason, new RegExp(RETIRED_SOURCE));
      assert.match(reason, /cannot establish/);
    } finally {
      await page.close();
    }
  });
});
