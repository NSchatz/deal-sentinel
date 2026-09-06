/**
 * Acceptance criterion 2 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced anywhere in the tree THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`.
 *
 * Graded by proving UNREACHABILITY and not present-day absence. A check that
 * can only pass proves nothing, so this file does five things in this order:
 *
 *   1. runs the check over committed fixture call sites that bypass the
 *      governor and asserts it REJECTS them - a bare `fetch(`, a second client
 *      imported and used, one hidden in a template literal, and every way the
 *      SAME global client can be resolved under another name: through `global`,
 *      through a bracket property, through a local alias of the global object,
 *      through a renamed destructure, and as a value with no call attached;
 *   2. runs it over fixtures that reach the network the supported way - one
 *      that asks a Governor, one that asks for the `LIVE_TRANSPORT` marker -
 *      and over ones that only TALK about bypasses in comments and in strings,
 *      and asserts it accepts all of them, so the check is not simply refusing
 *      everything;
 *   3. runs it over fixtures that reach this package's OWN ungoverned
 *      transport, by the public name it used to carry and by a deep import of
 *      the module it lives in, and asserts both are rejected;
 *   4. runs it over samples that reach the wire through a MECHANISM rather than
 *      through a client's name - a specifier handed to the result of a call, a
 *      raw socket, a global that opens its own connection, a subprocess that
 *      fetches - and asserts each is rejected;
 *   5. runs it over the repository as it stands and asserts no findings, and
 *      asserts that the public surface hands out nothing that can send.
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

import * as governor from "@deal-sentinel/governor";
import {
  HTTP_CLIENT_ALLOWLIST,
  collectSourceFiles,
  describeFindings,
  findDirectHttpCallSites,
  maskStringLiterals,
  normaliseComputedAccess,
  stripComments,
} from "@deal-sentinel/governor";
import type { SourceFile } from "@deal-sentinel/governor";
import * as sources from "@deal-sentinel/sources";

import { fixtureAnswer, sourceHarness } from "../support/source-3-harness.ts";

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

/**
 * The finding this suite exists to make impossible a second time: the check
 * used to enumerate the global names the client could be reached through, and
 * every name it had not thought of walked straight past it. `global`,
 * `globalThis["..."]`, a local alias and a renamed destructure all resolve to
 * the identical function, and each of them skips the host ceiling, the
 * randomised delay, the robots decision, the back-pressure hold, the breaker
 * and the allowance in one step, from an address the whole household shares.
 */
describe("the check treats any resolution of the client identifier as a call site", () => {
  const bypasses: [string, string][] = [
    ["`global`, which is Node's own alias for globalThis", "global-alias-bypass.ts.fixture"],
    ["a bracket property on globalThis", "bracket-access-bypass.ts.fixture"],
    ["a one-line alias of the global object", "aliased-global-bypass.ts.fixture"],
    ["a renamed destructure", "renamed-destructure-bypass.ts.fixture"],
    ["the identifier as a value, with no call attached", "value-alias-bypass.ts.fixture"],
  ];

  for (const [what, file] of bypasses) {
    it(`rejects one reached through ${what}`, () => {
      const findings = findDirectHttpCallSites([
        fixture(file, "packages/adapters/src/retailer.ts"),
      ]);
      assert.ok(
        findings.length > 0,
        `${file} reaches the network outside the governor and the check reported nothing`,
      );
      assert.ok(
        findings.some((finding) => finding.rule === "fetch-call"),
        `${file} was reported, but not as a direct client call`,
      );
    });
  }

  it("rejects the name looked up as data, through Reflect or across two lines", () => {
    const findings = findDirectHttpCallSites([
      fixture("reflected-name-bypass.ts.fixture", "packages/adapters/src/reflected.ts"),
    ]);
    assert.ok(
      findings.some((finding) => finding.rule === "client-name-literal"),
      "the client's name spelled as a string was not reported, so a property " +
        "lookup that never writes the identifier walks past the check",
    );
    // Both shapes, on their own lines: the Reflect lookup and the split bracket.
    assert.deepEqual(
      findings
        .filter((finding) => finding.rule === "client-name-literal")
        .map((finding) => finding.line),
      [6, 9],
    );
  });

  it("does not mistake the word in prose, a title or a package name for one", () => {
    // The other half of the property. Over-reporting is not the safe direction
    // here: a check that fires on a test name is a check somebody deletes.
    const findings = findDirectHttpCallSites([
      fixture("prose-mentions.ts.fixture", "packages/adapters/src/prose.ts"),
    ]);
    assert.deepEqual(findings, [], describeFindings(findings));
  });

  it("blanks string contents for the code view but keeps interpolations, which run", () => {
    const masked = maskStringLiterals('const a = "one two"; const b = `x${y}z`;');
    assert.doesNotMatch(masked, /one two/);
    assert.match(masked, /\$\{y\}/);
    // Offsets survive, which is what keeps the two views line-for-line aligned.
    assert.equal(masked.length, 'const a = "one two"; const b = `x${y}z`;'.length);
  });

  it("rewrites a computed access with a literal key into the dotted access it is", () => {
    // The identifier is assembled at run time and the expectation is built from
    // the same fragments, so that no line of THIS file is a call site the
    // repository-wide scan would have to be taught to ignore.
    const identifier = "fet" + "ch";
    const source = `globalThis[${JSON.stringify(identifier)}](url)`;

    const rewritten = normaliseComputedAccess(source);

    assert.match(rewritten, new RegExp("globalThis\\." + identifier));
    // Same length, so the code view stays aligned with the readable one.
    assert.equal(rewritten.length, source.length);
  });
});

/**
 * The second finding: the package used to export the factory that builds a
 * live client. One import of the governor's own public API and a caller had a
 * real, ungoverned request, with the check reporting nothing about it.
 */
describe("the check rejects a call site that reaches this package's own transport", () => {
  it("rejects the factory reached by the name it used to be exported under", () => {
    const findings = findDirectHttpCallSites([
      fixture("transport-factory-bypass.ts.fixture", "packages/adapters/src/retailer.ts"),
    ]);
    assert.ok(
      findings.some((finding) => finding.rule === "ungoverned-transport"),
      "an adapter that names the ungoverned transport factory was not reported",
    );
  });

  it("rejects a deep import that reaches past the package entry point", () => {
    const findings = findDirectHttpCallSites([
      fixture("transport-deep-import-bypass.ts.fixture", "packages/adapters/src/deep.ts"),
    ]);
    const rules = new Set(findings.map((finding) => finding.rule));
    assert.ok(rules.has("transport-import"), "the import of the transport module was missed");
    assert.ok(rules.has("ungoverned-transport"), "the factory call itself was missed");
  });

  it("accepts an adapter that asks for the live transport the supported way", () => {
    const findings = findDirectHttpCallSites([
      fixture("governed-live-adapter.ts.fixture", "packages/adapters/src/live.ts"),
    ]);
    assert.deepEqual(findings, [], describeFindings(findings));
  });
});

/**
 * The third kind of site: a mechanism that puts a request on the wire without
 * naming a client either group knows. The first rule is complete over the
 * global client's identifier; these are not other SPELLINGS of that client,
 * they are other ways out, and each one is an enumeration entry that had to be
 * thought of. `no-direct-http.ts` says so in its own header rather than
 * claiming a completeness a text scan cannot have.
 */
describe("the check reports mechanisms that reach the wire without naming a client", () => {
  it("rejects a module specifier handed to the result of a call", () => {
    const findings = findDirectHttpCallSites([
      fixture("require-alias-bypass.ts.fixture", "packages/adapters/src/required.ts"),
    ]);
    const rules = new Set(findings.map((finding) => finding.rule));
    assert.ok(
      rules.has("client-import"),
      "createRequire(import.meta.url)(...) reaches an enumerated module through " +
        "a head the import rules did not spell",
    );
    assert.ok(
      rules.has("client-module-literal"),
      "the specifier parked in a variable first was not reported",
    );
  });

  it("rejects a raw socket carrying a request line", () => {
    const findings = findDirectHttpCallSites([
      fixture("raw-socket-bypass.ts.fixture", "packages/adapters/src/socket.ts"),
    ]);
    assert.ok(
      findings.some((finding) => finding.rule === "client-import"),
      "node:net and node:tls reach the wire and were not reported",
    );
    // Both sockets, on their own lines.
    assert.equal(
      new Set(
        findings
          .filter((finding) => finding.rule === "client-import")
          .map((finding) => finding.line),
      ).size,
      2,
    );
  });

  it("rejects a global that opens its own connection", () => {
    const findings = findDirectHttpCallSites([
      fixture("socket-global-bypass.ts.fixture", "packages/adapters/src/streamed.ts"),
    ]);
    assert.deepEqual(
      findings
        .filter((finding) => finding.rule === "client-global-constructor")
        .map((finding) => finding.line),
      [6, 9],
    );
  });

  it("rejects a subprocess that fetches, and does not report the spawn itself", () => {
    const findings = findDirectHttpCallSites([
      fixture(
        "fetching-subprocess-bypass.ts.fixture",
        "packages/adapters/src/shelled.ts",
      ),
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ["fetching-subprocess"],
      "the program is the finding; node:child_process is not a rule, because " +
        "this repository runs docker and pg_restore for reasons that are not " +
        "fetching " + describeFindings(findings),
    );
  });
});

describe("the package's public surface hands out nothing that can send", () => {
  it("exports no factory for an ungoverned transport", () => {
    // Present-day absence is not the property; the check above is. This is the
    // other half: the name a caller would reach for is simply not there.
    assert.equal(
      Object.keys(governor).some((name) => /Transport$/.test(name) && /^create/.test(name)),
      false,
      `the governor package exports ${Object.keys(governor).join(", ")}`,
    );
  });

  it("exports no value carrying a send method", () => {
    for (const [name, value] of Object.entries(governor)) {
      if (typeof value !== "object" || value === null) continue;
      assert.equal(
        typeof (value as { send?: unknown }).send,
        "undefined",
        `${name} is exported and can send; only Governor.request may`,
      );
    }
  });

  it("gives LIVE_TRANSPORT no send of its own", () => {
    assert.equal(typeof governor.LIVE_TRANSPORT, "symbol");
    assert.equal(
      (governor.LIVE_TRANSPORT as unknown as { send?: unknown }).send,
      undefined,
    );
  });
});

/**
 * Acceptance criterion 5 of spec S0033-deal-sentinel-source-3:
 *
 *   WHEN the adapter fetches anything from the vendor THE SYSTEM SHALL obtain
 *   it through the existing governor chokepoint, and THE SYSTEM SHALL offer no
 *   path from adapter code to an HTTP client that bypasses it.
 *
 * The tree-wide scan below already proves the second half for every file that
 * exists. This block is about the FIRST package that has a reason to want a
 * client, and it asserts three things the tree-wide pass alone would not:
 *
 *   - the adapter package is not, and cannot quietly become, allowlisted;
 *   - a bypass parked inside it IS reported, so the pass over the real file
 *     means something;
 *   - the package hands out nothing that can send, and its adapter reaches the
 *     network only by asking a Governor for it.
 */
describe("criterion 5: the adapter package has no way around the chokepoint", () => {
  it("is not on the allowlist, at any path under it", () => {
    for (const entry of HTTP_CLIENT_ALLOWLIST) {
      assert.equal(
        entry.path.startsWith("packages/sources/"),
        false,
        `${entry.path} is allowlisted, so the adapter package may name a client`,
      );
    }
  });

  it("reports a bypass parked inside the adapter itself", () => {
    const findings = findDirectHttpCallSites([
      fixture("bypassing-adapter.ts.fixture", "packages/sources/src/bestbuy/adapter.ts"),
    ]);
    assert.ok(
      findings.some((finding) => finding.rule === "fetch-call"),
      "a client call in the adapter's own path was not reported, so the pass " +
        "over the real adapter proves nothing",
    );
  });

  it("reports one reaching this package's own ungoverned transport from there", () => {
    const findings = findDirectHttpCallSites([
      fixture("transport-factory-bypass.ts.fixture", "packages/sources/src/wiring.ts"),
    ]);
    assert.ok(findings.some((finding) => finding.rule === "ungoverned-transport"));
  });

  it("finds nothing in the adapter package as it stands", () => {
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("packages/sources/"),
    );
    assert.ok(files.length >= 8, `only ${files.length} adapter files were scanned`);
    assert.deepEqual(
      findDirectHttpCallSites(files),
      [],
      describeFindings(findDirectHttpCallSites(files)),
    );
  });

  it("exports no value carrying a send method, and no transport factory", () => {
    assert.equal(
      Object.keys(sources).some((name) => /Transport$/.test(name)),
      false,
      `the sources package exports ${Object.keys(sources).join(", ")}`,
    );
    for (const [name, value] of Object.entries(sources)) {
      if (typeof value !== "object" || value === null) continue;
      assert.equal(
        typeof (value as { send?: unknown }).send,
        "undefined",
        `${name} is exported and can send; only Governor.request may`,
      );
    }
  });

  it("gives its adapter no way to reach the network but a Governor", async () => {
    // The dependency list IS the property: a governor, a registry entry and a
    // credential. There is no transport argument and no default to fall back
    // to, so an adapter built with a stubbed governor reaches exactly what
    // that governor reaches, which here is a recording stub and nothing else.
    const harness = sourceHarness({
      answers: { "8880044": fixtureAnswer("product-on-sale.json") },
    });
    const adapter = sources.bestBuyAdapter({
      governor: harness.governor,
      entry: harness.registry.require("bestbuy-api"),
      credential: "unused-in-this-assertion",
    });

    assert.equal(typeof adapter.observe, "function");
    assert.equal((adapter as { send?: unknown }).send, undefined);

    const outcome = await adapter.observe("8880044");
    assert.equal(outcome.kind, "observed");
    // Everything it received came back through the governor's own transport,
    // which is the stub. Nothing reached a real client.
    assert.ok(
      harness.transport.sent.every((request) =>
        request.url.startsWith("https://api.bestbuy.com/"),
      ),
      "a request left for somewhere the adapter was never pointed at",
    );
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
      // The adapter package. It is the first thing in this repository that
      // makes a real outbound request possible, so a scan that did not read it
      // would be proving the property about the code that cannot send.
      "packages/sources/src/bestbuy/adapter.ts",
      "packages/sources/src/run.ts",
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

  it("keeps the allowlist to the transport, the chokepoint and the loopback stub server", () => {
    assert.deepEqual(
      HTTP_CLIENT_ALLOWLIST.map((entry) => entry.path),
      [
        "packages/governor/src/transport.ts",
        "packages/governor/src/governor.ts",
        "test/support/loopback-server.ts",
      ],
    );
    for (const entry of HTTP_CLIENT_ALLOWLIST) {
      assert.ok(entry.why.length > 0, `${entry.path} is allowlisted without a reason`);
      assert.ok(entry.rules.length > 0, `${entry.path} is allowlisted for no rule`);
    }
  });

  it("lets exactly one file name an HTTP client and send with it", () => {
    // The count that matters. `governor.ts` is on the list for the two rules
    // about this package's OWN transport - it redeems the marker - and for no
    // client rule; `loopback-server.ts` may import `node:http` because it
    // serves and never sends. One file, and one only, may reach a client.
    const senders = HTTP_CLIENT_ALLOWLIST.filter(
      (entry) =>
        entry.rules.includes("fetch-call") || entry.rules.includes("client-request-call"),
    );
    assert.deepEqual(
      senders.map((entry) => entry.path),
      ["packages/governor/src/transport.ts"],
      "a second file may reach an HTTP client, so the governor is not a chokepoint",
    );
  });
});
