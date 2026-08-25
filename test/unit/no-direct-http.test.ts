/**
 * Acceptance criterion 2 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced anywhere in the tree THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`.
 *
 * Graded by proving UNREACHABILITY and not present-day absence. A check that
 * can only pass proves nothing, so this file does three things in this order:
 *
 *   1. runs the check over committed fixture call sites that bypass the
 *      governor and asserts it REJECTS them - a bare `fetch(`, a second client
 *      imported and used, and one hidden in a template literal;
 *   2. runs it over a fixture that goes through the governor and over one that
 *      only TALKS about bypasses in comments, and asserts it accepts both, so
 *      the check is not simply refusing everything;
 *   3. runs it over the repository as it stands and asserts no findings.
 *
 * Every offending sample lives in `test/fixtures/no-direct-http/` with a
 * `.fixture` extension, for two reasons: the repository-wide scan does not read
 * those as source, and this test file itself therefore contains no text that
 * the check would have to be taught to ignore. The fixture's TEXT is handed to
 * the same function the repository scan uses, under a synthetic path.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  HTTP_CLIENT_ALLOWLIST,
  collectSourceFiles,
  describeFindings,
  findDirectHttpCallSites,
  stripComments,
} from "@deal-sentinel/governor";
import type { SourceFile } from "@deal-sentinel/governor";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fixture(name: string, asPath: string): SourceFile {
  return {
    path: asPath,
    text: readFileSync(
      path.join(REPO_ROOT, "test/fixtures/no-direct-http", name),
      "utf8",
    ),
  };
}

describe("the check rejects a call site that bypasses the governor", () => {
  it("rejects a bare client call in an adapter", () => {
    const findings = findDirectHttpCallSites([
      fixture("bypassing-adapter.ts.fixture", "packages/adapters/src/retailer.ts"),
    ]);

    assert.ok(
      findings.length > 0,
      "the fixture reaches the network directly and the check reported nothing",
    );
    assert.equal(findings[0].path, "packages/adapters/src/retailer.ts");
    assert.equal(findings[0].rule, "fetch-call");
    assert.match(describeFindings(findings), /reach an HTTP client outside the governor/);
  });

  it("rejects a second HTTP client, imported and used", () => {
    const findings = findDirectHttpCallSites([
      fixture(
        "bypassing-client-import.ts.fixture",
        "packages/adapters/src/legacy.ts",
      ),
    ]);

    const rules = new Set(findings.map((finding) => finding.rule));
    assert.ok(rules.has("client-import"), "the undici and node:https imports were missed");
    assert.ok(
      rules.has("client-request-call"),
      "the direct request through the imported client was missed",
    );
  });

  it("rejects one hidden inside a template literal's interpolation", () => {
    const findings = findDirectHttpCallSites([
      fixture("template-literal-bypass.ts.fixture", "packages/adapters/src/sneaky.ts"),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "fetch-call");
  });

  it("rejects the bypass even beside an allowlisted path", () => {
    // The allowlist is by exact path. A file NEXT TO the one transport is not
    // the one transport.
    const findings = findDirectHttpCallSites([
      fixture("bypassing-adapter.ts.fixture", "packages/governor/src/transport-2.ts"),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, "packages/governor/src/transport-2.ts");
  });

  it("reports the line the call site is actually on", () => {
    const findings = findDirectHttpCallSites([
      fixture("offset-bypass.ts.fixture", "packages/adapters/src/offset.ts"),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 7);
  });
});

describe("the check accepts a call site that goes through the governor", () => {
  it("finds nothing in an adapter that asks the governor", () => {
    const findings = findDirectHttpCallSites([
      fixture("governed-adapter.ts.fixture", "packages/adapters/src/governed.ts"),
    ]);
    assert.deepEqual(findings, []);
  });

  it("does not mistake a comment about a bypass for a bypass", () => {
    const findings = findDirectHttpCallSites([
      fixture("commented-mentions.ts.fixture", "packages/adapters/src/documented.ts"),
    ]);
    assert.deepEqual(findings, []);
  });

  it("leaves string contents alone, so an import specifier stays readable", () => {
    assert.match(stripComments('import x from "node:zlib"; // gone'), /"node:zlib"/);
    assert.doesNotMatch(stripComments("const a = 1; // gone"), /gone/);
  });
});

describe("the tree as it stands has exactly one way out of the process", () => {
  const files = collectSourceFiles(REPO_ROOT);

  it("scanned the repository, not an empty list", () => {
    assert.ok(files.length > 20, `only ${files.length} source files were scanned`);
    for (const expected of [
      "packages/governor/src/transport.ts",
      "packages/governor/src/governor.ts",
      "packages/extractor/src/index.ts",
      "packages/db/src/write-path.ts",
      "test/support/loopback-server.ts",
    ]) {
      assert.ok(
        files.some((file) => file.path === expected),
        `the scan did not reach ${expected}`,
      );
    }
  });

  it("reports no direct HTTP call site anywhere", () => {
    const findings = findDirectHttpCallSites(files);
    assert.deepEqual(findings, [], describeFindings(findings));
  });

  it("would report one if the allowlist were empty, which is what makes the pass mean something", () => {
    const findings = findDirectHttpCallSites(files, []);
    assert.ok(
      findings.some((finding) => finding.path === "packages/governor/src/transport.ts"),
      "with no allowlist the transport itself must be reported; if it is not, " +
        "the scan is not reading it",
    );
  });

  it("keeps the allowlist to the transport and the loopback stub server", () => {
    assert.deepEqual(
      HTTP_CLIENT_ALLOWLIST.map((entry) => entry.path),
      ["packages/governor/src/transport.ts", "test/support/loopback-server.ts"],
    );
    for (const entry of HTTP_CLIENT_ALLOWLIST) {
      assert.ok(entry.why.length > 0, `${entry.path} is allowlisted without a reason`);
      assert.ok(entry.rules.length > 0, `${entry.path} is allowlisted for no rule`);
    }
  });
});
