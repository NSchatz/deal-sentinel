/**
 * Regression test for finding F1 of the S0042-deal-sentinel-ops-5 impl gate.
 *
 * AC24: "WHEN the dashboard process starts THE SYSTEM SHALL bind only the
 * address and port its configuration names, and the configuration committed to
 * this repository SHALL name a loopback address."
 *
 * The defect the impl-gate refuter measured: `packages/dashboard/src/config.ts`
 * enforced the first half with a four-entry denylist of SPELLINGS,
 *
 *     const WILDCARD_ADDRESSES = ["0.0.0.0", "::", "*", ""];
 *
 * and this runtime binds at least a dozen other spellings of the same address
 * to INADDR_ANY / in6addr_any. `::0`, `0000:0000:0000:0000:0000:0000:0000:0000`,
 * `::ffff:0.0.0.0` and `0` all walked through the loader, and the process then
 * answered on this container's routable address while its configuration named
 * one address.
 *
 * The file the refuter wrote REPRODUCED that. This one is its regression twin:
 * every assertion below states the criterion, so it is green while the property
 * holds and red the moment it stops. Three parts, in the order that makes the
 * third one mean something:
 *
 *   1. the loader refuses every spelling of the unspecified address, including
 *      spellings assembled here that appear in no list anywhere in the tree;
 *   2. MUTATION - with the loader bypassed, the shipped server on `::0` DOES
 *      answer on this machine's routable address, which is what proves the
 *      probe below can detect the defect at all;
 *   3. with the loader in place and a loopback address configured, the routable
 *      address is dead.
 *
 * The socket is reached through Playwright's request context, the same way
 * `test/integration/dashboard-read-only.test.ts` reaches it, so this file names
 * no HTTP client and stays clean under the single-chokepoint proof.
 *
 * Run with:
 *
 *     node --test tests/regress_0042_F1.ts
 */

import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { APIRequestContext, Browser } from "playwright";

import { createDatabase } from "@deal-sentinel/db";
import {
  DashboardConfigError,
  startDashboard,
  validateDashboardConfig,
} from "@deal-sentinel/dashboard";
import type { DashboardConfig } from "@deal-sentinel/dashboard";

import { launchBrowser } from "../test/support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../test/support/source-3-harness.ts";

/**
 * The four spellings the refuter measured, plus ten more this runtime binds to
 * the unspecified address, plus four assembled for this file and measured
 * against nothing. The last group is the point: a fix that enumerated spellings
 * would pass on the first fourteen and fail on the last four.
 */
const WILDCARD_SPELLINGS = [
  // Measured by the refuter, in `regress_0042_probe_bind.mjs`.
  "0.0.0.0",
  "::",
  "::0",
  "0",
  "::ffff:0.0.0.0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  // Measured in this loop, in `regress_0042_probe_bind2.mjs`.
  "00",
  "0.0",
  "0.0.0",
  "0x0",
  "0x00000000",
  "0000000000",
  "000.000.000.000",
  "0:0:0:0:0:0:0:0",
  "::0.0.0.0",
  "::ffff:0:0",
  // Written here for the first time, measured against no probe at all.
  "0000:0:0000:0:0000:0:0000:0",
  "0:0:0:0:0:0:0.0.0.0",
  "0x0.0x0.0x0.0x0",
  "000000",
];

let browser: Browser;
let api: APIRequestContext;

before(async () => {
  browser = await launchBrowser();
  api = await browser.newContext().then((context) => context.request);
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
}, { timeout: 60_000 });

/** A real, non-loopback IPv4 address this machine carries. */
function routableAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      return address.address;
    }
  }
  return null;
}

/** A pool pointed at nothing. The page it produces still proves the binding. */
function deadPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: "postgres://nobody@127.0.0.1:1/none",
    connectionTimeoutMillis: 500,
  });
  pool.on("error", () => undefined);
  return pool;
}

function probeDocument(bindAddress: string, port: number): Record<string, unknown> {
  return {
    bindAddress,
    port,
    stalenessHorizonMs: 3_600_000,
    ratePeriodMs: 86_400_000,
    defaultChartRangeMs: 7_776_000_000,
    conditionHistoryLimit: 20,
  };
}

function probeConfig(bindAddress: string, port: number): DashboardConfig {
  return validateDashboardConfig(
    probeDocument(bindAddress, port),
    "the F1 probe configuration",
  );
}

/** The configuration the loader would refuse, built anyway. This is the mutation. */
function bypassedConfig(bindAddress: string, port: number): DashboardConfig {
  return { ...probeConfig("127.0.0.1", port), bindAddress };
}

describe("F1 (AC24): the unspecified address is refused however it is spelled", () => {
  it("refuses every spelling of it, including four written here for the first time", () => {
    for (const spelling of WILDCARD_SPELLINGS) {
      assert.throws(
        () => probeConfig(spelling, 18_791),
        (error: unknown) => {
          assert.ok(error instanceof DashboardConfigError);
          assert.equal(error.setting, "bindAddress");
          return true;
        },
        `${spelling} was accepted as a bind address, so the process would bind ` +
          "every interface this machine has while its configuration named one",
      );
    }
  });

  it("MUTATION: with the loader bypassed, `::0` really does answer on the routable address", async () => {
    // Without this, the assertion after it could pass because the probe cannot
    // find a socket rather than because there is none to find.
    const reachable = routableAddress();
    assert.ok(reachable !== null, "this machine has no non-loopback IPv4 address");

    const pool = deadPool();
    const config = bypassedConfig("::0", 18_792);
    const server = await startDashboard({
      config,
      governor: bestBuyGovernorConfig(),
      registry: testRegistry(),
      database: createDatabase(pool),
    });

    try {
      const answered = await api.get(`http://${reachable}:${config.port}/`, {
        timeout: 10_000,
      });
      // 503: the pool points at nothing, so the page is the "history database
      // unreachable" one. That it answers AT ALL is the whole point.
      assert.ok(
        answered.status() > 0,
        "a wildcard bind did not answer on the routable address, so the " +
          "criterion assertion below proves nothing",
      );
    } finally {
      await server.close();
      await pool.end();
    }
  });

  it("binds only the address its configuration names, and the routable one is dead", async () => {
    const reachable = routableAddress();
    assert.ok(reachable !== null, "this machine has no non-loopback IPv4 address");

    const pool = deadPool();
    const config = probeConfig("127.0.0.1", 18_793);
    const server = await startDashboard({
      config,
      governor: bestBuyGovernorConfig(),
      registry: testRegistry(),
      database: createDatabase(pool),
    });

    try {
      const onItsOwnAddress = await api.get(`http://127.0.0.1:${config.port}/`, {
        timeout: 10_000,
      });
      assert.ok(onItsOwnAddress.status() > 0, "the configured address is dead");

      await assert.rejects(
        api.get(`http://${reachable}:${config.port}/`, { timeout: 5_000 }),
        `the dashboard answered on ${reachable}:${config.port} while its ` +
          'configuration named the single address "127.0.0.1". AC24 requires ' +
          "it to bind only the address its configuration names.",
      );
    } finally {
      await server.close();
      await pool.end();
    }
  });
});
