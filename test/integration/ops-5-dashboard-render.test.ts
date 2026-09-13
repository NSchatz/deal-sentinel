/**
 * The render grader, and the criteria it grades.
 *
 * Acceptance criteria AC-12 through AC-24 and AC-28 of spec
 * S0066-deal-sentinel-ops-5. Every claim here about what the dashboard SHOWS is
 * measured in a real browser engine over a document this suite just wrote, on a
 * `file:` URL, with nothing listening anywhere.
 *
 * THE GRADER IS PROVED RED FIRST. Each check is run against a document built to
 * break it, and asserted to throw, before the real page is believed. A check
 * that cannot fail is not evidence, and a source-text grader cannot be made
 * into one for a rendered claim: a stylesheet says what was asked for, never
 * what won.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BrowserEngineUnavailableError,
  DESKTOP_WIDTH,
  PHONE_WIDTH,
  assertContrastFloors,
  assertHigherAmountsDrawnAbove,
  assertMarksInTimeOrder,
  assertMeasuredSomething,
  assertNoForeignRequests,
  assertNoPolicyViolations,
  assertNoSidewaysScroll,
  browserExecutable,
  readKeyboardFocus,
  readRenderedPage,
  startEngine,
} from "../support/ops-5-render.ts";

/** A document that satisfies every check, for the other side of each proof. */
const SOUND_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>sound</title>
<style>
  html { color-scheme: light dark; }
  body { margin: 0; background: #ffffff; color: #16181d; font: 16px system-ui, sans-serif; }
  .chart { position: relative; height: 120px; width: 200px; }
  .mark { position: absolute; width: 6px; height: 6px; background: #16181d; border-radius: 50%; }
</style>
</head><body>
<h1>sound</h1>
<p>a paragraph with enough text to measure</p>
<p>a second one, so the reading is not one pair</p>
<p>a third, and a fourth below</p>
<p>the fourth</p>
<div class="chart">
  <span class="mark" data-mark data-at="10" data-amount="1000" style="left: 10px; top: 100px"></span>
  <span class="mark" data-mark data-at="20" data-amount="3000" style="left: 90px; top: 20px"></span>
</div>
</body></html>`;

/** The same document with the vertical axis inverted: cheaper drawn higher. */
const INVERTED_PAGE = SOUND_PAGE.replace(
  'data-at="10" data-amount="1000" style="left: 10px; top: 100px"',
  'data-at="10" data-amount="1000" style="left: 10px; top: 20px"',
).replace(
  'data-at="20" data-amount="3000" style="left: 90px; top: 20px"',
  'data-at="20" data-amount="3000" style="left: 90px; top: 100px"',
);

/** The same document with the time axis reversed: the later mark drawn left. */
const REVERSED_PAGE = SOUND_PAGE.replace(
  'data-at="20" data-amount="3000" style="left: 90px; top: 20px"',
  'data-at="20" data-amount="3000" style="left: 2px; top: 20px"',
);

/** Text on a background it cannot be read against. */
const LOW_CONTRAST_PAGE = SOUND_PAGE.replace("color: #16181d", "color: #b9bcc4");

/** A table wider than a phone, laid out so the BODY carries the overflow. */
const OVERFLOWING_PAGE = SOUND_PAGE.replace(
  "<h1>sound</h1>",
  '<h1>sound</h1><div style="width: 900px; background: #ffffff; color: #16181d">a very wide block</div>',
);

/** A page that asks another origin for a stylesheet, which CSP then refuses. */
const FOREIGN_RESOURCE_PAGE = SOUND_PAGE.replace(
  "<title>sound</title>",
  '<title>sound</title><link rel="stylesheet" href="https://example.invalid/theme.css">',
);

describe("AC-28: the engine is located explicitly, and its absence fails the run", () => {
  it("names the executable it looked for when there is nothing to start", async () => {
    await assert.rejects(
      () => startEngine("/nowhere/at/all/chromium"),
      (error: unknown) => {
        assert.ok(error instanceof BrowserEngineUnavailableError);
        assert.equal(error.executable, "/nowhere/at/all/chromium");
        assert.match(error.message, /\/nowhere\/at\/all\/chromium/);
        assert.match(error.message, /FAILS rather than skipping/);
        return true;
      },
    );
  });

  it("takes the engine from the environment, or from the committed default", () => {
    assert.equal(
      browserExecutable({ DEAL_SENTINEL_BROWSER: "/opt/engines/chrome" }),
      "/opt/engines/chrome",
    );
    assert.equal(browserExecutable({}), "/usr/bin/chromium");
    // An empty value is not a second candidate to search past: it is the
    // committed default, and there is no third place to look.
    assert.equal(browserExecutable({ DEAL_SENTINEL_BROWSER: "   " }), "/usr/bin/chromium");
  });

  it("starts the engine this run is graded by, and says which build it was", async () => {
    const reading = await readRenderedPage(SOUND_PAGE);
    assert.match(reading.engine, /Chrom/, `the engine reported itself as ${reading.engine}`);
    console.log(`ops-5 render grader drove ${reading.engine} at ${browserExecutable()}`);
  });

  it("is given an engine by the CI job explicitly, pinned and checked", async () => {
    // The runner image ships a browser. Leaning on it would make the
    // instrument every rendered claim is measured with a thing that moves
    // under this repository with no diff, so the job takes an exact build and
    // refuses one whose digest does not match.
    const workflow = await readFile(
      new URL("../../.github/workflows/test.yml", import.meta.url),
      "utf8",
    );
    assert.match(workflow, /DEAL_SENTINEL_BROWSER=/, "the job points nothing at an engine");
    assert.match(workflow, /chrome-for-testing-public/);
    assert.match(
      workflow,
      /version=\d+\.\d+\.\d+\.\d+\b/,
      "the engine is taken at a moving channel rather than an exact build",
    );
    assert.match(workflow, /sha256sum --check --strict/);
    assert.match(workflow, /digest=[0-9a-f]{64}/);
    for (const [, reference] of workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert.match(
        reference,
        /@[0-9a-f]{40}$/,
        `${reference} is not pinned to a commit SHA (pinning-conventions P3)`,
      );
    }
  });

  it("declares no skip anywhere in this file, so a missing engine cannot pass", async () => {
    const own = await readFile(new URL(import.meta.url), "utf8");
    assert.doesNotMatch(
      own,
      /\{\s*skip\s*[:,}]|skip:\s*(true|dockerUsable)/,
      "this suite acquired a skip; a green that skipped the render grader " +
        "proves nothing about what the page shows",
    );
  });
});

describe("the grader goes red against a page built to break each check", () => {
  it("rejects a chart whose higher amount is drawn below a lower one", async () => {
    const sound = await readRenderedPage(SOUND_PAGE);
    assert.equal(sound.marks.length, 2);
    assertHigherAmountsDrawnAbove(sound.marks);

    const inverted = await readRenderedPage(INVERTED_PAGE);
    assert.throws(
      () => assertHigherAmountsDrawnAbove(inverted.marks),
      /not above/,
      "the vertical axis was inverted and the check passed anyway",
    );
  });

  it("rejects a chart whose later observation is drawn to the left", async () => {
    const reversed = await readRenderedPage(REVERSED_PAGE);
    assert.throws(() => assertMarksInTimeOrder(reversed.marks), /not right of the earlier/);
  });

  it("rejects text that cannot be read against what is behind it", async () => {
    const sound = await readRenderedPage(SOUND_PAGE);
    assertMeasuredSomething(sound);
    assertContrastFloors(sound);

    const poor = await readRenderedPage(LOW_CONTRAST_PAGE);
    assert.throws(() => assertContrastFloors(poor), /below their contrast floor/);
  });

  it("rejects a page that scrolls sideways at a phone width", async () => {
    const sound = await readRenderedPage(SOUND_PAGE, { width: PHONE_WIDTH });
    assertNoSidewaysScroll(sound);

    const wide = await readRenderedPage(OVERFLOWING_PAGE, { width: PHONE_WIDTH });
    assert.throws(() => assertNoSidewaysScroll(wide), /viewport/);
  });

  it("rejects a page that asks another origin for anything", async () => {
    const sound = await readRenderedPage(SOUND_PAGE);
    assertNoForeignRequests(sound);
    assertNoPolicyViolations(sound);

    const foreign = await readRenderedPage(FOREIGN_RESOURCE_PAGE);
    assert.throws(
      () => {
        assertNoForeignRequests(foreign);
        assertNoPolicyViolations(foreign);
      },
      /off its own origin|content security policy/,
      "a page reaching another origin was accepted by both checks",
    );
  });

  it("reads the accessibility tree, not the markup", async () => {
    const reading = await readRenderedPage(SOUND_PAGE);
    assert.ok(
      reading.accessibleText.includes("sound"),
      `the tree carried ${JSON.stringify(reading.accessibleText)}`,
    );
  });

  it("drives the page by keyboard rather than asking the markup about focus", async () => {
    const focus = await readKeyboardFocus(
      SOUND_PAGE.replace("<h1>sound</h1>", '<h1>sound</h1><a href="#chart">to the chart</a>'),
    );
    assert.equal(focus.length, 1, `the tab walk reached ${JSON.stringify(focus)}`);
    assert.match(focus[0].label, /^a /);
  });
});

describe("the grader writes its own evidence", () => {
  it("captures a screenshot of a document in a theme at a width", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ops-5-shot-proof-"));
    try {
      const { captureScreenshot } = await import("../support/ops-5-render.ts");
      const target = path.join(directory, "dashboard.dark.360.png");
      await captureScreenshot(SOUND_PAGE, target, { theme: "dark", width: PHONE_WIDTH });
      const written = await stat(target);
      assert.ok(written.size > 1000, `the screenshot was ${written.size} bytes`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the same document differently under each system preference", async () => {
    const light = await readRenderedPage(SOUND_PAGE, { theme: "light", width: DESKTOP_WIDTH });
    const dark = await readRenderedPage(SOUND_PAGE, { theme: "dark", width: DESKTOP_WIDTH });
    assert.equal(light.theme, "light");
    assert.equal(dark.theme, "dark");
    assert.ok(light.contrast.length > 0 && dark.contrast.length > 0);
  });
});
