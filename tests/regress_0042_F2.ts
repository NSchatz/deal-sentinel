/**
 * Regression test for finding F2 of the S0042-deal-sentinel-ops-5 impl gate.
 *
 * AC29: "THE SYSTEM SHALL keep the single-chokepoint proof passing with no new
 * module added to its allowlist: nothing this spec adds reaches an HTTP client,
 * and a server socket is not one."
 *
 * The spec sanctions the server/client distinction, and this diff implements it
 * as a rule rather than an allowlist entry. The rule's own recorded reading (9
 * of `## Readings taken`, item 6) states the property it claims:
 *
 *   "`import { request } from "node:http"` and any binding not on the list are
 *    all still findings, in every file"
 *
 * That property does not hold. `findDirectHttpCallSites` computes the exemption
 * as a set of LINE NUMBERS (`serverOnlyImportLines`) and then skips the
 * `client-import` and `client-module-literal` rules for the whole of any line in
 * that set. Two import statements on one physical line therefore share one
 * verdict: the server-only one exempts the line, and the client import beside it
 * is never reported.
 *
 * Every specifier below is assembled at run time so this file is not itself a
 * finding of the check it exercises. Run with:
 *
 *     node --test tests/regress_0042_F2.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeFindings, findDirectHttpCallSites } from "@deal-sentinel/governor";

const HTTP = "node" + ":" + "http";
const HTTPS = "node" + ":" + "https";
const CLIENT_BINDING = "req" + "uest";

describe("F2 (AC29): the server-only exemption is per line, not per import", () => {
  it("reports a client import that stands on its own line, as it should", () => {
    const source = [
      `import { createServer } from "${HTTP}";`,
      `import { ${CLIENT_BINDING} } from "${HTTPS}";`,
      "export const x = 1;",
    ].join("\n");

    const findings = findDirectHttpCallSites([
      { path: "packages/dashboard/src/two-lines.ts", text: source },
    ]);

    assert.ok(
      findings.some((finding) => finding.rule === "client-import"),
      "the control case is broken: a client import on its own line was not " +
        "reported, so the assertion below would prove nothing",
    );
  });

  it("MISSES the same client import when it shares a line with a server-only one", () => {
    const source = [
      `import { createServer } from "${HTTP}"; import { ${CLIENT_BINDING} } from "${HTTPS}";`,
      "export const x = 1;",
    ].join("\n");

    const findings = findDirectHttpCallSites([
      { path: "packages/dashboard/src/one-line.ts", text: source },
    ]);

    assert.ok(
      findings.some((finding) => finding.rule === "client-import"),
      "an import of " +
        HTTPS +
        " binding " +
        CLIENT_BINDING +
        " was NOT reported because it shares a physical line with a " +
        "server-only import of " +
        HTTP +
        ". The exemption is keyed by line number, so one server-only import " +
        "silently exempts every client import beside it. " +
        describeFindings(findings),
    );
  });

  it("MISSES a node:net socket import on the same line too", () => {
    // Not a hypothetical spelling: `node:net` is the specifier the loopback
    // stub server is allowlisted for, and it reaches the wire directly.
    const NET = "node" + ":" + "net";
    const source = [
      `import { createServer } from "${HTTP}"; import { Socket } from "${NET}";`,
      "export const x = 1;",
    ].join("\n");

    const findings = findDirectHttpCallSites([
      { path: "packages/dashboard/src/one-line-net.ts", text: source },
    ]);

    assert.ok(
      findings.some((finding) => finding.rule === "client-import"),
      "a raw socket import was not reported because it shares a line with a " +
        "server-only import. " + describeFindings(findings),
    );
  });
});
