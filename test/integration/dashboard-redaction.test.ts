/**
 * Acceptance criterion 22 of spec S0042-deal-sentinel-ops-5, GRADED IN A REAL
 * BROWSER ENGINE:
 *
 *   WHEN the page renders any recorded condition, refusal detail or stop reason
 *   THE SYSTEM SHALL render it with the credential and the value of the parameter
 *   carrying it redacted, so no rendered text on any view contains either.
 *
 * THE ROWS HERE ARE SEEDED UNREDACTED, ON PURPOSE. Criterion 7 is the write
 * path; this is the SCREEN, and the whole point of a display path checking again
 * is the row the write path did not catch: one written by an older build, one
 * restored from a dump, one an operator pasted in while debugging. A test that
 * seeded already-redacted rows would be asserting that redacted text stays
 * redacted.
 *
 * "No rendered text" is a claim about what a browser shows, so it is asserted
 * against `document.body.innerText` - what a human reads, after the engine has
 * laid the page out - and not against the markup, where a credential could sit
 * in an attribute nobody displays and pass a text scan either way.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { Browser, Page } from "playwright";

import { addWatchlistEntry, createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { answer } from "@deal-sentinel/dashboard";
import { CREDENTIAL_PLACEHOLDER } from "@deal-sentinel/sources";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import {
  launchBrowser,
  openPage,
  renderedText,
  seedObservationRows,
  seedOutcomes,
  startTestDashboard,
  testDashboardConfig,
} from "../support/dashboard-harness.ts";
import type { DashboardHarness } from "../support/dashboard-harness.ts";
import {
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_VARIABLE,
  bestBuyGovernorConfig,
  testRegistry,
} from "../support/source-3-harness.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 86_400_000;
const SOURCE = "bestbuy-api";

/** The credentialled URL this vendor's own documented call produces. */
const CREDENTIALLED_URL =
  `https://api.bestbuy.com/v1/products/8880044.json` +
  `?show=sku,name,salePrice&apiKey=${TEST_CREDENTIAL}`;

/** A body this vendor echoes the whole request URL back inside. */
const ECHOED_BODY = `{"canonicalUrl":"/v1/products/8880044.json?apiKey=${TEST_CREDENTIAL}"}`;

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let dashboard: DashboardHarness;
let browser: Browser;
let previousCredential: string | undefined;

before(async () => {
  container = await startPostgres("ops-5-dashboard-redaction");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 dashboard redaction suite" });
  database = createDatabase(pool);

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

  // A recorded CONDITION, unredacted.
  await seedOutcomes(container.url, [
    {
      sourceId: SOURCE,
      outcomeClass: "error",
      latencyMs: 900,
      occurredAt: new Date(NOW.getTime() - 2 * 3_600_000),
      condition: `transport-error: ${CREDENTIALLED_URL} could not be reached: socket hang up`,
    },
    {
      sourceId: SOURCE,
      outcomeClass: "blocked",
      latencyMs: 80,
      occurredAt: new Date(NOW.getTime() - 3_600_000),
      // The vendor echoing the URL back inside its own body, under a key
      // nothing predicted.
      condition: `blocked: the far side answered 403 with ${ECHOED_BODY}`,
    },
  ]);

  // A recorded STOP REASON, unredacted.
  await query(
    container.url,
    "insert into source_period_stops (source_id, period_start, stopped_at, reason) " +
      "values ($1, $2, $3, $4)",
    [
      SOURCE,
      new Date(Math.floor(NOW.getTime() / DAY) * DAY).toISOString(),
      NOW.toISOString(),
      `bestbuy-api answered 403 for ${CREDENTIALLED_URL}`,
    ],
  );

  // A recorded PAUSE CONDITION, unredacted.
  await query(
    container.url,
    "insert into breaker_pauses (source_id, paused_at, expires_at, failing_count, " +
      " window_outcomes, window_ms, failure_rate_threshold, condition) " +
      "values ($1, $2, $3, 3, 4, 600000, '0.5', $4)",
    [
      SOURCE,
      new Date(NOW.getTime() - 60_000).toISOString(),
      new Date(NOW.getTime() + 3_600_000).toISOString(),
      `3 of the last 4 outcomes failed; the last was ${CREDENTIALLED_URL}`,
    ],
  );

  dashboard = await startTestDashboard({
    pool,
    governor: bestBuyGovernorConfig(),
    registry: testRegistry(),
    now: () => NOW,
  });
  browser = await launchBrowser();

  previousCredential = process.env[TEST_CREDENTIAL_VARIABLE];
}, { timeout: 300_000 });

after(async () => {
  if (previousCredential === undefined) delete process.env[TEST_CREDENTIAL_VARIABLE];
  else process.env[TEST_CREDENTIAL_VARIABLE] = previousCredential;
  if (browser) await browser.close();
  if (dashboard) await dashboard.close();
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function open(path: string): Promise<Page> {
  return await openPage(browser, dashboard.server.origin, path);
}

/** Every view this dashboard serves that can carry a recorded string. */
const VIEWS = [
  "/",
  `/listing?source=${SOURCE}&listing=8880044`,
  `/listing?source=${SOURCE}&listing=not-a-listing`,
];

function assertNoCredential(text: string, where: string): void {
  assert.ok(
    !text.includes(TEST_CREDENTIAL),
    `${where} shows the credential itself`,
  );
  assert.ok(
    !/apiKey=(?!\[redacted])/i.test(text),
    `${where} shows the value of the parameter carrying the credential`,
  );
}

describe("criterion 22: no rendered text on any view carries a credential", () => {
  it("shows neither the credential nor the parameter value, on every view", async () => {
    // WITHOUT the credential in this process's environment, which is the shape
    // a read-only display process usually runs in. The parameter rule is what
    // has to carry it.
    delete process.env[TEST_CREDENTIAL_VARIABLE];
    for (const view of VIEWS) {
      const page = await open(view);
      try {
        assertNoCredential(await renderedText(page), view);
      } finally {
        await page.close();
      }
    }
  });

  it("redacts the condition, the stop reason and the pause condition each by name", async () => {
    delete process.env[TEST_CREDENTIAL_VARIABLE];
    const page = await open("/");
    try {
      for (const selector of [
        "[data-condition-text]",
        "[data-vendor-stop-reason]",
        "[data-pause-condition]",
      ]) {
        const elements = page.locator(selector);
        const count = await elements.count();
        assert.ok(count > 0, `${selector} is not on the page at all`);
        for (let index = 0; index < count; index += 1) {
          const text = await elements.nth(index).innerText();
          assertNoCredential(text, `${selector}[${index}]`);
          assert.ok(
            text.includes(CREDENTIAL_PLACEHOLDER),
            `${selector}[${index}] carried a credentialled URL and shows no ` +
              `redaction marker: ${text}`,
          );
        }
      }
    } finally {
      await page.close();
    }
  });

  it("redacts the SECRET ITSELF where this process can see it", async () => {
    // The rule the parameter rule cannot cover: a value echoed back under a key
    // nobody predicted. A process holding the credential replaces it wherever
    // it appears, and this one does.
    process.env[TEST_CREDENTIAL_VARIABLE] = TEST_CREDENTIAL;
    await query(
      container.url,
      "insert into fetch_outcomes (source_id, outcome_class, latency_ms, occurred_at, condition) " +
        "values ($1, 'error', 5, $2, $3)",
      [
        SOURCE,
        new Date(NOW.getTime() - 600_000).toISOString(),
        // No parameter around it at all: a bare secret in a message.
        `the vendor said the key ${TEST_CREDENTIAL} is not valid`,
      ],
    );
    const page = await open("/");
    try {
      const text = await renderedText(page);
      assert.ok(!text.includes(TEST_CREDENTIAL), text.slice(0, 600));
      assert.match(text, /the key \[redacted] is not valid/);
    } finally {
      await page.close();
    }
  });

  it("the rows really do carry it, so the assertions above are not vacuous", async () => {
    const rows = await query(
      container.url,
      "select condition from fetch_outcomes union all " +
        "select reason as condition from source_period_stops union all " +
        "select condition from breaker_pauses",
    );
    const carrying = rows.filter((row) =>
      (row.condition ?? "").includes(TEST_CREDENTIAL),
    );
    assert.ok(
      carrying.length >= 4,
      `only ${carrying.length} stored rows carry the credential, so this suite ` +
        "is not exercising the path the redaction protects",
    );
  });

  it("WOULD show it if the display path did not redact", async () => {
    // The mutation. Rendering the same rows with a pass-through redactor puts
    // the credential on the page, which is what the assertions above are
    // catching and what makes them evidence.
    const given = await answer(
      {
        config: testDashboardConfig(),
        governor: bestBuyGovernorConfig(),
        registry: testRegistry(),
        database,
        redactor: { scrub: (text) => text },
        now: () => NOW,
      },
      "GET",
      "/",
    );
    assert.equal(given.status, 200);
    assert.ok(
      given.body.includes(TEST_CREDENTIAL),
      "the unredacted render did NOT carry the credential, so the redaction " +
        "is not what is keeping it off the page",
    );
  });
});
