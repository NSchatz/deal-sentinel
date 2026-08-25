/**
 * The check that makes "there is no path around the governor" a property of the
 * repository rather than a habit.
 *
 * A governor something can route around is a suggestion. So this module reads
 * every source file in the tree and reports any site that reaches an HTTP
 * client directly: a bare `fetch(`, an import of `node:http`, `undici`, `axios`
 * or their neighbours, an `https.request(`, an `XMLHttpRequest`. Exactly one
 * module is allowed to do it - `packages/governor/src/transport.ts` - and one
 * test-support file is allowed to import `node:http` for the opposite purpose:
 * to SERVE on loopback, which sends nothing anywhere.
 *
 * The allowlist is deliberately by exact path and by rule. Widening it is a
 * visible, reviewable diff, which is the point.
 *
 * `test/unit/no-direct-http.test.ts` proves this check can FAIL before it
 * believes that it passes: it runs the same function over a committed fixture
 * call site that bypasses the governor and asserts the finding, then runs it
 * over the tree as it stands and asserts none. A check that can only pass
 * proves nothing.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type SourceFile = {
  /** Repository-relative, with forward slashes. */
  path: string;
  text: string;
};

export type DirectHttpFinding = {
  path: string;
  /** One-based. */
  line: number;
  rule: string;
  snippet: string;
};

export type AllowlistEntry = {
  /** Repository-relative path, forward slashes. */
  path: string;
  /** Rules this file may break, and the reason it may. */
  rules: string[];
  why: string;
};

/**
 * The complete list of files permitted to name an HTTP client, and why.
 *
 * Two entries. If you are adding a third, you are adding a second way out of
 * this process, and the governor stops being one.
 */
export const HTTP_CLIENT_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    path: "packages/governor/src/transport.ts",
    rules: ["fetch-call", "client-import", "client-request-call"],
    why:
      "The single HTTP transport. Everything else takes an HttpTransport port " +
      "and receives one from the governor.",
  },
  {
    path: "test/support/loopback-server.ts",
    rules: ["client-import"],
    why:
      "Creates an http.Server bound to 127.0.0.1 so the suite can exercise " +
      "robots, back-pressure and breaker cases without touching a third " +
      "party. It serves; it never sends.",
  },
];

type Rule = { name: string; pattern: RegExp; describe: string };

const RULES: readonly Rule[] = [
  {
    name: "client-import",
    pattern:
      /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](?:node:)?(?:http|https|http2|undici|axios|node-fetch|got|superagent|request|phin|needle|ky)["']/,
    describe: "imports an HTTP client",
  },
  {
    name: "fetch-call",
    // A bare `fetch(`, or one reached through a global. `governor.request(...)`
    // is a method call on an object and is not this.
    pattern: /(?<![.\w$])fetch\s*\(|(?:globalThis|window|self)\s*\.\s*fetch\b/,
    describe: "calls fetch directly",
  },
  {
    name: "client-request-call",
    pattern:
      /\b(?:https?|http2)\s*\.\s*(?:request|get|connect)\s*\(|new\s+XMLHttpRequest\b|\bnew\s+(?:Agent|ClientRequest)\s*\(/,
    describe: "issues a request through a client object",
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

/** Every source file under `rootDir`, repository-relative, comments intact. */
export function collectSourceFiles(rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const absolute = path.join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry))) continue;
      files.push({
        path: path.relative(rootDir, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(rootDir);
  return files;
}

/**
 * Report every direct HTTP call site in `files` that the allowlist does not
 * cover. Pure: it takes text, so a fixture call site is checked by exactly the
 * same code as the repository is.
 */
export function findDirectHttpCallSites(
  files: readonly SourceFile[],
  allowlist: readonly AllowlistEntry[] = HTTP_CLIENT_ALLOWLIST,
): DirectHttpFinding[] {
  const findings: DirectHttpFinding[] = [];

  for (const file of files) {
    const allowed = allowlist.find((entry) => entry.path === file.path);
    const lines = stripComments(file.text).split("\n");

    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        if (allowed !== undefined && allowed.rules.includes(rule.name)) continue;
        findings.push({
          path: file.path,
          line: index + 1,
          rule: rule.name,
          snippet: line.trim(),
        });
      }
    });
  }

  return findings;
}

/** The findings as the message a failing check should carry. */
export function describeFindings(findings: readonly DirectHttpFinding[]): string {
  if (findings.length === 0) return "no direct HTTP call sites";
  const lines = findings.map(
    (finding) =>
      `  ${finding.path}:${finding.line} (${finding.rule}) ${finding.snippet}`,
  );
  return (
    `${findings.length} call site(s) reach an HTTP client outside the ` +
    "governor. Every outbound request in this repository goes through " +
    "Governor.request, which applies the destination host's configured " +
    "ceiling, a randomised delay, the robots.txt decision, back-pressure, the " +
    "breaker and the allowance. A path around it is a path around all six:\n" +
    lines.join("\n")
  );
}

/**
 * Blank out comment bodies, keeping every newline and every other character, so
 * that line numbers survive and a sentence ABOUT a call site is not read as
 * one.
 *
 * String and template contents are kept verbatim rather than blanked, on
 * purpose: an import specifier has to stay readable, and a call hidden in a
 * template literal's interpolation is a real call. Quote state is tracked only
 * to decide whether a `/` starts a comment, and it RESETS at every newline: a
 * quote character inside a regular expression literal would otherwise swallow
 * the rest of the file, and a check that silently stops looking is worse than
 * no check at all.
 */
export function stripComments(text: string): string {
  let output = "";
  let index = 0;
  let inBlockComment = false;
  let quote = "";

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? "";

    if (character === "\n") {
      // Line boundary: a single-quoted string cannot cross it, and a template
      // that does is not worth losing the rest of the file over.
      quote = "";
      output += "\n";
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        output += "  ";
        index += 2;
        continue;
      }
      output += " ";
      index += 1;
      continue;
    }

    if (quote !== "") {
      if (character === "\\") {
        output += character + next;
        index += 2;
        continue;
      }
      if (character === quote) quote = "";
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", index);
      const stop = lineEnd === -1 ? text.length : lineEnd;
      output += " ".repeat(stop - index);
      index = stop;
      continue;
    }

    if (character === "/" && next === "*") {
      inBlockComment = true;
      output += "  ";
      index += 2;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    }

    output += character;
    index += 1;
  }

  return output;
}
