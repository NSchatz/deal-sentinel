/**
 * regress_0023_F1 - impl-gate ordinal 1, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F1: the AC2 check does not detect a call site that reaches the global
 * fetch through `global`, through a bracket property, or through a one-line
 * alias of the global object. All of those are ordinary JavaScript, all of them
 * issue an outbound HTTP request outside the governor, and all of them pass the
 * check that `pnpm run test` runs.
 *
 * Acceptance criterion 2 (spec.md):
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced anywhere in the tree THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`. Graded, per the phase's Verification, by
 *   proving UNREACHABILITY and not merely present-day absence.
 *
 * Spine assertion 1 of the same spec: the system "SHALL offer no path that
 * bypasses it".
 *
 * Root cause, in `packages/governor/src/no-direct-http.ts`, the `fetch-call`
 * rule (quoted with the identifier split so this file does not itself trip the
 * repository scan):
 *
 *   pattern: / (?<![.\w$]) fet+ch \s* \( | (?:globalThis|window|self) \s* \. \s* fet+ch \b /
 *
 * The first alternative requires the identifier to be immediately followed by
 * `(` and NOT preceded by a `.`, so every property access is excluded from it
 * by construction. The second alternative is therefore the only thing that can
 * catch a property access, and it enumerates exactly three global names:
 * `globalThis`, `window` and `self`.
 *
 * `global` is missing from that list. It is not an exotic spelling: it is
 * Node's own long-standing alias for `globalThis`, it is defined in every Node
 * process this repository runs in, and it is three characters shorter than the
 * `globalThis` spelling the check does catch. The same hole swallows a bracket
 * property, because a bracket is not a dot, and a local alias of the global
 * object, because the alias is a local name.
 *
 * Why this is the finding and not a nitpick: AC2 is graded on UNREACHABILITY,
 * and the phase exists to protect the household's residential IP. The existing
 * `test/unit/no-direct-http.test.ts` proves the check rejects the three shapes
 * its own fixtures use and proves the tree is clean today. It does not prove
 * the check rejects the shapes below, and it does not reject them: an adapter
 * can step around the ceiling, the randomised delay, the robots decision, the
 * back-pressure hold, the breaker and the allowance without ever meaning to,
 * and the suite stays green.
 *
 * Expected: every case in the first suite is DETECTED.
 * Actual at commit 6577121: all four are MISSED. This file FAILS.
 *
 * Every sample below is assembled at run time from fragments, so that no line
 * in this file is itself a call site the repository-wide scan would report.
 * That is the same reason the implementation's own test keeps its samples in
 * `test/fixtures/no-direct-http/*.fixture`.
 *
 * Run: node --test tests/regress_0023_F1.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDirectHttpCallSites } from "@deal-sentinel/governor";

/** The identifier, never spelled literally on one line of this file. */
const CALL = "fet" + "ch";

/** One call site, as a file the repository scan would have handed the check. */
function scan(text: string) {
  return findDirectHttpCallSites([
    { path: "packages/adapters/src/retailer.ts", text },
  ]);
}

describe("F1: the global fetch reached through a name the rule does not enumerate", () => {
  it("detects it through `global`, which is Node's own alias for globalThis", () => {
    const findings = scan(
      [
        "export async function priceOf(url: string): Promise<string> {",
        `  const response = await global.${CALL}(url);`,
        "  return await response.text();",
        "}",
      ].join("\n"),
    );

    assert.ok(
      findings.length > 0,
      "a call through `global` reaches the network with no ceiling, no " +
        "randomised delay, no robots decision, no back-pressure, no breaker " +
        "and no allowance, and the AC2 check reported nothing",
    );
  });

  it("detects it as a bracket property on globalThis", () => {
    const findings = scan(`const response = await globalThis[${JSON.stringify(CALL)}](url);`);

    assert.ok(
      findings.length > 0,
      "a bracket property is the same call as the dotted one the check " +
        "catches, and the AC2 check reported nothing",
    );
  });

  it("detects it through a one-line alias of the global object", () => {
    const findings = scan(
      ["const g = globalThis;", `const response = await g.${CALL}(url);`].join("\n"),
    );

    assert.ok(
      findings.length > 0,
      "aliasing the global object to a local name defeats the enumeration " +
        "entirely, and the AC2 check reported nothing",
    );
  });

  it("detects a renamed destructure of it", () => {
    const findings = scan(
      [`const { ${CALL}: send } = global;`, "const response = await send(url);"].join("\n"),
    );

    assert.ok(
      findings.length > 0,
      "destructuring it under another name leaves no bare call for the first " +
        "alternative and no dotted global for the second, and the AC2 check " +
        "reported nothing",
    );
  });
});

describe("F1 control: the check is alive and the import is real", () => {
  // Not part of the finding. These prove a failure above is a hole in the
  // enumeration rather than a broken import or an inert scan.
  it("still detects the spellings the check was built against", () => {
    assert.ok(scan(`const response = await ${CALL}(url);`).length > 0);
    assert.ok(scan(`const response = await globalThis.${CALL}(url);`).length > 0);
    assert.ok(scan(`import { request } from "node:` + `https";`).length > 0);
  });
});
