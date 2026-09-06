/**
 * Acceptance criteria 16, 17, 19, 20 and 21 of spec S0042-deal-sentinel-ops-5,
 * GRADED IN A REAL BROWSER ENGINE:
 *
 *   16. WHEN the owner opens the dashboard and selects a tracked listing THE
 *       SYSTEM SHALL render that listing's stored observations as a time series
 *       ordered by observation instant, with one plotted datum per stored
 *       observation in the selected range and no datum that is not a stored
 *       observation.
 *   17. WHEN a price is shown anywhere on the rendered page THE SYSTEM SHALL
 *       show it as the stored integer minor units scaled by that currency's own
 *       ISO 4217 exponent, with its currency, and SHALL NOT round, re-scale by a
 *       fixed 100, or pass the amount through a floating-point value on the way
 *       to the screen.
 *   19. IF a tracked listing has no stored observation THEN THE SYSTEM SHALL
 *       render an explicit empty state naming the listing, and SHALL NOT render
 *       an axis, a line or a point that reads as a price.
 *   20. IF a listing's observations in the selected range carry more than one
 *       currency THEN THE SYSTEM SHALL NOT plot them as one comparable series,
 *       and SHALL say on the page which currencies were found.
 *   21. IF a request names a listing that is on no watchlist entry THEN THE
 *       SYSTEM SHALL answer that it is not tracked and SHALL render no chart, no
 *       axis and no price for it.
 *
 * EVERY ASSERTION BELOW IS AGAINST THE RENDERED DOM, THE COMPUTED STYLE OR A
 * PAINTED BOX. None of these is decidable from served text: "no axis" is a claim
 * about what the engine drew, "shown" is a claim about the cascade, and a price
 * string that is present in the markup but collapsed to a zero-height box is not
 * a price anybody was shown. The engine is the Chromium already in this
 * container; Playwright drives it and downloads nothing.
 *
 * Nothing here reaches a third party: the browser is pointed at a loopback
 * dashboard that holds no governor, no adapter and no transport.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { Browser, Page } from "playwright";

import { addWatchlistEntry, createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import {
  computedStyle,
  isShown,
  launchBrowser,
  openPage,
  renderedText,
  seedObservationRows,
  startTestDashboard,
  testDashboardConfig,
} from "../support/dashboard-harness.ts";
import type { DashboardHarness } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 86_400_000;
const SOURCE = "bestbuy-api";

/** The five stored observations for the USD listing, oldest first. */
const USD_SERIES: [number, bigint][] = [
  [-40 * DAY, 1299n],
  [-30 * DAY, 1199n],
  [-20 * DAY, 999n],
  [-10 * DAY, 1099n],
  [-1 * DAY, 799n],
];

/** Two more, OUTSIDE the ninety-day range, which must not be plotted. */
const USD_OUTSIDE: [number, bigint][] = [
  [-200 * DAY, 5555n],
  [-120 * DAY, 4444n],
];

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let dashboard: DashboardHarness;
let browser: Browser;

before(async () => {
  container = await startPostgres("ops-5-price-history");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 price history suite" });
  database = createDatabase(pool);

  for (const listingId of [
    "8880044", // the USD series
    "6428337", // tracked, never observed
    "5901234", // two currencies in range
    "7000001", // a JPY series: exponent 0
    "7000002", // a KWD series: exponent 3
  ]) {
    await addWatchlistEntry(database, { sourceId: SOURCE, listingId });
  }

  await seedObservationRows(container.url, [
    ...[...USD_SERIES, ...USD_OUTSIDE].map(([offset, amount]) => ({
      sourceId: SOURCE,
      listingId: "8880044",
      amountMinorUnits: amount,
      currency: "USD",
      observedAt: new Date(NOW.getTime() + offset),
    })),
    {
      sourceId: SOURCE,
      listingId: "5901234",
      amountMinorUnits: 1299n,
      currency: "USD",
      observedAt: new Date(NOW.getTime() - 5 * DAY),
    },
    {
      sourceId: SOURCE,
      listingId: "5901234",
      amountMinorUnits: 129_900n,
      currency: "JPY",
      observedAt: new Date(NOW.getTime() - 4 * DAY),
    },
    {
      sourceId: SOURCE,
      listingId: "7000001",
      amountMinorUnits: 129_900n,
      currency: "JPY",
      observedAt: new Date(NOW.getTime() - 3 * DAY),
    },
    {
      sourceId: SOURCE,
      listingId: "7000002",
      amountMinorUnits: 12_995n,
      currency: "KWD",
      observedAt: new Date(NOW.getTime() - 3 * DAY),
    },
  ]);

  dashboard = await startTestDashboard({
    pool,
    governor: bestBuyGovernorConfig(),
    registry: testRegistry(),
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

async function open(listingId: string, sourceId = SOURCE): Promise<Page> {
  return await openPage(
    browser,
    dashboard.server.origin,
    `/listing?source=${encodeURIComponent(sourceId)}&listing=${encodeURIComponent(listingId)}`,
  );
}

describe("criterion 16: one plotted datum per stored observation, in order", () => {
  it("plots exactly as many points as there are stored observations in range", async () => {
    const page = await open("8880044");
    try {
      assert.equal(await page.locator("[data-datum]").count(), USD_SERIES.length);
      // And the seven rows really are in the table, so "five" is a filter and
      // not an empty database.
      const stored = await query7(container.url, "8880044");
      assert.equal(stored, USD_SERIES.length + USD_OUTSIDE.length);
    } finally {
      await page.close();
    }
  });

  it("plots them in observation order, and each is a stored observation", async () => {
    const page = await open("8880044");
    try {
      const datums = page.locator("[data-datum]");
      const rendered: [string, string][] = [];
      for (let index = 0; index < (await datums.count()); index += 1) {
        rendered.push([
          (await datums.nth(index).getAttribute("data-observed-at")) ?? "",
          (await datums.nth(index).getAttribute("data-amount-minor-units")) ?? "",
        ]);
      }
      assert.deepEqual(
        rendered,
        USD_SERIES.map(([offset, amount]) => [
          new Date(NOW.getTime() + offset).toISOString(),
          amount.toString(),
        ]),
      );
    } finally {
      await page.close();
    }
  });

  it("plots NO datum that is not a stored observation", async () => {
    const page = await open("8880044");
    try {
      const datums = page.locator("[data-datum]");
      const amounts = new Set<string>();
      for (let index = 0; index < (await datums.count()); index += 1) {
        amounts.add(
          (await datums.nth(index).getAttribute("data-amount-minor-units")) ?? "",
        );
      }
      // The two out-of-range rows are in the database and must not be on the
      // chart: a chart that quietly widened its own range would be a chart of a
      // different question than the one asked.
      for (const [, amount] of USD_OUTSIDE) {
        assert.equal(
          amounts.has(amount.toString()),
          false,
          `${amount} is outside the range and was plotted anyway`,
        );
      }
      assert.equal(amounts.size, USD_SERIES.length);
    } finally {
      await page.close();
    }
  });

  it("actually PAINTS them: each datum has a box on the screen", async () => {
    // The half no text grader can reach. Five elements in the markup that the
    // engine collapsed to nothing are five points nobody was shown.
    const page = await open("8880044");
    try {
      assert.equal(await isShown(page, "[data-price-chart]"), true);
      const datums = page.locator("[data-datum]");
      for (let index = 0; index < (await datums.count()); index += 1) {
        const box = await datums.nth(index).boundingBox();
        assert.ok(box !== null, `datum ${index} has no box`);
        assert.ok(box.width > 0 && box.height > 0, `datum ${index} is ${box.width}x${box.height}`);
      }
    } finally {
      await page.close();
    }
  });

  it("draws the points at DIFFERENT heights, so the series is a series", async () => {
    // Five points at one height is not a time series of five prices, and it is
    // exactly what an amount that never reached the geometry would look like.
    const page = await open("8880044");
    try {
      const datums = page.locator("[data-datum]");
      const heights = new Set<number>();
      for (let index = 0; index < (await datums.count()); index += 1) {
        const box = await datums.nth(index).boundingBox();
        assert.ok(box !== null);
        heights.add(Math.round(box.y));
      }
      assert.ok(heights.size >= 4, `the five points sat at ${heights.size} heights`);
    } finally {
      await page.close();
    }
  });
});

describe("criterion 17: money is minor units, scaled by its own exponent", () => {
  it("shows USD as two decimal places from the stored integer", async () => {
    const page = await open("8880044");
    try {
      const text = await renderedText(page);
      assert.match(text, /USD 7\.99/);
      assert.match(text, /USD 12\.99/);
      // The three mistakes, each of which produces a number a human would read
      // as a price: the raw minor units, a fixed divide by 100 that ignores the
      // exponent, and a rounded value.
      assert.doesNotMatch(text, /USD 799\b/);
      assert.doesNotMatch(text, /USD 8\.00/);
      assert.doesNotMatch(text, /USD 7\.9899/);
    } finally {
      await page.close();
    }
  });

  it("shows JPY with NO decimal places, because the yen has no subdivision", async () => {
    // The mutation a fixed multiply-by-100 cannot survive: 129900 JPY is
    // 129,900 yen and not 1,299.00 of anything.
    const page = await open("7000001");
    try {
      const text = await renderedText(page);
      assert.match(text, /JPY 129900/);
      assert.doesNotMatch(text, /JPY 1299\.00/);
      assert.doesNotMatch(text, /JPY 129900\.00/);
    } finally {
      await page.close();
    }
  });

  it("shows KWD with THREE decimal places", async () => {
    const page = await open("7000002");
    try {
      const text = await renderedText(page);
      assert.match(text, /KWD 12\.995/);
      assert.doesNotMatch(text, /KWD 129\.95/);
      assert.doesNotMatch(text, /KWD 13\.00/);
    } finally {
      await page.close();
    }
  });

  it("carries the exact stored integer beside the price it rendered", async () => {
    // The two are asserted together on purpose: a rendered "USD 7.99" that came
    // from anywhere other than the integer 799 is a coincidence, and this is
    // what makes it not one.
    const page = await open("8880044");
    try {
      const cell = page.locator("[data-price]").last();
      assert.equal(await cell.getAttribute("data-amount-minor-units"), "799");
      assert.equal(await cell.getAttribute("data-currency"), "USD");
      assert.equal((await cell.innerText()).trim(), "USD 7.99");
    } finally {
      await page.close();
    }
  });

  it("shows the price where a reader can see it, not merely in the markup", async () => {
    const page = await open("8880044");
    try {
      assert.equal(await isShown(page, "[data-price]"), true);
      // And the font is the tabular one the stylesheet asks for, which is a
      // claim about the cascade rather than about the HTML.
      assert.equal(
        await computedStyle(page, "[data-price]", "fontVariantNumeric"),
        "tabular-nums",
      );
    } finally {
      await page.close();
    }
  });
});

describe("criterion 19: a tracked listing with no observation draws nothing", () => {
  it("renders an explicit empty state that NAMES the listing", async () => {
    const page = await open("6428337");
    try {
      assert.equal(await isShown(page, "[data-empty-state]"), true);
      assert.equal(
        await page.locator("[data-empty-state]").getAttribute("data-listing-id"),
        "6428337",
      );
      assert.match(await renderedText(page), /6428337/);
    } finally {
      await page.close();
    }
  });

  it("renders NO axis, NO line and NO point", async () => {
    // The failure this criterion exists for: an "empty chart" whose axes are
    // still drawn reads as a price of zero to anybody glancing at it.
    const page = await open("6428337");
    try {
      assert.equal(await page.locator("[data-price-chart]").count(), 0);
      assert.equal(await page.locator("[data-axis]").count(), 0);
      assert.equal(await page.locator("[data-series-line]").count(), 0);
      assert.equal(await page.locator("[data-datum]").count(), 0);
      assert.equal(await page.locator("[data-price]").count(), 0);
    } finally {
      await page.close();
    }
  });

  it("renders nothing that reads as a price", async () => {
    const page = await open("6428337");
    try {
      const text = await renderedText(page);
      assert.doesNotMatch(text, /\b(?:USD|JPY|KWD|EUR|GBP)\s+[\d.,]+/);
    } finally {
      await page.close();
    }
  });

  it("and the SAME page shape does draw all four for a listing that has data", async () => {
    // The mutation: if the selectors above matched nothing anywhere, the four
    // zeros would be four zeros about a page that cannot draw a chart at all.
    const page = await open("8880044");
    try {
      assert.equal(await page.locator("[data-price-chart]").count(), 1);
      assert.equal(await page.locator("[data-axis]").count(), 2);
      assert.equal(await page.locator("[data-series-line]").count(), 1);
      assert.ok((await page.locator("[data-price]").count()) > 0);
    } finally {
      await page.close();
    }
  });
});

describe("criterion 20: two currencies are not one series", () => {
  it("plots no series at all", async () => {
    const page = await open("5901234");
    try {
      assert.equal(await page.locator("[data-price-chart]").count(), 0);
      assert.equal(await page.locator("[data-series-line]").count(), 0);
      assert.equal(await page.locator("[data-datum]").count(), 0);
    } finally {
      await page.close();
    }
  });

  it("says on the page which currencies were found", async () => {
    const page = await open("5901234");
    try {
      assert.equal(await isShown(page, "[data-mixed-currency]"), true);
      const found = page.locator("[data-currency-found]");
      const codes: string[] = [];
      for (let index = 0; index < (await found.count()); index += 1) {
        codes.push((await found.nth(index).innerText()).trim());
      }
      assert.deepEqual(codes.sort(), ["JPY", "USD"]);
      const text = await renderedText(page);
      assert.match(text, /more than one currency/);
    } finally {
      await page.close();
    }
  });
});

describe("criterion 21: a listing on no watchlist entry gets nothing", () => {
  it("answers that it is not tracked", async () => {
    const page = await open("0000000");
    try {
      assert.equal(await isShown(page, "[data-not-tracked]"), true);
      assert.match(await renderedText(page), /is not tracked/);
    } finally {
      await page.close();
    }
  });

  it("renders no chart, no axis and no price for it", async () => {
    const page = await open("0000000");
    try {
      assert.equal(await page.locator("[data-price-chart]").count(), 0);
      assert.equal(await page.locator("[data-axis]").count(), 0);
      assert.equal(await page.locator("[data-datum]").count(), 0);
      assert.equal(await page.locator("[data-price]").count(), 0);
      assert.doesNotMatch(await renderedText(page), /\bUSD\s+[\d.,]+/);
    } finally {
      await page.close();
    }
  });

  it("is decided by the WATCHLIST and not by whether rows exist", async () => {
    // A listing with observations but no watchlist entry is still not tracked:
    // showing its history would be showing a chart for something this system is
    // not watching.
    await seedObservationRows(container.url, [
      {
        sourceId: SOURCE,
        listingId: "9999999",
        amountMinorUnits: 4242n,
        currency: "USD",
        observedAt: new Date(NOW.getTime() - DAY),
      },
    ]);
    const page = await open("9999999");
    try {
      assert.equal(await isShown(page, "[data-not-tracked]"), true);
      assert.equal(await page.locator("[data-datum]").count(), 0);
      assert.doesNotMatch(await renderedText(page), /42\.42/);
    } finally {
      await page.close();
    }
  });
});

describe("the picker links to every tracked listing", () => {
  it("lists them on the overview and reaches one by following the link", async () => {
    const page = await openPage(browser, dashboard.server.origin, "/");
    try {
      assert.equal(await isShown(page, "[data-listing-picker]"), true);
      const options = page.locator("[data-listing-option]");
      assert.ok((await options.count()) >= 5);
      await page.locator('[data-listing-option] a[href*="8880044"]').first().click();
      await page.waitForLoadState("domcontentloaded");
      assert.equal(await page.locator("[data-datum]").count(), USD_SERIES.length);
    } finally {
      await page.close();
    }
  });
});

/** How many observation rows this listing actually has, for the filter proof. */
async function query7(url: string, listingId: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      "select count(*)::int as n from price_observations where listing_id = $1",
      [listingId],
    );
    return Number((result.rows[0] as { n: number }).n);
  } finally {
    await client.end();
  }
}
