/**
 * Regression test for finding F1 of the S0042-deal-sentinel-ops-5 impl gate.
 *
 * AC24: "WHEN the dashboard process starts THE SYSTEM SHALL bind only the
 * address and port its configuration names, and the configuration committed to
 * this repository SHALL name a loopback address."
 *
 * `packages/dashboard/src/config.ts` enforces the first half with a four-entry
 * denylist:
 *
 *     const WILDCARD_ADDRESSES = ["0.0.0.0", "::", "*", ""];
 *
 * and its own header states the rule that list is meant to implement: "a
 * wildcard is not an address the configuration names, it is every address the
 * machine has, including the one the rest of the world can reach."
 *
 * The denylist is spelling-based, and it misses at least four other spellings of
 * the same wildcard that Node accepts and binds to INADDR_ANY / in6addr_any:
 *
 *     "::0"                                      -> binds ::
 *     "0000:0000:0000:0000:0000:0000:0000:0000"  -> binds ::
 *     "::ffff:0.0.0.0"                           -> binds the IPv4 wildcard
 *     "0"                                        -> binds 0.0.0.0
 *
 * This test takes one of them, loads it through the shipped loader, starts the
 * shipped server on it, and then reaches the socket over a NON-LOOPBACK address
 * of this machine. A page comes back, which is the criterion failing: the
 * process bound an address the configuration did not name.
 *
 * The exposure is the one the spec's own Blast Radius paragraph calls
 * irreversible - this is the system's first listening socket and its first
 * display path, with no authentication, no TLS and no accounts, rendering vendor
 * refusal details derived from URLs that carry a credential in the query string.
 *
 * No database is needed: the socket answers the "history database unreachable"
 * page, which is enough to prove what it is bound to. The socket is reached
 * through Playwright's request context, the same way
 * `test/integration/dashboard-read-only.test.ts` reaches it, so that this file
 * names no HTTP client and stays clean under the single-chokepoint proof.
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
import { startDashboard, validateDashboardConfig } from "@deal-sentinel/dashboard";

import { launchBrowser } from "../test/support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../test/support/source-3-harness.ts";

/** Every spelling of "every interface" this machine's runtime actually accepts. */
const WILDCARD_SPELLINGS = [
  "::0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "::ffff:0.0.0.0",
  "0",
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
function nonLoopbackAddress(): string | null {
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

function probeConfig(bindAddress: string, port: number) {
  return validateDashboardConfig(
    {
      bindAddress,
      port,
      stalenessHorizonMs: 3_600_000,
      ratePeriodMs: 86_400_000,
      defaultChartRangeMs: 7_776_000_000,
      conditionHistoryLimit: 20,
    },
    "the F1 probe configuration",
  );
}

describe("F1 (AC24): the wildcard denylist misses equivalent spellings", () => {
  it("the loader accepts spellings of the wildcard it means to refuse", () => {
    for (const spelling of WILDCARD_SPELLINGS) {
      // Documents the gap rather than asserting the criterion: the loader
      // returns these unchanged where it refuses "0.0.0.0" and "::".
      assert.equal(probeConfig(spelling, 18_791).bindAddress, spelling);
    }
  });

  it("binds every interface, so it binds an address the configuration did not name", async () => {
    const reachable = nonLoopbackAddress();
    assert.ok(
      reachable !== null,
      "this machine has no non-loopback IPv4 address, so this probe cannot run",
    );

    const pool = deadPool();
    // "::0" is the ordinary IPv6 spelling of the wildcard the loader refuses as
    // "::". Nothing distinguishes the two but the text.
    const config = probeConfig("::0", 18_792);

    const server = await startDashboard({
      config,
      governor: bestBuyGovernorConfig(),
      registry: testRegistry(),
      database: createDatabase(pool),
    });

    try {
      const response = await api.get(`http://${reachable}:${config.port}/`, {
        timeout: 10_000,
      });
      assert.fail(
        `the dashboard answered on ${reachable}:${config.port} (status ` +
          `${response.status()}) while its configuration named the single ` +
          'address "::0". AC24 requires it to bind only the address its ' +
          "configuration names; it bound every interface this machine has, " +
          "including one the rest of the network can reach.",
      );
    } finally {
      await server.close();
      await pool.end();
    }
  });
});
