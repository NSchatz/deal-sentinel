/**
 * The check over the token file, and over every stylesheet that reaches for it.
 *
 * This is the ONE source-text check in this spec's work, and it is a source
 * property on purpose: what tokens a file declares, which tier they sit in, and
 * whether a recorded ratio matches the values it claims to describe are all
 * facts about the text. What those tokens then PRODUCE - the contrast a reader
 * actually gets, the width the body actually takes - is measured in a browser
 * engine by `ops-5-render.ts`, because source text cannot answer it.
 *
 * Built the way `pinning.ts` and `comment-density.ts` are built: pure functions
 * over `{ path, text }` records, with a rule table the test proves RED one rule
 * at a time before it believes the pass over the committed files.
 *
 * THE RECORDED RATIOS ARE RE-DERIVED, never trusted. Styling S7 asks for the
 * measured ratio beside each pair that must clear a floor; a figure nobody
 * recomputes is a number that stops being true the first time a value moves.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ScannedFile } from "./pinning.ts";

/** The semantic names every repository here declares (styling S2). */
export const REQUIRED_SEMANTIC_TOKENS: readonly string[] = [
  "--bg",
  "--panel",
  "--line",
  "--fg",
  "--muted",
  "--accent",
  "--ok",
  "--warn",
  "--bad",
  "--border",
  "--mark",
  "--focus",
  "--disabled",
  "--selected",
  "--link",
];

/** The 4px scale (styling S3). A spacing token off it is a finding. */
export const SPACING_SCALE: readonly number[] = [4, 8, 12, 16, 24, 32, 48, 64];

/** Every pair that must clear a floor, and the floor it must clear. */
export const REQUIRED_CONTRAST_PAIRS: readonly [string, string, number][] = [
  ["--fg", "--panel", 4.5],
  ["--fg", "--bg", 4.5],
  ["--fg", "--selected", 4.5],
  ["--muted", "--panel", 4.5],
  ["--accent", "--panel", 4.5],
  ["--ok", "--panel", 4.5],
  ["--warn", "--panel", 4.5],
  ["--bad", "--panel", 4.5],
  ["--disabled", "--panel", 4.5],
  ["--link", "--panel", 4.5],
  ["--mark", "--panel", 3],
  ["--focus", "--panel", 3],
];

export type TokenRule =
  | "one-token-file"
  | "colour-outside-tokens"
  | "length-outside-tokens"
  | "missing-tier"
  | "missing-semantic"
  | "missing-theme-value"
  | "spacing-off-scale"
  | "ratio-not-recorded"
  | "ratio-not-measured"
  | "ratio-under-floor"
  | "motion-declared";

export const TOKEN_RULES: readonly TokenRule[] = [
  "one-token-file",
  "colour-outside-tokens",
  "length-outside-tokens",
  "missing-tier",
  "missing-semantic",
  "missing-theme-value",
  "spacing-off-scale",
  "ratio-not-recorded",
  "ratio-not-measured",
  "ratio-under-floor",
  "motion-declared",
];

export type TokenFinding = {
  path: string;
  /** One-based. Zero where the finding is about a file or the set. */
  line: number;
  rule: TokenRule;
  reference: string;
  message: string;
};

export type Theme = "light" | "dark";

export type RecordedRatio = {
  theme: Theme;
  foreground: string;
  background: string;
  recorded: number;
  floor: number;
  line: number;
};

export type TokenFile = {
  path: string;
  /** Every declaration, per theme: `--name` to its verbatim value. */
  values: Record<Theme, Record<string, string>>;
  recorded: RecordedRatio[];
};

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;
const LENGTH = /(?<![\w-])\d*\.?\d+(?:px|rem|em|pt|vh|vw)\b/;
const DECLARATION = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i;
const RATIO = /ratio:\s*(--[a-z0-9-]+)\s+on\s+(--[a-z0-9-]+)\s*=\s*([\d.]+):1\s*\(floor\s+([\d.]+)\)/i;
const MOTION = /(?<![\w-])(?:transition|animation)(?:-[a-z]+)?\s*:/;

/**
 * Read one token file into the two themes it declares.
 *
 * The dark theme is whatever sits inside a `prefers-color-scheme: dark` block;
 * everything else is the light one. Tracking that by brace depth is enough for
 * a file this shape, and a file that grows a construct this cannot read fails
 * the tier assertions rather than passing quietly.
 */
export function readTokenFile(file: ScannedFile): TokenFile {
  const values: Record<Theme, Record<string, string>> = { light: {}, dark: {} };
  const recorded: RecordedRatio[] = [];

  let depth = 0;
  let darkFrom: number | null = null;

  file.text.split("\n").forEach((line, index) => {
    const theme: Theme = darkFrom === null ? "light" : "dark";

    const ratio = RATIO.exec(line);
    if (ratio !== null) {
      recorded.push({
        theme,
        foreground: ratio[1],
        background: ratio[2],
        recorded: Number(ratio[3]),
        floor: Number(ratio[4]),
        line: index + 1,
      });
    }

    const declaration = DECLARATION.exec(line);
    if (declaration !== null) values[theme][declaration[1]] = declaration[2].trim();

    if (/@media[^{]*prefers-color-scheme:\s*dark/.test(line)) darkFrom = depth;
    for (const character of line) {
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (darkFrom !== null && depth <= darkFrom) darkFrom = null;
      }
    }
  });

  return { path: file.path, values, recorded };
}

/** Resolve `var(--x)` one hop into the primitives, or return the value. */
export function resolve(token: string, file: TokenFile, theme: Theme): string | null {
  const direct = file.values[theme][token] ?? file.values.light[token];
  if (direct === undefined) return null;
  const reference = /var\(\s*(--[a-z0-9-]+)\s*\)/i.exec(direct);
  if (reference === null) return direct;
  const primitive = file.values[theme][reference[1]] ?? file.values.light[reference[1]];
  return primitive ?? null;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of a `#rrggbb` value, or null. */
export function luminance(colour: string): number | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex === null) return null;
  const red = Number.parseInt(hex[1].slice(0, 2), 16);
  const green = Number.parseInt(hex[1].slice(2, 4), 16);
  const blue = Number.parseInt(hex[1].slice(4, 6), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** The WCAG contrast ratio between two `#rrggbb` values, or null. */
export function contrastRatio(foreground: string, background: string): number | null {
  const first = luminance(foreground);
  const second = luminance(background);
  if (first === null || second === null) return null;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function finding(
  file: string,
  line: number,
  rule: TokenRule,
  reference: string,
  message: string,
): TokenFinding {
  return { path: file, line, rule, reference, message };
}

/**
 * Which of the stylesheets is the token file: the one declaring the roles.
 *
 * MOST of the vocabulary rather than all of it, deliberately. A file missing
 * one required name is a token file with a hole in it, and it has to stay
 * recognisable as the token file for that hole to be reported as one.
 */
export function tokenFilesIn(files: readonly ScannedFile[]): ScannedFile[] {
  const enough = Math.ceil(REQUIRED_SEMANTIC_TOKENS.length / 2);
  return files.filter(
    (file) =>
      REQUIRED_SEMANTIC_TOKENS.filter((token) => file.text.includes(`${token}:`)).length >=
      enough,
  );
}

/**
 * Blank comment bodies, keeping every newline so line numbers survive. The
 * header of a stylesheet talks about 360px and about colours, and a check that
 * fires on prose is a check somebody switches off.
 */
export function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

/**
 * Grade a set of stylesheets. Pure: it takes text, so a mutated sample is
 * graded by exactly the same code the committed files are.
 */
export function findTokenFindings(files: readonly ScannedFile[]): TokenFinding[] {
  const findings: TokenFinding[] = [];
  const tokenFiles = tokenFilesIn(files);

  if (tokenFiles.length !== 1) {
    findings.push(
      finding(
        tokenFiles.map((file) => file.path).join(", "),
        0,
        "one-token-file",
        String(tokenFiles.length),
        `${tokenFiles.length} stylesheet(s) declare the role vocabulary. Styling ` +
          "S1 asks for exactly one committed token file per repository: two of " +
          "them is two answers to what --fg means.",
      ),
    );
    if (tokenFiles.length === 0) return findings;
  }

  const tokens = readTokenFile(tokenFiles[0]);

  for (const file of files) {
    if (file.path === tokens.path) continue;
    const readable = file.text.split("\n");
    stripCssComments(file.text).split("\n").forEach((code, index) => {
      const line = readable[index] ?? code;
      if (COLOUR.test(code)) {
        findings.push(
          finding(
            file.path,
            index + 1,
            "colour-outside-tokens",
            line.trim(),
            "declares a colour of its own. Every colour resolves to a token in " +
              `${tokens.path} (styling S1).`,
          ),
        );
      }
      if (LENGTH.test(code)) {
        findings.push(
          finding(
            file.path,
            index + 1,
            "length-outside-tokens",
            line.trim(),
            "declares a length of its own. Every spacing length resolves to a " +
              `token in ${tokens.path} (styling S1 and S3).`,
          ),
        );
      }
      if (MOTION.test(code)) {
        findings.push(
          finding(
            file.path,
            index + 1,
            "motion-declared",
            line.trim(),
            "declares motion. Styling S9 makes motion decoration and never " +
              "information; this page carries none at all, so a transition here " +
              "is a value change somebody made illegible with motion off.",
          ),
        );
      }
    });
  }

  findings.push(...findTierFindings(tokens));
  findings.push(...findContrastFindings(tokens));
  return findings;
}

/** The three tiers, the role vocabulary, and the spacing scale. */
export function findTierFindings(tokens: TokenFile): TokenFinding[] {
  const findings: TokenFinding[] = [];
  const light = tokens.values.light;
  const names = Object.keys(light);

  const primitives = names.filter((name) => /^--ds-/.test(name));
  const semantics = names.filter((name) => REQUIRED_SEMANTIC_TOKENS.includes(name));
  const components = names.filter(
    (name) =>
      !REQUIRED_SEMANTIC_TOKENS.includes(name) &&
      !/^--ds-/.test(name) &&
      !/^--space-/.test(name) &&
      !/^--(text|line|hairline)/.test(name),
  );

  for (const [tier, found] of [
    ["primitive", primitives],
    ["semantic", semantics],
    ["component", components],
  ] as const) {
    if (found.length > 0) continue;
    findings.push(
      finding(
        tokens.path,
        0,
        "missing-tier",
        tier,
        `declares no ${tier} tier. Styling S2 asks for all three: primitives ` +
          "with no meaning, semantics that assign a role, and components that " +
          "bind a semantic to one part of the page.",
      ),
    );
  }

  for (const token of REQUIRED_SEMANTIC_TOKENS) {
    if (light[token] !== undefined) continue;
    findings.push(
      finding(
        tokens.path,
        0,
        "missing-semantic",
        token,
        `declares no ${token}. The role vocabulary in styling S2 is the same in ` +
          "every repository here, so a missing name is a surface that has quietly " +
          "invented its own.",
      ),
    );
  }

  for (const token of REQUIRED_SEMANTIC_TOKENS) {
    if (light[token] === undefined) continue;
    if (tokens.values.dark[token] !== undefined) continue;
    findings.push(
      finding(
        tokens.path,
        0,
        "missing-theme-value",
        token,
        `carries no dark value for ${token}. Styling S6 asks for each theme to ` +
          "be hand-authored: a value inherited from the other theme was not " +
          "chosen for this one and was never measured in it.",
      ),
    );
  }

  for (const [name, value] of Object.entries(light)) {
    if (!/^--space-/.test(name)) continue;
    const length = /^(\d+)px$/.exec(value.trim());
    if (length !== null && SPACING_SCALE.includes(Number(length[1]))) continue;
    findings.push(
      finding(
        tokens.path,
        0,
        "spacing-off-scale",
        `${name}: ${value}`,
        `is not on the 4px scale (${SPACING_SCALE.join(", ")}). Styling S3 fixes ` +
          "the scale so two surfaces cannot disagree about what one step is.",
      ),
    );
  }

  return findings;
}

/** Every floored pair recorded, and every recorded figure re-derived. */
export function findContrastFindings(tokens: TokenFile): TokenFinding[] {
  const findings: TokenFinding[] = [];

  for (const theme of ["light", "dark"] as const) {
    for (const [foreground, background, floor] of REQUIRED_CONTRAST_PAIRS) {
      const held = tokens.recorded.find(
        (entry) =>
          entry.theme === theme &&
          entry.foreground === foreground &&
          entry.background === background,
      );
      if (held === undefined) {
        findings.push(
          finding(
            tokens.path,
            0,
            "ratio-not-recorded",
            `${theme} ${foreground} on ${background}`,
            "must clear a floor and carries no measured ratio beside it in this " +
              "theme. Styling S7: a later change that drops below the floor is " +
              "only visible in the diff when the figure is written down.",
          ),
        );
        continue;
      }

      const measured = contrastRatio(
        resolve(foreground, tokens, theme) ?? "",
        resolve(background, tokens, theme) ?? "",
      );
      if (measured === null) {
        findings.push(
          finding(
            tokens.path,
            held.line,
            "ratio-not-measured",
            `${theme} ${foreground} on ${background}`,
            "records a ratio for a pair this check cannot resolve to two colours, " +
              "so the recorded figure describes nothing it can re-derive.",
          ),
        );
        continue;
      }

      if (Math.abs(measured - held.recorded) > 0.011) {
        findings.push(
          finding(
            tokens.path,
            held.line,
            "ratio-not-measured",
            `${theme} ${foreground} on ${background}`,
            `records ${held.recorded.toFixed(2)}:1 where the values in this file ` +
              `give ${measured.toFixed(2)}:1. A figure nobody recomputes stops ` +
              "being true the first time a value moves.",
          ),
        );
      }

      if (measured < floor) {
        findings.push(
          finding(
            tokens.path,
            held.line,
            "ratio-under-floor",
            `${theme} ${foreground} on ${background}`,
            `is ${measured.toFixed(2)}:1 against a floor of ${floor}:1.`,
          ),
        );
      }
    }
  }

  return findings;
}

export function describeTokenFindings(findings: readonly TokenFinding[]): string {
  if (findings.length === 0) return "every colour and every length resolves to a token";
  return (
    `${findings.length} token finding(s):\n` +
    findings
      .map(
        (found) =>
          `  ${found.path}${found.line === 0 ? "" : `:${found.line}`} [${found.rule}] ` +
          `${found.reference} ${found.message}`,
      )
      .join("\n")
  );
}

/** Every stylesheet this repository ships, found by scanning rather than by name. */
export function collectStylesheets(rootDir: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (entry === "node_modules" || entry === ".git") continue;
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (path.extname(entry) !== ".css") continue;
      files.push({
        path: path.relative(rootDir, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };
  walk(rootDir);
  return files;
}
