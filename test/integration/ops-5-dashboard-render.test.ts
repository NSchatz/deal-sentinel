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
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { formatMinorUnits } from "@deal-sentinel/extractor";
import {
  DashboardOutputError,
  OUTPUT_UNWRITABLE_EXIT_CODE,
  renderDashboard,
  showInstant,
  unavailable,
  writeDashboard,
} from "@deal-sentinel/ops";

import { sampleDashboardModel } from "../support/ops-5-harness.ts";
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
import type { PageReading, Theme } from "../support/ops-5-render.ts";

/**
 * A control character, built from its code point rather than typed.
 *
 * A raw control byte in a source file is a byte nobody at a review gate can
 * see, and it makes a diff unreadable. The VALUE has to be real - the criterion
 * is about a stored value that carries one - so it is constructed here, named,
 * and paired with the escape the page is expected to show in its place.
 */
const UNRECOGNISED_CONTROL = String.fromCodePoint(1);
const CONTROL_AS_SHOWN = "\\u0001";

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

/* ================================================================== *
 * The page itself, measured in the engine
 * ================================================================== */

/** One reading of the real page, per theme and width, shared by the cases. */
const PAGE = renderDashboard(sampleDashboardModel());
const readings = new Map<string, PageReading>();

async function page(theme: Theme, width: number): Promise<PageReading> {
  const key = `${theme}-${width}`;
  const held = readings.get(key);
  if (held !== undefined) return held;
  const reading = await readRenderedPage(PAGE, { theme, width });
  readings.set(key, reading);
  return reading;
}

describe("AC-13, AC-14 and AC-15: the series, as drawn and as text", () => {
  it("draws one mark per observation, in time order, dearer above cheaper", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    const model = sampleDashboardModel();
    const series = model.listings[0];

    const marks = reading.marks.filter(
      (mark) => mark.data["data-listing"] === series.listingId,
    );
    assert.equal(marks.length, series.points.length);
    for (const mark of marks) {
      assert.ok(mark.width > 0 && mark.height > 0, "a mark was drawn with no area");
    }
    assertMarksInTimeOrder(marks);
    assertHigherAmountsDrawnAbove(marks);

    // The specific pair, said out loud: 149.99 is the dearest and sits above
    // the 99.99 that is the cheapest, whatever order they were observed in.
    const dearest = marks.find((mark) => mark.data["data-amount"] === "14999");
    const cheapest = marks.find((mark) => mark.data["data-amount"] === "9999");
    assert.ok(dearest !== undefined && cheapest !== undefined);
    assert.ok(dearest.y < cheapest.y, `${dearest.y} is not above ${cheapest.y}`);
  });

  it("puts every amount and instant in the accessibility tree as text", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    const model = sampleDashboardModel();

    for (const point of model.listings[0].points) {
      const amount = formatMinorUnits(point.amountMinorUnits, point.currency);
      const instant = showInstant(point.observedAt, model.timeZone);
      assert.ok(
        reading.accessibleText.includes(amount),
        `${amount} is not reachable in the accessibility tree`,
      );
      assert.ok(
        reading.accessibleText.includes(instant),
        `${instant} is not reachable in the accessibility tree`,
      );
    }
  });

  it("shows the exact stored minor units, with no rounding and no float", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    assert.match(reading.visibleText, /USD 129\.99/);
    assert.match(reading.visibleText, /USD 99\.99/);
    assert.match(reading.visibleText, /USD 149\.99/);
    // The failure this rules out: a float would round 12999 minor units to
    // 129.99000000000001 or to 130, and a naive divide would drop the zero.
    assert.doesNotMatch(reading.visibleText, /129\.9900/);
    assert.doesNotMatch(reading.visibleText, /USD 130\b/);
  });

  it("shows every instant with an explicit zone", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    const instants = reading.visibleText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[^\n]{0,6}/g);
    assert.ok(instants !== null && instants.length >= 6, "the page shows no instants");
    for (const instant of instants) {
      assert.match(
        instant,
        /\d{2}:\d{2}:\d{2} [A-Z]{2,5}/,
        `${instant} is shown with no time zone beside it`,
      );
    }
  });
});

describe("AC-16 and AC-17: every source, and how old the page is", () => {
  it("shows each source's state, pause, allowance and last-success age as text", async () => {
    const reading = await page("light", DESKTOP_WIDTH);

    for (const source of sampleDashboardModel().sources) {
      assert.ok(
        reading.visibleText.includes(source.sourceId),
        `${source.sourceId} is not on the page at all`,
      );
    }
    assert.match(reading.visibleText, /healthy/);
    assert.match(reading.visibleText, /paused/);
    assert.match(reading.visibleText, /broken/);
    // The paused source names the condition that paused it.
    assert.match(reading.visibleText, /the vendor answered 403/);
    // The metered sources show consumed and remaining, and the unmetered one
    // shows neither a zero nor an unlimited.
    assert.match(reading.visibleText, /7 used, 93 left of 100/);
    assert.match(reading.visibleText, /100 used, 0 left of 100/);
    assert.match(reading.visibleText, /not metered/);
    // How old the newest success is, in words.
    assert.match(reading.visibleText, /1 hour/);
    assert.match(reading.visibleText, /3 hours/);
  });

  it("shows a stale source as broken and stamps the page with its own instant", async () => {
    const model = sampleDashboardModel();
    const reading = await page("light", DESKTOP_WIDTH);
    const produced = showInstant(model.producedAt, model.timeZone);

    assert.ok(
      reading.visibleText.includes(produced),
      `the page does not show when it was produced (${produced})`,
    );
    assert.match(reading.visibleText, /Nothing on this page updates itself/);
    // The source with no successful request at all reads as broken, and its
    // last success reads as not recorded rather than as a zero or a dash.
    assert.match(reading.visibleText, /not recorded/);
    assert.doesNotMatch(reading.visibleText, /\bidle\b|\bquiet\b/);
  });
});

describe("AC-18 and AC-19: nothing to show, and a figure nobody could compute", () => {
  it("shows an explicit empty state for a listing with no observation, and draws none", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    assert.match(reading.visibleText, /No observation in the shown window/);
    assert.equal(
      reading.marks.filter((mark) => mark.data["data-listing"] === "8880045").length,
      0,
      "a series was drawn for a listing with no observations",
    );
  });

  it("says so when no listing is tracked at all, rather than drawing a frame", async () => {
    const empty = await readRenderedPage(
      renderDashboard(sampleDashboardModel({ listings: [] })),
    );
    assert.match(empty.visibleText, /No listing is tracked/);
    assert.equal(empty.marks.length, 0);
    // The rest of the page is still there: an empty watchlist is not an error.
    assert.match(empty.visibleText, /bestbuy-api/);
  });

  it("shows an unavailable figure as unavailable, and still draws everything else", async () => {
    const model = sampleDashboardModel();
    const why = "no staleness ceiling is configured for this source";
    const broken = sampleDashboardModel({
      sources: [
        {
          ...model.sources[0],
          allowance: unavailable(why),
        },
        ...model.sources.slice(1),
      ],
    });

    const reading = await readRenderedPage(renderDashboard(broken));
    assert.match(reading.visibleText, new RegExp(`unavailable: ${why}`));
    // Never a zero and never a dash in place of the figure.
    assert.doesNotMatch(reading.visibleText, /Allowance\n0\b/);
    assert.doesNotMatch(reading.visibleText, /Allowance\n-\n/);
    // Everything else still rendered: the other sources, and the chart.
    assert.match(reading.visibleText, /100 used, 0 left of 100/);
    assert.equal(reading.marks.length, model.listings[0].points.length);
  });
});

describe("AC-20: a stored value is shown, never executed and never dropped", () => {
  it("shows markup, control characters and an unknown token as literal text", async () => {
    const model = sampleDashboardModel();
    const hostile = sampleDashboardModel({
      listings: [
        {
          sourceId: "bestbuy-api",
          listingId: "<script>alert(1)</script>",
          points: [
            {
              amountMinorUnits: 1999n,
              currency: "USD",
              observedAt: new Date(model.producedAt.getTime() - 3_600_000),
              availability: `<b>MadeToOrder</b>${UNRECOGNISED_CONTROL}`,
            },
          ],
        },
      ],
    });

    const html = renderDashboard(hostile);
    const reading = await readRenderedPage(html);

    // No element was created from either value.
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(reading.consoleErrors.length, 0);
    // Both values are SHOWN, in full, as text.
    assert.ok(
      reading.visibleText.includes("<script>alert(1)</script>"),
      `the listing id was not shown literally: ${reading.visibleText.slice(0, 400)}`,
    );
    assert.ok(
      reading.visibleText.includes("<b>MadeToOrder</b>"),
      "the availability token was not shown literally",
    );
    // The control character is shown as the escape that names it rather than
    // dropped, so the page and the store do not quietly disagree.
    assert.ok(
      reading.visibleText.includes(CONTROL_AS_SHOWN),
      "a control character was dropped rather than shown as the escape that " +
        "names it, so the page and the store quietly disagree",
    );
    assert.ok(
      reading.visibleText.includes(`<b>MadeToOrder</b>${CONTROL_AS_SHOWN}`),
      "the value either side of the control character was not kept whole",
    );
    assert.equal(reading.marks.length, 1, "the hostile listing lost its observation");
  });
});

describe("AC-21, AC-22, AC-23 and AC-24: policy, phone, contrast, and not by colour", () => {
  it("sets a policy the engine reports no violation of, and asks no other origin", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    assert.match(PAGE, /Content-Security-Policy/);
    assert.match(PAGE, /default-src &#39;none&#39;/);
    assertNoPolicyViolations(reading);
    assertNoForeignRequests(reading);
    assert.deepEqual(
      reading.requests.filter((url) => !url.startsWith("file://")),
      [],
    );
    assert.deepEqual(reading.consoleErrors, []);
  });

  it("leaves the body free of sideways scrolling at 360px", async () => {
    const reading = await page("light", PHONE_WIDTH);
    assertNoSidewaysScroll(reading);
    assert.equal(reading.bodyScrollWidth, reading.clientWidth);
    // The wide thing is still there and still readable: it scrolls inside its
    // own container rather than being cut off.
    assert.match(reading.visibleText, /USD 129\.99/);
  });

  it("clears its contrast floors in both themes, measured from the document", async () => {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [PHONE_WIDTH, DESKTOP_WIDTH]) {
        const reading = await page(theme, width);
        assertMeasuredSomething(reading);
        assertContrastFloors(reading);
      }
    }
  });

  it("conveys every state in text as well as in colour", async () => {
    const reading = await page("light", DESKTOP_WIDTH);
    // Each state word is present as TEXT. A reader who sees no colour at all
    // still reads healthy, paused and broken.
    for (const word of ["healthy", "paused", "broken"]) {
      assert.ok(reading.visibleText.includes(word), `${word} is carried by colour alone`);
    }
    // And the indicator beside each one clears the non-text floor.
    const indicators = reading.contrast.filter((pair) => pair.floor === 3);
    assert.ok(indicators.length >= 3, "the state dots were not measured at all");
  });

  it("gives every keyboard-reachable element a visible focus indicator", async () => {
    const focus = await readKeyboardFocus(PAGE);
    assert.ok(focus.length >= 2, `the tab walk reached ${focus.length} element(s)`);
    for (const reading of focus) {
      assert.ok(
        reading.outlineWidth >= 2 && reading.outlineStyle !== "none",
        `${reading.label} showed no visible focus ring: ${JSON.stringify(reading)}`,
      );
    }
  });
});

describe("AC-12: an output location that cannot be written", () => {
  it("refuses an absent directory, names it, and leaves nothing behind", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ops-5-output-"));
    try {
      const target = path.join(directory, "not-here", "index.html");
      assert.throws(
        () => writeDashboard(PAGE, target),
        (error: unknown) => {
          assert.ok(error instanceof DashboardOutputError);
          assert.equal(error.exitCode, OUTPUT_UNWRITABLE_EXIT_CODE);
          assert.ok(error.message.includes(target), `the path is not in ${error.message}`);
          assert.match(error.message, /Nothing was created/);
          return true;
        },
      );
      assert.deepEqual(await readdir(directory), [], "a partial artifact was left behind");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a directory it cannot write to, and leaves nothing behind", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ops-5-readonly-"));
    const target = path.join(directory, "index.html");
    try {
      await chmod(directory, 0o500);
      let refused = false;
      try {
        writeDashboard(PAGE, target);
      } catch (error) {
        refused = error instanceof DashboardOutputError;
        assert.ok(refused, `an unexpected failure: ${String(error)}`);
        assert.ok((error as DashboardOutputError).message.includes(target));
      }
      // A grader running with the privilege to write anywhere is not shown a
      // permission denial; the case is then the one above, and this asserts
      // only that nothing partial was left either way.
      await chmod(directory, 0o700);
      const left = await readdir(directory);
      assert.deepEqual(
        left.filter((name) => name.includes("partial")),
        [],
        "a partial artifact was left behind",
      );
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the page atomically where it can", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ops-5-written-"));
    try {
      const target = path.join(directory, "index.html");
      const written = writeDashboard(PAGE, target);
      assert.equal(written, target);
      assert.equal(await readFile(target, "utf8"), PAGE);
      assert.deepEqual(await readdir(directory), ["index.html"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
