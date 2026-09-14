/**
 * Acceptance criterion AC-25 of spec S0066-deal-sentinel-ops-5:
 *
 *   WHEN the stylesheet sources are checked THE SYSTEM SHALL source every
 *   colour and every spacing length from one committed token file, which SHALL
 *   define the role names the styling conventions fix, SHALL carry a
 *   hand-authored value per theme for each, SHALL record the measured contrast
 *   ratio beside each pair that must clear a floor, and SHALL use only the 4px
 *   spacing scale.
 *
 * The one SOURCE-level check in this spec's work, and legitimately so: what a
 * file declares is a property of its text. What those declarations PRODUCE is
 * measured in a browser engine by `ops-5-dashboard-render.test.ts`, which is
 * where the contrast a reader actually gets, and the width the body actually
 * takes, are graded.
 *
 * Every rule is shown RED against a mutation of the committed file before the
 * pass over the tree is believed, and the rule table and the demonstrations are
 * asserted to cover each other, so a rule that stops firing cannot hide.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_CONTRAST_PAIRS,
  REQUIRED_SEMANTIC_TOKENS,
  SPACING_SCALE,
  TOKEN_RULES,
  collectStylesheets,
  contrastRatio,
  describeTokenFindings,
  findTokenFindings,
  readTokenFile,
  resolve,
  tokenFilesIn,
} from "../support/ops-5-tokens.ts";
import type { TokenRule } from "../support/ops-5-tokens.ts";
import type { ScannedFile } from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STYLESHEETS = collectStylesheets(REPO_ROOT);
const TOKEN_FILE = tokenFilesIn(STYLESHEETS)[0];

const wentRed = new Set<TokenRule>();

function redOn(rule: TokenRule, findings: readonly { rule: TokenRule }[]): void {
  assert.ok(
    findings.some((found) => found.rule === rule),
    `nothing reported ${rule}: ${describeTokenFindings(findings as never)}`,
  );
  wentRed.add(rule);
}

/** The committed set with one file's text rewritten. */
function mutated(path: string, rewrite: (text: string) => string): ScannedFile[] {
  return STYLESHEETS.map((file) =>
    file.path === path ? { ...file, text: rewrite(file.text) } : file,
  );
}

describe("the committed stylesheets", () => {
  it("are found by scanning, and there is exactly one token file", () => {
    assert.ok(STYLESHEETS.length >= 2, `only ${STYLESHEETS.length} stylesheet(s) were read`);
    assert.equal(tokenFilesIn(STYLESHEETS).length, 1);
    assert.match(TOKEN_FILE.path, /tokens\.css$/);
  });

  it("carry no finding at all as they stand", () => {
    const findings = findTokenFindings(STYLESHEETS);
    assert.deepEqual(findings, [], describeTokenFindings(findings));
  });

  it("declare all three tiers and the whole role vocabulary", () => {
    const tokens = readTokenFile(TOKEN_FILE);
    for (const name of REQUIRED_SEMANTIC_TOKENS) {
      assert.ok(tokens.values.light[name] !== undefined, `${name} is not declared`);
      assert.ok(tokens.values.dark[name] !== undefined, `${name} has no dark value`);
    }
    assert.ok(
      Object.keys(tokens.values.light).some((name) => name.startsWith("--ds-")),
      "there is no primitive tier",
    );
    assert.ok(
      Object.keys(tokens.values.light).some((name) => name.startsWith("--card-")),
      "there is no component tier",
    );
  });

  it("keep every spacing token on the 4px scale", () => {
    const tokens = readTokenFile(TOKEN_FILE);
    const spacing = Object.entries(tokens.values.light).filter(([name]) =>
      name.startsWith("--space-"),
    );
    assert.ok(spacing.length >= 5, `only ${spacing.length} spacing token(s)`);
    for (const [name, value] of spacing) {
      const length = /^(\d+)px$/.exec(value);
      assert.ok(length !== null, `${name} is ${value}, which is not a pixel length`);
      assert.ok(
        SPACING_SCALE.includes(Number(length[1])),
        `${name} is ${value}, off the 4px scale`,
      );
    }
  });

  it("record a measured ratio for every floored pair, in both themes", () => {
    const tokens = readTokenFile(TOKEN_FILE);
    for (const theme of ["light", "dark"] as const) {
      for (const [foreground, background, floor] of REQUIRED_CONTRAST_PAIRS) {
        const held = tokens.recorded.find(
          (entry) =>
            entry.theme === theme &&
            entry.foreground === foreground &&
            entry.background === background,
        );
        assert.ok(held !== undefined, `${theme}: ${foreground} on ${background} is unrecorded`);
        const measured = contrastRatio(
          resolve(foreground, tokens, theme) ?? "",
          resolve(background, tokens, theme) ?? "",
        );
        assert.ok(measured !== null);
        assert.equal(
          measured.toFixed(2),
          held.recorded.toFixed(2),
          `${theme}: ${foreground} on ${background} records ${held.recorded}`,
        );
        assert.ok(measured >= floor, `${theme}: ${foreground} on ${background} is under its floor`);
        assert.equal(held.floor, floor);
      }
    }
  });
});

describe("every rule goes red against a mutation of the committed files", () => {
  const page = STYLESHEETS.find((file) => file.path !== TOKEN_FILE.path);

  it("rejects a second file declaring the role vocabulary", () => {
    const findings = findTokenFindings([
      ...STYLESHEETS,
      { path: "packages/ops/src/other-tokens.css", text: TOKEN_FILE.text },
    ]);
    redOn("one-token-file", findings);
  });

  it("rejects a colour declared outside the token file", () => {
    assert.ok(page !== undefined);
    const findings = findTokenFindings(
      mutated(page.path, (text) => text.replace("color: var(--fg);", "color: #123456;")),
    );
    redOn("colour-outside-tokens", findings);
  });

  it("rejects a length declared outside the token file", () => {
    assert.ok(page !== undefined);
    const findings = findTokenFindings(
      mutated(page.path, (text) =>
        text.replace("padding: var(--space-4);", "padding: 17px;"),
      ),
    );
    redOn("length-outside-tokens", findings);
  });

  it("rejects motion declared anywhere", () => {
    assert.ok(page !== undefined);
    const findings = findTokenFindings(
      mutated(page.path, (text) =>
        text.replace("body {", "body {\n  transition: background 200ms;"),
      ),
    );
    redOn("motion-declared", findings);
  });

  it("rejects a token file with no component tier", () => {
    // The whole tier, cut where it begins: a surface with only primitives and
    // semantics has nothing that names a part of the page.
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) => {
        const tier = text.indexOf("Tier 3: component");
        const close = text.indexOf("\n}", tier);
        return text.slice(0, tier) + text.slice(close);
      }),
    );
    redOn("missing-tier", findings);
  });

  it("rejects a token file missing one of the role names", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) => text.replace(/^\s*--disabled:.*$/gm, "")),
    );
    redOn("missing-semantic", findings);
  });

  it("rejects a theme that inherits a value rather than being authored", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) => {
        const dark = text.indexOf("@media");
        return (
          text.slice(0, dark) +
          text.slice(dark).replace(/^\s*--muted:.*$/gm, "")
        );
      }),
    );
    redOn("missing-theme-value", findings);
  });

  it("rejects a spacing token off the 4px scale", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) => text.replace("--space-3: 12px;", "--space-3: 13px;")),
    );
    redOn("spacing-off-scale", findings);
  });

  it("rejects a floored pair with no recorded ratio", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) =>
        text.replace(/\/\* ratio: --mark on --panel[^*]*\*\//g, ""),
      ),
    );
    redOn("ratio-not-recorded", findings);
  });

  it("rejects a recorded ratio the values no longer produce", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) =>
        text.replace("ratio: --fg on --panel = 18.41:1", "ratio: --fg on --panel = 4.60:1"),
      ),
    );
    redOn("ratio-not-measured", findings);
  });

  it("rejects a pair that drops below its floor, however it is recorded", () => {
    const findings = findTokenFindings(
      mutated(TOKEN_FILE.path, (text) =>
        text
          // A muted grey nobody can read against white, recorded honestly.
          .replace("--ds-ink-500: #53596a;", "--ds-ink-500: #d0d3d8;")
          .replace("ratio: --muted on --panel = 6.99:1", "ratio: --muted on --panel = 1.53:1")
          .replace("ratio: --disabled on --panel = 6.99:1", "ratio: --disabled on --panel = 1.53:1"),
      ),
    );
    redOn("ratio-under-floor", findings);
  });
});

describe("the rule table and the demonstrations cover each other", () => {
  it("demonstrated every rule it can report, and invented none", () => {
    assert.deepEqual([...wentRed].sort(), [...TOKEN_RULES].sort());
  });
});
