/**
 * The dashboard under a real browser engine, and the seeding helpers around it.
 *
 * WHY A BROWSER AT ALL. Seven of this phase's criteria are claims about what a
 * page SHOWS - one plotted point per stored observation, an empty state that
 * draws no axis, a price scaled by its currency's own exponent, an attribution
 * that is visible in the same view, a credential that appears in no rendered
 * text. None of those can be decided by reading served HTML or CSS: text cannot
 * say what won the cascade, what is displayed, what has a box on the screen, or
 * whether an "empty" chart still drew its axes. So the graders drive Chromium
 * and assert against the rendered DOM and the computed style.
 *
 * The engine is the one already in this container at `/usr/bin/chromium`;
 * Playwright is the driver and downloads nothing (this container runs installs
 * with lifecycle scripts off, and the baked binary is the browser being driven).
 *
 * NOTHING HERE REACHES A THIRD PARTY. The browser is pointed at a dashboard on
 * loopback, that dashboard holds no governor, no adapter and no transport, and
 * the database is the same real PostgreSQL container every other integration
 * test brings up.
 */

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import pg from "pg";

import { createDatabase } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { startDashboard, validateDashboardConfig } from "@deal-sentinel/dashboard";
import type { DashboardConfig, DashboardServer } from "@deal-sentinel/dashboard";
import type { GovernorConfig } from "@deal-sentinel/governor";
import type { SourceRegistry } from "@deal-sentinel/sources";

import { closedLoopbackOrigin } from "./loopback-server.ts";
import { bestBuyGovernorConfig, testRegistry } from "./source-3-harness.ts";

/** The engine baked into this container. Not downloaded, not bundled. */
export const CHROMIUM_PATH = process.env.DEAL_SENTINEL_CHROMIUM ?? "/usr/bin/chromium";

/**
 * A dashboard configuration a test can bend one value of.
 *
 * The port is a REAL port and never 0, because the loader refuses 0 and should:
 * "bind only the address and port its configuration names" is not a thing a
 * configuration naming no port can be held to. A suite that opens a socket asks
 * `freeLoopbackPort` for one first and puts THAT in the configuration, so the
 * port the server binds is the port the document names.
 */
export function testDashboardConfig(
  overrides: Partial<DashboardConfig> = {},
): DashboardConfig {
  return validateDashboardConfig(
    {
      bindAddress: "127.0.0.1",
      port: 18_787,
      stalenessHorizonMs: 3_600_000,
      ratePeriodMs: 86_400_000,
      defaultChartRangeMs: 7_776_000_000,
      conditionHistoryLimit: 20,
      ...overrides,
    },
    "the test dashboard configuration",
  );
}

/**
 * A loopback port nothing is listening on, obtained by binding one and letting
 * it go. The suite then names that port in its configuration.
 */
export async function freeLoopbackPort(): Promise<number> {
  const origin = await closedLoopbackOrigin();
  return Number(origin.slice(origin.lastIndexOf(":") + 1));
}

export type DashboardHarness = {
  server: DashboardServer;
  database: HistoryDatabase;
  config: DashboardConfig;
  close(): Promise<void>;
};

/** Start a dashboard on loopback against an already-initialized database. */
export async function startTestDashboard(options: {
  pool: pg.Pool;
  config?: DashboardConfig;
  governor?: GovernorConfig;
  registry?: SourceRegistry;
  now?: () => Date;
}): Promise<DashboardHarness> {
  const config =
    options.config ?? testDashboardConfig({ port: await freeLoopbackPort() });
  const database = createDatabase(options.pool);
  const server = await startDashboard({
    config,
    governor: options.governor ?? bestBuyGovernorConfig(),
    registry: options.registry ?? testRegistry(),
    database,
    now: options.now,
  });

  return {
    server,
    database,
    config,
    async close() {
      await server.close();
    },
  };
}

/**
 * A Chromium, driven.
 *
 * `--no-sandbox` because this already IS the sandbox: a disposable container
 * with no privileged user, where Chromium's own namespace sandbox cannot be set
 * up. `--disable-dev-shm-usage` because the container's `/dev/shm` is small and
 * the renderer would otherwise fall over on a page with an SVG in it.
 */
export async function launchBrowser(): Promise<Browser> {
  return await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** Open one page on a dashboard and wait for the document to be parsed. */
export async function openPage(
  browser: Browser,
  origin: string,
  path: string,
): Promise<Page> {
  const page = await browser.newPage();
  const response = await page.goto(`${origin}${path}`, {
    waitUntil: "domcontentloaded",
  });
  if (response === null) {
    throw new Error(`no response for ${path}`);
  }
  return page;
}

/**
 * The browser's own globals, named for the type checker.
 *
 * Declared INLINE inside each evaluated function rather than by turning the DOM
 * library on for the whole repository: this is a Node project, `document` is not
 * a thing that exists in any file it compiles, and adding the DOM globals
 * everywhere to type six lines in one test helper would trade a real guarantee
 * for a convenience. The function bodies below run in the page and can reference
 * nothing from this module, so the cast has to be where it is.
 */
type BrowserGlobals = {
  document: {
    body: { innerText: string };
    querySelector(selector: string): BrowserElement | null;
  };
  getComputedStyle(element: BrowserElement): Record<string, string>;
};

type BrowserElement = {
  getBoundingClientRect(): { width: number; height: number };
};

/**
 * Is this element actually SHOWN - not merely present in the document?
 *
 * Computed style plus a painted box, which is the pair a text grader cannot
 * evaluate at all: `display: none`, a zero-height box and a rule that only wins
 * the cascade at one viewport are each invisible to anything reading HTML.
 */
export async function isShown(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate((query: string) => {
    const globals = globalThis as unknown as BrowserGlobals;
    const element = globals.document.querySelector(query);
    if (element === null) return false;
    const style = globals.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }, selector);
}

/** One resolved CSS property of one element, as the engine computed it. */
export async function computedStyle(
  page: Page,
  selector: string,
  property: string,
): Promise<string | null> {
  return await page.evaluate(
    ({ query, name }: { query: string; name: string }) => {
      const globals = globalThis as unknown as BrowserGlobals;
      const element = globals.document.querySelector(query);
      if (element === null) return null;
      return globals.getComputedStyle(element)[name] ?? null;
    },
    { query: selector, name: property },
  );
}

/** The text a human actually reads off the rendered page. */
export async function renderedText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const globals = globalThis as unknown as BrowserGlobals;
    return globals.document.body.innerText;
  });
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

export type SeededOutcome = {
  sourceId: string;
  outcomeClass: "success" | "error" | "blocked" | "refused";
  latencyMs: number;
  occurredAt: Date;
  condition?: string | null;
};

/**
 * Put fetch outcomes in by hand.
 *
 * Deliberate, and stated so nobody mistakes it for laziness: the criteria about
 * RATES are about arithmetic over rows inside a period, and producing forty rows
 * at chosen instants through the real chokepoint would be producing them through
 * a virtual clock that the arithmetic under test would then also be reading. The
 * criterion that the real path writes a real row is graded separately, in
 * `telemetry-record.test.ts`, through the governor with nothing stubbed but the
 * transport.
 */
export async function seedOutcomes(
  url: string,
  outcomes: readonly SeededOutcome[],
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const outcome of outcomes) {
      await client.query(
        "insert into fetch_outcomes (source_id, outcome_class, latency_ms, occurred_at, condition) " +
          "values ($1, $2, $3, $4, $5)",
        [
          outcome.sourceId,
          outcome.outcomeClass,
          outcome.latencyMs,
          outcome.occurredAt.toISOString(),
          outcome.condition ?? null,
        ],
      );
    }
  } finally {
    await client.end();
  }
}

export type SeededObservation = {
  sourceId: string;
  listingId: string;
  amountMinorUnits: bigint;
  currency: string;
  observedAt: Date;
  sourceTimeZone?: string;
  vendorPriceUpdatedAt?: Date | null;
};

/** Put price observations in by hand, for the chart criteria. */
export async function seedObservationRows(
  url: string,
  rows: readonly SeededObservation[],
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const row of rows) {
      await client.query(
        "insert into price_observations " +
          "(source_id, listing_id, amount_minor_units, currency, observed_at, " +
          " source_time_zone, vendor_price_updated_at, raw_context) " +
          "values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          row.sourceId,
          row.listingId,
          row.amountMinorUnits.toString(),
          row.currency,
          row.observedAt.toISOString(),
          row.sourceTimeZone ?? "America/New_York",
          row.vendorPriceUpdatedAt?.toISOString() ?? null,
          "{}",
        ],
      );
    }
  } finally {
    await client.end();
  }
}
