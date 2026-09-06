/**
 * Acceptance criteria 11, 23, 24 and 27 of spec S0042-deal-sentinel-ops-5,
 * against real PostgreSQL and a real socket:
 *
 *   11. WHEN any read path in this spec runs against the history database THE
 *       SYSTEM SHALL leave `governor_allowance_usage`, `price_observations`,
 *       `source_period_stops`, `watchlist_entries` and `alert_cooldowns`
 *       unchanged row for row and column for column: reading the allowance never
 *       spends, resets, warns on or notifies against it.
 *   23. WHEN the dashboard receives a request whose method is anything other
 *       than a read (`GET` or `HEAD`) THE SYSTEM SHALL refuse it with a
 *       method-not-allowed status and SHALL write nothing to the history
 *       database.
 *   24. WHEN the dashboard process starts THE SYSTEM SHALL bind only the address
 *       and port its configuration names, and the configuration committed to
 *       this repository SHALL name a loopback address.
 *   27. IF the history database is unreachable while the dashboard is serving
 *       THEN THE SYSTEM SHALL render a page saying so and SHALL NOT render a
 *       chart, a rate or an allowance figure.
 *
 * CRITERION 11 IS THE ONE WITH TEETH. The allowance counter carries once-only
 * marks - `warned_at`, `stopped_at` - whose entire purpose is that a second
 * notification is never sent, and `AllowanceLedger.check` CLAIMS `stopped_at`
 * when it finds the counter at its limit. A display path that read the allowance
 * through the ledger would spend the mark it was reading and notify the owner
 * every time they opened the page. So the counter is seeded AT ITS LIMIT here,
 * which is exactly the state where a careless read does damage, and every row of
 * all five tables is compared before and after.
 *
 * CRITERION 27 IS GRADED BY STOPPING THE DATABASE. Not by pointing a second
 * dashboard at a closed port: "while the dashboard is serving" means the same
 * process, still up, that has already answered.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { APIRequestContext, Browser } from "playwright";

import { addWatchlistEntry, createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { READ_METHODS, isLoopbackAddress } from "@deal-sentinel/dashboard";
import { periodStartFor } from "@deal-sentinel/governor";

import {
  destroyPostgres,
  docker,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import {
  freeLoopbackPort,
  isShown,
  launchBrowser,
  openPage,
  renderedText,
  seedObservationRows,
  seedOutcomes,
  startTestDashboard,
  testDashboardConfig,
} from "../support/dashboard-harness.ts";
import type { DashboardHarness } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 86_400_000;
const SOURCE = "bestbuy-api";
const LIMIT = 2000;

const GOVERNOR = bestBuyGovernorConfig({
  sources: {
    [SOURCE]: { allowance: { limit: LIMIT, periodMs: DAY, warnFraction: 0.8 } },
  },
});

/** Every table criterion 11 names. */
const GUARDED_TABLES = [
  "governor_allowance_usage",
  "price_observations",
  "source_period_stops",
  "watchlist_entries",
  "alert_cooldowns",
];

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let dashboard: DashboardHarness;
let browser: Browser;
let api: APIRequestContext;

before(async () => {
  container = await startPostgres("ops-5-read-only");
  pool = new pg.Pool({
    connectionString: container.url,
    // So the unreachable-database case answers rather than hanging.
    connectionTimeoutMillis: 5_000,
  });
  // A pool with no error listener destroys the PROCESS when an idle client's
  // connection dies, and criterion 27 kills the database on purpose. The
  // dashboard's own entry point installs the same handler for the same reason:
  // a view that says "the database is unreachable" cannot say it from a process
  // that has already exited.
  pool.on("error", () => undefined);
  await initializeHistory(pool, { note: "ops-5 read-only suite" });
  database = createDatabase(pool);

  const periodStart = periodStartFor(NOW.getTime(), DAY);

  await addWatchlistEntry(database, { sourceId: SOURCE, listingId: "8880044" });
  await seedObservationRows(container.url, [
    {
      sourceId: SOURCE,
      listingId: "8880044",
      amountMinorUnits: 799n,
      currency: "USD",
      observedAt: new Date(NOW.getTime() - DAY),
    },
  ]);
  await seedOutcomes(container.url, [
    {
      sourceId: SOURCE,
      outcomeClass: "success",
      latencyMs: 100,
      occurredAt: new Date(NOW.getTime() - 3_600_000),
    },
  ]);

  // AT ITS LIMIT, with neither mark claimed. This is the state where reading
  // the allowance through the ledger would set `stopped_at` and emit the
  // period's one notification, and it is the state a display path is most
  // likely to be opened in.
  await query(
    container.url,
    "insert into governor_allowance_usage (source_id, period_start, consumed) " +
      "values ($1, $2, $3)",
    [SOURCE, periodStart.toISOString(), LIMIT],
  );
  await query(
    container.url,
    "insert into source_period_stops (source_id, period_start, stopped_at, reason) " +
      "values ($1, $2, $3, 'the vendor answered 403')",
    [SOURCE, periodStart.toISOString(), NOW.toISOString()],
  );
  await query(
    container.url,
    "insert into alert_cooldowns (source_id, listing_id, rule_id, fired_at, " +
      " amount_minor_units, currency) values ($1, '8880044', 'window-low', $2, 799, 'USD')",
    [SOURCE, NOW.toISOString()],
  );

  dashboard = await startTestDashboard({
    pool,
    config: testDashboardConfig({ port: await freeLoopbackPort() }),
    governor: GOVERNOR,
    registry: testRegistry(),
    now: () => NOW,
  });
  browser = await launchBrowser();
  api = await browser.newContext().then((context) => context.request);
}, { timeout: 300_000 });

after(async () => {
  if (browser) await browser.close();
  if (dashboard) await dashboard.close();
  if (pool) await pool.end().catch(() => undefined);
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

/** Every row of every guarded table, every column, as text. */
async function snapshot(): Promise<Record<string, Record<string, string | null>[]>> {
  const taken: Record<string, Record<string, string | null>[]> = {};
  for (const table of GUARDED_TABLES) {
    const columns = await query(
      container.url,
      "select column_name from information_schema.columns " +
        "where table_name = $1 order by ordinal_position",
      [table],
    );
    const selected = columns
      .map((column) => `${String(column.column_name)}::text as ${String(column.column_name)}`)
      .join(", ");
    taken[table] = await query(container.url, `select ${selected} from ${table}`);
  }
  return taken;
}

describe("criterion 11: reading changes nothing, row for row and column for column", () => {
  it("leaves all five tables identical after every view has been read", async () => {
    const before = await snapshot();
    assert.ok(
      Object.values(before).every((rows) => rows.length > 0),
      "a guarded table is empty, so this comparison would prove nothing",
    );

    for (const path of [
      "/",
      `/listing?source=${SOURCE}&listing=8880044`,
      `/listing?source=${SOURCE}&listing=not-tracked`,
      "/nowhere",
    ]) {
      const response = await api.get(`${dashboard.server.origin}${path}`);
      assert.ok(
        [200, 404].includes(response.status()),
        `${path} answered ${response.status()}`,
      );
    }
    // And HEAD, which is also a read.
    await api.head(`${dashboard.server.origin}/`);

    assert.deepEqual(await snapshot(), before);
  });

  it("in particular, reading an allowance AT ITS LIMIT never claims stopped_at", async () => {
    // The specific damage: `AllowanceLedger.check` announces the stop when it
    // finds the counter at the limit, which sets this column and emits the
    // period's one notification. A page that read through it would send that
    // notification every time somebody opened the dashboard.
    const rows = await query(
      container.url,
      "select consumed::text as consumed, warned_at, stopped_at " +
        "from governor_allowance_usage where source_id = $1",
      [SOURCE],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumed, String(LIMIT));
    assert.equal(rows[0].stopped_at, null, "reading the allowance claimed the stop mark");
    assert.equal(rows[0].warned_at, null, "reading the allowance claimed the warn mark");
  });

  it("and the page DID show the allowance, so the read really happened", async () => {
    const page = await openPage(browser, dashboard.server.origin, "/");
    try {
      const text = await renderedText(page);
      assert.match(text, /2000 consumed/);
      assert.match(text, /0 remaining/);
      assert.match(text, /at its limit/);
    } finally {
      await page.close();
    }
  });
});

describe("criterion 23: anything that is not a read is refused, and writes nothing", () => {
  it("answers 405 to every non-read method, on every path", async () => {
    const before = await snapshot();
    for (const path of ["/", `/listing?source=${SOURCE}&listing=8880044`, "/nowhere"]) {
      const url = `${dashboard.server.origin}${path}`;
      const responses = [
        await api.post(url, { data: "x" }),
        await api.put(url, { data: "x" }),
        await api.patch(url, { data: "x" }),
        await api.delete(url),
      ];
      for (const response of responses) {
        assert.equal(response.status(), 405, `${path} answered ${response.status()}`);
        assert.equal(
          (response.headers().allow ?? "").toUpperCase(),
          READ_METHODS.join(", "),
        );
        assert.match(await response.text(), /data-method-not-allowed/);
      }
    }
    assert.deepEqual(await snapshot(), before);
  });

  it("refuses BEFORE the router, so a refused method reaches no query at all", async () => {
    // Asserted where it is provable: a non-read to a path that does not exist
    // is still 405 and never 404, which can only be true if the method check
    // runs first.
    const response = await api.post(`${dashboard.server.origin}/nowhere`, { data: "x" });
    assert.equal(response.status(), 405);
  });

  it("still answers the reads, so the refusals above are not refusing everything", async () => {
    const response = await api.get(`${dashboard.server.origin}/`);
    assert.equal(response.status(), 200);
    const head = await api.head(`${dashboard.server.origin}/`);
    assert.equal(head.status(), 200);
  });
});

describe("criterion 24: it binds the address and port its configuration names", () => {
  it("bound exactly what the configuration said", () => {
    assert.equal(dashboard.server.address, dashboard.config.bindAddress);
    assert.equal(dashboard.server.port, dashboard.config.port);
    assert.equal(isLoopbackAddress(dashboard.server.address), true);
  });

  it("binds ONLY that address: another loopback address on the same port is dead", async () => {
    // 127.0.0.0/8 is all loopback, so a second address on this machine costs
    // nothing and is the only way to tell "bound one address" from "bound
    // everything". A server that had bound the wildcard would answer here.
    const port = await freeLoopbackPort();
    const second = await startTestDashboard({
      pool,
      config: testDashboardConfig({ bindAddress: "127.0.0.2", port }),
      governor: GOVERNOR,
      registry: testRegistry(),
      now: () => NOW,
    });
    try {
      const onItsOwnAddress = await api.get(`http://127.0.0.2:${port}/`);
      assert.equal(onItsOwnAddress.status(), 200);

      await assert.rejects(
        api.get(`http://127.0.0.1:${port}/`, { timeout: 5_000 }),
        "127.0.0.1 answered on a server configured to bind 127.0.0.2, so the " +
          "process bound more than the address its configuration names",
      );
    } finally {
      await second.close();
    }
  });
});

describe("criterion 27: an unreachable database says so and shows no numbers", () => {
  it("renders the refusal, with no chart, no rate and no allowance figure", async () => {
    // The SAME dashboard process, still serving, with the database taken out
    // from under it.
    await docker("stop", container.name);

    const page = await openPage(browser, dashboard.server.origin, "/");
    try {
      assert.equal(await isShown(page, "[data-database-unreachable]"), true);
      assert.match(await renderedText(page), /could not reach the history database/);

      assert.equal(await page.locator("[data-price-chart]").count(), 0);
      assert.equal(await page.locator("[data-datum]").count(), 0);
      assert.equal(await page.locator("[data-rate]").count(), 0);
      assert.equal(await page.locator("[data-allowance]").count(), 0);
      assert.equal(await page.locator("[data-verdict]").count(), 0);

      const text = await renderedText(page);
      assert.doesNotMatch(text, /\d+% (?:success|error|blocked)/);
      assert.doesNotMatch(text, /remaining of/);
      assert.doesNotMatch(text, /healthy/i);
    } finally {
      await page.close();
    }
  });

  it("says the same on a listing view", async () => {
    const page = await openPage(
      browser,
      dashboard.server.origin,
      `/listing?source=${SOURCE}&listing=8880044`,
    );
    try {
      assert.equal(await isShown(page, "[data-database-unreachable]"), true);
      assert.equal(await page.locator("[data-price]").count(), 0);
      assert.doesNotMatch(await renderedText(page), /USD 7\.99/);
    } finally {
      await page.close();
    }
  });

  it("answers rather than hanging, which is what a refusal has to do", async () => {
    const response = await api.get(`${dashboard.server.origin}/`, { timeout: 30_000 });
    assert.equal(response.status(), 503);
  });
});
