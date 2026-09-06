#!/usr/bin/env node
/**
 * A whole process whose only job is to record one fetch outcome and then exit.
 *
 * "That record SHALL survive the process that wrote it exiting" is a claim about
 * a process boundary, and a second connection from the same process does not
 * cross one. So the grader spawns THIS, waits for it to exit, and then reads the
 * row from a process that never held the writer.
 *
 * Everything here is the real path: the real `Governor`, the real
 * `redactedTelemetry` sink, the real Drizzle store, the real migration's table.
 * The transport is a stub and the host is the vendor's real hostname, so not one
 * byte can reach a third party even though every gate is live.
 *
 * Usage:
 *   node test/support/record-outcome-child.ts <url> [outcome] [sourceId]
 *                                             [minimumOutcomes] [repeat]
 *
 * `minimumOutcomes` and `repeat` exist for the breaker criterion: a pause is a
 * thing the breaker DECIDES, so the grader makes it decide one rather than
 * inserting a row that looks like the decision.
 */

import process from "node:process";
import pg from "pg";

import { createDatabase, drizzleBreakerPauses, drizzleFetchOutcomes } from "@deal-sentinel/db";
import { Governor, createMemoryAllowanceStore } from "@deal-sentinel/governor";
import type { Clock, GovernorConfig, HttpTransport } from "@deal-sentinel/governor";
import { redactedTelemetry, validateSourceRegistry } from "@deal-sentinel/sources";

const url = process.argv[2];
/** "ok", a numeric status, or "error" for a transport failure. */
const outcome = process.argv[3] ?? "ok";
const sourceId = process.argv[4] ?? "bestbuy-api";
/** How many outcomes must be in the breaker's window before its rate means anything. */
const minimumOutcomes = Number(process.argv[5] ?? "4");
/** How many times to offer the fetch. More than one only for the breaker. */
const repeat = Number(process.argv[6] ?? "1");

const HOST = "api.bestbuy.com";

const config: GovernorConfig = {
  userAgent: "deal-sentinel-test/0.0 (+nothing leaves)",
  http: { requestTimeoutMs: 2000, maxResponseBytes: 1_048_576 },
  hosts: {
    [HOST]: { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
  },
  robots: {
    productToken: "deal-sentinel",
    cacheBoundMs: 3_600_000,
    parsingLimitBytes: 512_000,
  },
  backPressure: { defaultBackoffMs: 300_000 },
  breaker: {
    windowMs: 600_000,
    minimumOutcomes,
    failureRateThreshold: 0.5,
    pauseMs: 1_800_000,
  },
  sources: { "bestbuy-api": {}, "second-source": {} },
};

/** Virtual time that advances when the scheduler waits on it. */
let instant = Date.now();
const clock: Clock = {
  now: () => instant,
  async sleep(ms) {
    instant += ms;
  },
};

const transport: HttpTransport = {
  async send(request) {
    if (new URL(request.url).pathname === "/robots.txt") {
      return { status: 404, headers: {}, body: "", truncated: false };
    }
    if (outcome === "error") throw new Error("socket hang up");
    return {
      status: outcome === "ok" ? 200 : Number(outcome),
      headers: {},
      body: "{}",
      truncated: false,
    };
  },
};

const registry = validateSourceRegistry(
  {
    sources: {
      "bestbuy-api": {
        baseUrl: `https://${HOST}/v1`,
        currency: "USD",
        timeZone: "America/New_York",
        rawContextRetentionHours: 24,
        credentialVariable: "BESTBUY_API_KEY",
      },
    },
  },
  "the child's source configuration",
);

const pool = new pg.Pool({ connectionString: url });
const database = createDatabase(pool);

const governor = new Governor({
  config,
  clock,
  random: () => 0.5,
  transport,
  notifier: { notify() {} },
  allowanceStore: createMemoryAllowanceStore(),
  telemetry: redactedTelemetry({
    outcomes: drizzleFetchOutcomes(database),
    pauses: drizzleBreakerPauses(database),
    registry,
    redactor: { scrub: (text) => text },
  }),
});

for (let offered = 0; offered < repeat; offered += 1) {
  await governor.request({
    url: `https://${HOST}/v1/products/8880044.json?show=sku&apiKey=child-key`,
    sourceId,
  });
}

await pool.end();
process.exit(0);
