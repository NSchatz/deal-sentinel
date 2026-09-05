/**
 * regress_0023_F11 - impl-gate ordinal 4, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F11 (advisory): the bypass detector's CODE VIEW blanks the remainder
 * of any line from the first unpaired quote character onwards, so the plainest
 * possible client call - a bare call on the global client, no alias, no
 * computation, no obfuscation - is not reported when it shares a line with a
 * regular expression literal holding one quote character.
 *
 * Acceptance criterion 2 (spec.md):
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced anywhere in the tree THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`.
 *
 * Spine assertion 1 of the same spec: the system "SHALL offer no path that
 * bypasses it".
 *
 * Root cause, `packages/governor/src/no-direct-http.ts`. `maskStringLiterals`
 * decides a plain string has begun at every `"` or `'` it meets in code
 * position and blanks everything after it to the end of the line. A regular
 * expression literal is not parsed as one, so `/[']/` opens a string that never
 * closes, and the identifier rules - which read the masked view - see an empty
 * line where the call is.
 *
 * The module's header records the masking limitation ("Regular expression
 * literals are not parsed as such ... a line this misreads is one line, never
 * the rest of the file") but not its consequence, and the property the same
 * header does claim is stronger than what survives here: "no ORDINARY spelling
 * of a client survives review - not a call, not a property of any object, not
 * an alias, not a destructure, not an import, not a string". The sample below
 * is the first item on that list.
 *
 * Filed ADVISORY rather than blocking: the class is narrow (it needs the call
 * and an unpaired quote on the SAME line), the direction of the miss is a
 * bypass nobody writes by accident, and impl gates 1 and 2 closed the classes
 * that were reachable without contrivance. It is recorded because AC2 is one of
 * the two mitigations the spec's Objective promotes from advice to criteria,
 * and because the fix is small: mask the two identifier rules against a view
 * that gives up on a line rather than blanking it, or resynchronise on the
 * first unmatched quote instead of consuming to end of line.
 *
 * This file documents the behaviour. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDirectHttpCallSites, maskStringLiterals } from "@deal-sentinel/governor";

/**
 * Assembled at run time from fragments, exactly as
 * `test/unit/no-direct-http.test.ts` does, so that no line of THIS file is a
 * call site the repository-wide scan would have to be taught to ignore.
 */
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
