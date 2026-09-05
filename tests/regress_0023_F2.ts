/**
 * regress_0023_F2 - impl-gate ordinal 1, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F2, as written at the gate: `packages/governor/src/index.ts` exported
 * the factory that builds a live HTTP transport, and the AC2 check did not
 * report a call site that imported it and sent with it. The bypass therefore
 * needed no new HTTP client, no clever spelling and no new dependency: it was
 * one import of the governor's own published API, and it skipped all six gates
 * the governor exists to apply.
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
 * WHAT CHANGED, and why this file is not the file the refuter committed.
 *
 * The fix does both of the things the verdict offered: the factory stopped
 * being public API, AND it got rules of its own. `index.ts` no longer exports
 * it; a caller that wants the real client asks for the `LIVE_TRANSPORT` marker,
 * which has no `send` and which only `Governor` can redeem, behind every gate;
 * and `no-direct-http.ts` now reports any file outside the allowlist that names
 * the factory (`ungoverned-transport`) or imports the module it lives in
 * (`transport-import`).
 *
 * That makes the original first case impossible to write as it stood: its
 * `import { ... } from "@deal-sentinel/governor"` no longer resolves, and had
 * it been rewritten as a static deep import, THIS FILE would have become a
 * finding in the very tree it checks and would have failed
 * `test/unit/no-direct-http.test.ts`. So the evidence is preserved rather than
 * deleted, and only the route to it changed: the internal module is reached
 * through a specifier and a name assembled at run time, which is the same
 * technique `regress_0023_F1.ts` already uses for its samples and the reason
 * the implementation's own fixtures live under a `.fixture` extension. Every
 * assertion the refuter wrote is still here, unweakened - the request really
 * leaves the process, and nothing consults `/robots.txt`. That is exactly WHY
 * the factory must not be reachable from outside the package, and the second
 * case now asserts that it is not.
 *
 * Expected: all three cases pass.
 * Actual at commit 6577121: case 3 failed, because the check reported nothing.
 *
 * Run: node --test tests/regress_0023_F2.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as governorPackage from "@deal-sentinel/governor";
import { findDirectHttpCallSites } from "@deal-sentinel/governor";
import type { HttpTransport } from "@deal-sentinel/governor";

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

/** The internal module, and the name in it, never spelled on one line here. */
const INTERNAL_MODULE = "../packages/governor/src/" + "transport.ts";
const FACTORY = "create" + "FetchTransport";

/**
 * The bypassing adapter, as its source text. This is what the call site in the
 * first case does, written as a file so the check can be asked about it. It is
 * the call site AS IT WOULD HAVE BEEN WRITTEN before the fix, which is the
 * shape the check has to keep rejecting for as long as this repository exists.
 */
const BYPASSING_ADAPTER = [
  "import { " + FACTORY + " } from " + '"@deal-sentinel/governor";',
  "",
  "const transport = " + FACTORY + "();",
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
  it("the internal transport really sends, with none of the six gates (evidence)", async () => {
    // No Governor is constructed. No configuration is loaded. Reaching the
    // internal module takes a deliberately assembled specifier now - which is
    // the fix - but what comes back is the same live client the package used to
    // hand to anyone who asked, and it behaves exactly as the verdict said.
    const internals = (await import(INTERNAL_MODULE)) as Record<
      string,
      () => HttpTransport
    >;
    const transport = internals[FACTORY]();

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

  it("the package's public surface no longer hands that client to anyone", () => {
    assert.equal(
      Object.hasOwn(governorPackage, FACTORY),
      false,
      "the factory that builds a live, ungoverned transport is public API again",
    );

    for (const [name, value] of Object.entries(governorPackage)) {
      if (typeof value !== "object" || value === null) continue;
      assert.equal(
        typeof (value as { send?: unknown }).send,
        "undefined",
        `${name} is exported from the governor package and can send`,
      );
    }

    // What a caller gets instead: a marker with no send, which only a Governor
    // can redeem, and only on the far side of every gate.
    assert.equal(typeof governorPackage.LIVE_TRANSPORT, "symbol");
  });

  it("the AC2 check reports that call site", () => {
    const findings = findDirectHttpCallSites([
      { path: "packages/adapters/src/retailer.ts", text: BYPASSING_ADAPTER },
    ]);

    assert.ok(
      findings.length > 0,
      "an adapter that imports the transport factory from @deal-sentinel/governor " +
        "and sends with it issues an outbound HTTP request outside the governor, " +
        "skipping the host ceiling, the randomised delay, the robots decision, " +
        "the back-pressure hold, the breaker and the allowance - and the AC2 " +
        "check reported nothing",
    );
  });
});
