/**
 * regress_0023_F11 - impl-gate ordinal 4, spec S0023-deal-sentinel-governor-2.
 *
 * F11 (advisory): the bypass detector's CODE VIEW blanks the rest of any line
 * from the first unpaired quote character onwards, so the plainest possible
 * client call - bare, no alias, no obfuscation - is not reported when it shares
 * a line with a regular expression literal holding one quote character.
 *
 * Acceptance criterion 2: "WHEN a call site that issues an outbound HTTP
 * request outside the governor is introduced anywhere in the tree THE SYSTEM
 * SHALL fail a check that runs as part of `pnpm run test`", beside the spine
 * assertion that the system "SHALL offer no path that bypasses it".
 *
 * Root cause, `packages/governor/src/no-direct-http.ts`: `maskStringLiterals`
 * decides a plain string has begun at every `"` or `'` in code position and
 * blanks to the end of the line. A regular expression literal is not parsed as
 * one, so `/[']/` opens a string that never closes and the identifier rules see
 * an empty line where the call is. The module's header records the masking
 * limitation but not its consequence, while claiming that "no ORDINARY spelling
 * of a client survives review - not a call, not a property of any object, not
 * an alias, not a destructure, not an import, not a string".
 *
 * Advisory rather than blocking: it needs the call and an unpaired quote on the
 * SAME line, which is not a bypass anybody writes by accident. Recorded because
 * the fix is small - resynchronise on the first unmatched quote rather than
 * consuming to end of line. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDirectHttpCallSites, maskStringLiterals } from "@deal-sentinel/governor";

/** Assembled at run time, so no line here is a call site the scan must ignore. */
const CLIENT = "fet" + "ch";
const APOSTROPHE = String.fromCharCode(39);

function sample(body: string) {
  return {
    path: "packages/adapters/src/retailer.ts",
    text: `export async function listing(url: string) {\n${body}\n}\n`,
  };
}

describe("F11: an unpaired quote earlier on the line hides the call after it", () => {
  it("reports a bare client call that sits behind a regular expression literal", () => {
    // The control: the same call, alone on its line, is reported.
    const plain = findDirectHttpCallSites([sample(`  return await ${CLIENT}(url);`)]);
    assert.equal(
      plain.some((finding) => finding.rule === "fetch-call"),
      true,
      "the probe is not set up: the plain call was not reported either",
    );

    // The finding: one regular expression literal carrying one quote character,
    // and the identical call after it on the same line.
    const line =
      `  const odd = /[${APOSTROPHE}]/.test(url); ` +
      `return odd ? null : await ${CLIENT}(url);`;
    const hidden = findDirectHttpCallSites([sample(line)]);

    console.log("the line the check reads as code:", JSON.stringify(maskStringLiterals(line)));
    console.log("findings:", JSON.stringify(hidden));

    assert.equal(
      hidden.some((finding) => finding.rule === "fetch-call"),
      true,
      "a bare call on the global HTTP client went unreported because a " +
        "regular expression literal earlier on the line opened a string the " +
        "code view never closed",
    );
  });

  it("shows the mechanism directly: the rest of the line is blanked", () => {
    const line = `const odd = /[${APOSTROPHE}]/.test(url); await ${CLIENT}(url);`;
    const masked = maskStringLiterals(line);

    // The call is gone from the view the identifier rules read.
    assert.equal(
      masked.includes(CLIENT),
      true,
      `the code view of this line kept nothing after the quote: ${JSON.stringify(masked)}`,
    );
  });
});
