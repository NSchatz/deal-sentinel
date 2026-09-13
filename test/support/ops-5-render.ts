/**
 * The render grader: a real browser engine, driven over locally produced
 * content, answering questions about what a page SHOWS.
 *
 * WHY AN ENGINE AND NOT A PARSER. Every claim this spec makes about the
 * dashboard is a claim about the drawn result - where a mark sits, what the
 * cascade resolved a colour to, what the accessibility tree carries, whether
 * the body scrolls sideways at 360px. Source text cannot answer any of them: a
 * stylesheet says what was asked for, not what won, and an element's position
 * is the product of every rule that applied to it. So this module starts
 * Chromium, hands it a file, and reads the result back.
 *
 * WHY IT IS NOT A SOURCE PATH. CLAUDE.md working agreement 5 puts a headless
 * browser last in the order of source acquisition, and that ordering is about
 * FETCHING from third parties. This engine is pointed at a file this repository
 * just wrote, on a `file:` URL, and the suite asserts that the page requests
 * nothing from any other origin. It never contacts anybody.
 *
 * WHERE THE ENGINE COMES FROM, with no fallback anywhere in it (pinning P6).
 * One environment variable names the executable; with none set, the committed
 * default below is used. If that path cannot be started, the run FAILS and says
 * which path it looked at. It never searches, never tries a second candidate,
 * and never skips: a skipped test is a green that proved nothing, and this
 * repository's CI refuses one outright.
 */

import { access, constants } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";

/**
 * The page's own globals, declared to exactly what the in-page code below uses.
 *
 * This repository's `tsconfig.json` carries no DOM library on purpose: nothing
 * in it runs in a browser, and `types: ["node"]` is part of what keeps a page
 * API from being reachable in collector code by accident. The functions handed
 * to `page.evaluate` DO run in a browser, so the handful of globals they touch
 * are declared here, module-scoped, rather than by opening the DOM to the whole
 * tree. A declaration that is wrong is caught by the assertion that reads it.
 */
type PageRect = { x: number; y: number; width: number; height: number; right: number };

type PageNode = { nodeType: number; textContent: string | null };

type PageElement = {
  tagName: string;
  className: string;
  parentElement: PageElement | null;
  childNodes: Iterable<PageNode>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  getBoundingClientRect(): PageRect;
};

type PagePolicyViolation = { violatedDirective: string; blockedURI: string };

declare const document: {
  querySelectorAll(selector: string): Iterable<PageElement>;
  documentElement: { clientWidth: number };
  body: { scrollWidth: number; innerText: string };
  activeElement: PageElement | null;
  addEventListener(
    type: "securitypolicyviolation",
    listener: (event: PagePolicyViolation) => void,
  ): void;
};

declare function getComputedStyle(element: PageElement): Record<string, string>;

/** The variable that names the engine, for a machine that keeps it elsewhere. */
export const BROWSER_EXECUTABLE_VARIABLE = "DEAL_SENTINEL_BROWSER";

/** Where this project's development and CI images put Chromium. */
export const DEFAULT_BROWSER_EXECUTABLE = "/usr/bin/chromium";

/** A theme the operating system preference can be in. */
export type Theme = "light" | "dark";

/** The two widths every view is proved at: a phone, and a desktop. */
export const PHONE_WIDTH = 360;
export const DESKTOP_WIDTH = 1280;

export class BrowserEngineUnavailableError extends Error {
  readonly executable: string;

  constructor(executable: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `no browser engine could be started from ${executable}: ${reason}. Set ` +
        `${BROWSER_EXECUTABLE_VARIABLE} to an engine this machine has. This ` +
        "run FAILS rather than skipping: every claim about what the dashboard " +
        "shows is measured in an engine, and a suite that quietly stopped " +
        "measuring them would report a green that proved nothing.",
    );
    this.name = "BrowserEngineUnavailableError";
    this.executable = executable;
  }
}

/** The one executable this run drives. Never a search, never a second guess. */
export function browserExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[BROWSER_EXECUTABLE_VARIABLE];
  return named !== undefined && named.trim() !== "" ? named.trim() : DEFAULT_BROWSER_EXECUTABLE;
}

/**
 * Start the engine, or fail naming the executable.
 *
 * `--no-sandbox` is about the BROWSER's own process sandbox, which needs kernel
 * capabilities a container does not always have. It is not a relaxation of
 * anything this repository guards: the only document this engine ever loads is
 * one this suite wrote a moment earlier, from a `file:` URL, with no network
 * origin reachable from it.
 */
export async function startEngine(
  executable: string = browserExecutable(),
): Promise<Browser> {
  try {
    await access(executable, constants.X_OK);
  } catch (error) {
    throw new BrowserEngineUnavailableError(executable, error);
  }
  try {
    return await puppeteer.launch({
      executablePath: executable,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    throw new BrowserEngineUnavailableError(executable, error);
  }
}

/** One drawn mark, as the rendered document places it. */
export type MarkReading = {
  /** Every `data-` attribute on the mark, so a test asserts on its own data. */
  data: Record<string, string>;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** One element that must clear a contrast floor, with what it resolved to. */
export type ContrastReading = {
  label: string;
  foreground: [number, number, number];
  background: [number, number, number];
  floor: number;
  ratio: number;
};

export type FocusReading = {
  label: string;
  /** What the engine drew around it once it held focus. */
  outlineWidth: number;
  outlineStyle: string;
  ring: string;
};

export type PageReading = {
  /** The engine that produced this reading, for the record. */
  engine: string;
  theme: Theme;
  width: number;
  /** Everything the page shows, as the engine lays it out. */
  visibleText: string;
  /** Every name and value the accessibility tree carries, flattened. */
  accessibleText: string[];
  marks: MarkReading[];
  cspViolations: string[];
  requests: string[];
  bodyScrollWidth: number;
  clientWidth: number;
  overflowingElements: string[];
  contrast: ContrastReading[];
  consoleErrors: string[];
};

export type RenderOptions = {
  theme?: Theme;
  width?: number;
  height?: number;
  executable?: string;
};

/**
 * Read what one HTML document shows, in one theme at one width.
 *
 * The document is written to a temporary directory and loaded over `file:`,
 * which is exactly how the produced dashboard is opened: nothing listens, and
 * nothing about the delivery is simulated.
 */
export async function readRenderedPage(
  html: string,
  options: RenderOptions = {},
): Promise<PageReading> {
  const theme = options.theme ?? "light";
  const width = options.width ?? DESKTOP_WIDTH;
  const browser = await startEngine(options.executable);
  const directory = await mkdtemp(path.join(tmpdir(), "ops-5-render-"));
  const file = path.join(directory, "index.html");

  try {
    await writeFile(file, html, "utf8");
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const requests: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => requests.push(request.url()));

    // Registered before the document exists, so a violation raised while the
    // page is still parsing is caught. A script injected this way runs outside
    // the page's own policy, which is what lets a page with `script-src 'none'`
    // still report its violations.
    await page.evaluateOnNewDocument(() => {
      const seen: string[] = [];
      (globalThis as unknown as { __violations: string[] }).__violations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await page.setViewport({ width, height: options.height ?? 900 });
    await page.goto(`file://${file}`, { waitUntil: "load" });

    const reading = await measure(page);
    const engine = await browser.version();
    return { engine, theme, width, consoleErrors, requests, ...reading };
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Everything read out of one loaded document, in one round trip. */
async function measure(page: Page): Promise<Omit<PageReading, "engine" | "theme" | "width" | "consoleErrors" | "requests">> {
  const measured = await page.evaluate(() => {
    const channel = (value: string): number => {
      const scaled = Number(value) / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const parse = (colour: string): [number, number, number, number] => {
      const numbers = colour.match(/[\d.]+/g) ?? ["0", "0", "0"];
      return [
        Number(numbers[0] ?? 0),
        Number(numbers[1] ?? 0),
        Number(numbers[2] ?? 0),
        numbers[3] === undefined ? 1 : Number(numbers[3]),
      ];
    };
    const effectiveBackground = (element: PageElement): [number, number, number] => {
      let node: PageElement | null = element;
      while (node !== null) {
        const [red, green, blue, alpha] = parse(getComputedStyle(node).backgroundColor);
        if (alpha > 0) return [red, green, blue];
        node = node.parentElement;
      }
      return [255, 255, 255];
    };
    const luminance = (rgb: [number, number, number]): number =>
      0.2126 * channel(String(rgb[0])) +
      0.7152 * channel(String(rgb[1])) +
      0.0722 * channel(String(rgb[2]));
    const ratio = (
      foreground: [number, number, number],
      background: [number, number, number],
    ): number => {
      const first = luminance(foreground);
      const second = luminance(background);
      const lighter = Math.max(first, second);
      const darker = Math.min(first, second);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const labelOf = (element: PageElement): string => {
      const own = (element.textContent ?? "").trim().slice(0, 40);
      return `${element.tagName.toLowerCase()}${element.className === "" ? "" : `.${String(element.className).split(" ")[0]}`}${own === "" ? "" : ` "${own}"`}`;
    };

    const marks = [...document.querySelectorAll("[data-mark]")].map((element: PageElement) => {
      const box = element.getBoundingClientRect();
      const data: Record<string, string> = {};
      for (const name of element.getAttributeNames()) {
        if (name.startsWith("data-")) data[name] = element.getAttribute(name) ?? "";
      }
      return { data, x: box.x, y: box.y, width: box.width, height: box.height };
    });

    const contrast: {
      label: string;
      foreground: [number, number, number];
      background: [number, number, number];
      floor: number;
      ratio: number;
    }[] = [];

    for (const element of document.querySelectorAll("body *")) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const indicator = element.getAttribute("data-indicator") !== null;
      const hasOwnText = [...element.childNodes].some(
        (node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "",
      );
      if (!hasOwnText && !indicator) continue;

      const size = Number.parseFloat(style.fontSize);
      const weight = Number(style.fontWeight);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const floor = indicator && !hasOwnText ? 3 : large ? 3 : 4.5;
      const [red, green, blue] = parse(style.color);
      const foreground: [number, number, number] = indicator && !hasOwnText
        ? (() => {
            const border = parse(style.borderTopColor);
            const background = parse(style.backgroundColor);
            return background[3] > 0
              ? [background[0], background[1], background[2]]
              : [border[0], border[1], border[2]];
          })()
        : [red, green, blue];
      const background = effectiveBackground(
        indicator && !hasOwnText ? (element.parentElement ?? element) : element,
      );
      contrast.push({
        label: labelOf(element),
        foreground,
        background,
        floor,
        ratio: ratio(foreground, background),
      });
    }

    // Content wider than the viewport is allowed, PROVIDED it scrolls inside
    // its own container: that is exactly what frontend F9 asks for, and a
    // table of instants and amounts is the case it was written about. So an
    // element is only reported when nothing between it and the body can
    // scroll it.
    const scrollsItsOwn = (element: PageElement): boolean => {
      let node: PageElement | null = element.parentElement;
      while (node !== null && node.tagName.toLowerCase() !== "body") {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const overflowingElements: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const box = element.getBoundingClientRect();
      if (box.right <= document.documentElement.clientWidth + 0.5) continue;
      if (scrollsItsOwn(element)) continue;
      overflowingElements.push(labelOf(element));
    }

    return {
      visibleText: document.body.innerText,
      marks,
      contrast,
      overflowingElements,
      bodyScrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cspViolations: (globalThis as unknown as { __violations: string[] }).__violations ?? [],
    };
  });

  const tree = await page.accessibility.snapshot({ interestingOnly: false });
  const accessibleText: string[] = [];
  const walk = (node: { name?: string; value?: string; children?: unknown[] } | null): void => {
    if (node === null) return;
    if (typeof node.name === "string" && node.name.trim() !== "") {
      accessibleText.push(node.name.trim());
    }
    if (typeof node.value === "string" && node.value.trim() !== "") {
      accessibleText.push(node.value.trim());
    }
    for (const child of node.children ?? []) {
      walk(child as { name?: string; value?: string; children?: unknown[] });
    }
  };
  walk(tree as never);

  return { ...measured, accessibleText };
}

/**
 * Walk the page by keyboard and report what the engine drew around whatever
 * held focus. Separate from `readRenderedPage` because it DRIVES the page
 * rather than reading it once.
 */
export async function readKeyboardFocus(
  html: string,
  options: RenderOptions = {},
): Promise<FocusReading[]> {
  const browser = await startEngine(options.executable);
  const directory = await mkdtemp(path.join(tmpdir(), "ops-5-focus-"));
  const file = path.join(directory, "index.html");

  try {
    await writeFile(file, html, "utf8");
    const page = await browser.newPage();
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: options.theme ?? "light" },
    ]);
    await page.setViewport({ width: options.width ?? DESKTOP_WIDTH, height: 900 });
    await page.goto(`file://${file}`, { waitUntil: "load" });

    const readings: FocusReading[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      const reading = await page.evaluate(() => {
        const active = document.activeElement;
        // Nothing focusable left: the walk has gone past the last one and the
        // browser has put focus back on the document itself.
        if (active === null || active.tagName.toLowerCase() === "body") return null;
        const style = getComputedStyle(active);
        return {
          label: `${active.tagName.toLowerCase()} "${(active.textContent ?? "").trim().slice(0, 30)}"`,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          outlineStyle: style.outlineStyle,
          ring: `${style.outlineColor} ${style.boxShadow}`,
        };
      });
      if (reading === null) break;
      if (readings.some((seen) => seen.label === reading.label)) break;
      readings.push(reading);
    }
    return readings;
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The checks themselves
 *
 * Each one THROWS, and each is proved red against a page built to break it
 * before the real page is believed. A check that cannot fail is not evidence.
 * ------------------------------------------------------------------ */

export function assertNoPolicyViolations(reading: PageReading): void {
  if (reading.cspViolations.length === 0) return;
  throw new Error(
    `the engine reported ${reading.cspViolations.length} content security ` +
      `policy violation(s): ${reading.cspViolations.join(", ")}`,
  );
}

/** Nothing is asked of any origin but the document's own file. */
export function assertNoForeignRequests(reading: PageReading): void {
  const foreign = reading.requests.filter((url) => !url.startsWith("file://"));
  if (foreign.length === 0) return;
  throw new Error(`the page requested ${foreign.length} resource(s) off its own origin: ${foreign.join(", ")}`);
}

/** The body does not scroll sideways, and nothing hangs off the viewport. */
export function assertNoSidewaysScroll(reading: PageReading): void {
  if (reading.bodyScrollWidth > reading.clientWidth) {
    throw new Error(
      `the body scrolls sideways at ${reading.width}px: scrollWidth ` +
        `${reading.bodyScrollWidth} against a viewport of ${reading.clientWidth}`,
    );
  }
  if (reading.overflowingElements.length > 0) {
    throw new Error(
      `${reading.overflowingElements.length} element(s) reach past the ` +
        `viewport at ${reading.width}px: ${reading.overflowingElements.join(", ")}`,
    );
  }
}

/** Every measured pair clears the floor it carries, in this theme. */
export function assertContrastFloors(reading: PageReading): void {
  const failures = reading.contrast.filter((pair) => pair.ratio < pair.floor);
  if (failures.length === 0) return;
  throw new Error(
    `${failures.length} pair(s) below their contrast floor in the ` +
      `${reading.theme} theme: ` +
      failures
        .map((pair) => `${pair.label} ${pair.ratio.toFixed(2)}:1 under ${pair.floor}:1`)
        .join("; "),
  );
}

/** A reading is only evidence if it measured something. */
export function assertMeasuredSomething(reading: PageReading): void {
  if (reading.contrast.length < 5) {
    throw new Error(
      `only ${reading.contrast.length} contrast pair(s) were measured, so this ` +
        "reading has stopped looking rather than found a clean page",
    );
  }
}

/** Marks run left to right in observation order. */
export function assertMarksInTimeOrder(marks: readonly MarkReading[]): void {
  for (let index = 1; index < marks.length; index += 1) {
    const earlier = marks[index - 1];
    const later = marks[index];
    const earlierAt = Number(earlier.data["data-at"]);
    const laterAt = Number(later.data["data-at"]);
    if (laterAt < earlierAt) {
      throw new Error("the marks are not in observation order along the time axis");
    }
    if (laterAt > earlierAt && later.x <= earlier.x) {
      throw new Error(
        `a later observation is drawn at x=${later.x}, not right of the earlier ` +
          `one at x=${earlier.x}`,
      );
    }
  }
}

/** A higher amount is drawn above a lower one: smaller y is higher on screen. */
export function assertHigherAmountsDrawnAbove(marks: readonly MarkReading[]): void {
  for (const first of marks) {
    for (const second of marks) {
      const firstAmount = BigInt(first.data["data-amount"] ?? "0");
      const secondAmount = BigInt(second.data["data-amount"] ?? "0");
      if (firstAmount <= secondAmount) continue;
      if (first.y < second.y) continue;
      throw new Error(
        `${firstAmount} is drawn at y=${first.y}, not above ${secondAmount} at ` +
          `y=${second.y}`,
      );
    }
  }
}

/** Write one screenshot of a document, for the evidence a spec travels with. */
export async function captureScreenshot(
  html: string,
  target: string,
  options: RenderOptions = {},
): Promise<void> {
  const browser = await startEngine(options.executable);
  const directory = await mkdtemp(path.join(tmpdir(), "ops-5-shot-"));
  const file = path.join(directory, "index.html");
  try {
    await writeFile(file, html, "utf8");
    const page = await browser.newPage();
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: options.theme ?? "light" },
    ]);
    await page.setViewport({ width: options.width ?? DESKTOP_WIDTH, height: options.height ?? 900 });
    await page.goto(`file://${file}`, { waitUntil: "load" });
    await page.screenshot({ path: target as `${string}.png`, fullPage: true });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}
