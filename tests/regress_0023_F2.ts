/**
 * regress_0023_F2 - impl-gate ordinal 1, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F2: `packages/governor/src/index.ts` exports `createFetchTransport`
 * from the governor package's public surface, and the AC2 check does not report
 * a call site that imports it and sends with it. The bypass therefore needs no
 * new HTTP client, no clever spelling and no new dependency: it is one import
 * of the governor's own published API, and it skips all six gates the governor
 * exists to apply.
 *
 * Acceptance criterion 2 (spec.md):
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced anywhere in the tree THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`.
 *
 * Spine assertion 1 (spec.md, "the five assertions above are this spec's
 * SPINE"), verbatim from the roadmap phase:
 *
 *   WHEN any component fetches a URL THE SYSTEM SHALL route it through one
 *   governor that applies that host's request ceiling and a randomised delay,
 *   and SHALL offer no path that bypasses it
 *
 * `packages/governor/src/index.ts` line 79:
 *
 *   export { createFetchTransport } from "./transport.ts";
 *
 * and `packages/governor/src/transport.ts` line 1 says of itself:
 *
 *   THE ONLY MODULE IN THIS REPOSITORY THAT MAY REACH AN HTTP CLIENT.
 *
 * Both are true, and together they are the hole. `transport.ts` is the only
 * module that NAMES a client, so the allowlist is honest; but the factory it
 * exports hands a live, ungoverned client to any caller, and the check's three
 * rules all look for the name of a client rather than for the use of the one
 * this package publishes. `governor.ts`'s own doc comment claims "there is no
 * second way out of the process"; this is one, and the repository ships it as
 * public API.
 *
 * The first case below DEMONSTRATES the bypass against a stub on 127.0.0.1 -
 * nothing outside loopback is reached, per AC23 - and is expected to PASS: it
 * is the evidence that the call site is a real outbound request and not a
 * theoretical one. The second case is the finding and is expected to FAIL.
 *
 * Expected: the AC2 check reports the call site.
 * Actual at commit 6577121: it reports nothing. This file FAILS.
 *
 * Run: node --test tests/regress_0023_F2.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createFetchTransport, findDirectHttpCallSites } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../test/support/loopback-server.ts";
import type { LoopbackServer } from "../test/support/loopback-server.ts";

let server: LoopbackServer;

before(async () => {
  server = await startLoopbackServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("a price would be here");
  });
});

after(async () => {
  await server.close();
});

/**
 * The bypassing adapter, as its source text. This is exactly what the call site
 * in the first case does, written as a file so the check can be asked about it.
 */
const BYPASSING_ADAPTER = [
  "import { createFetchTransport } from " + '"@deal-sentinel/governor";',
  "",
  "const transport = createFetchTransport();",
  "",
  "export async function priceOf(url: string): Promise<string> {",
  "  const response = await transport.send({",
  "    url,",
  '    method: "GET",',
  "    headers: {},",
  "    timeoutMs: 5000,",
  "    maxBytes: 1048576,",
  "  });",
  "  return response.body;",
  "}",
].join("\n");

describe("F2: the governor package publishes an ungoverned way out", () => {
  it("the exported transport really sends, with none of the six gates (evidence)", async () => {
    // No Governor is constructed. No configuration is loaded. This is the whole
    // bypass: one import from the package's public API.
    const transport = createFetchTransport();

    const response = await transport.send({
      url: `${server.origin}/listing/1`,
      method: "GET",
      headers: {},
      timeoutMs: 5_000,
      maxBytes: 1_048_576,
    });

    assert.equal(response.status, 200);
    assert.equal(server.served.length, 1, "the request did not leave the process");

    // Gate 5 of the six: nothing asked this host what its robots.txt says.
    assert.equal(
      server.servedFor("/robots.txt").length,
      0,
      "robots.txt was consulted, so this was not in fact ungoverned",
    );

    // And there was no configured ceiling for this host anywhere in sight: a
    // request to a host the governor would have refused outright (gate 1) went
    // out unimpeded.
  });

  it("the AC2 check reports that call site", () => {
    const findings = findDirectHttpCallSites([
      { path: "packages/adapters/src/retailer.ts", text: BYPASSING_ADAPTER },
    ]);

    assert.ok(
      findings.length > 0,
      "an adapter that imports createFetchTransport from @deal-sentinel/governor " +
        "and sends with it issues an outbound HTTP request outside the governor, " +
        "skipping the host ceiling, the randomised delay, the robots decision, " +
        "the back-pressure hold, the breaker and the allowance - and the AC2 " +
        "check reported nothing",
    );
  });
});
