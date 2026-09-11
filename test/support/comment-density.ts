/**
 * What counts as prose in this repository's TypeScript, and how much of it a
 * file may be.
 *
 * The counting is TOKENIZED, never pattern-matched. `//` inside a string, `/*`
 * inside a template literal, a slash pair inside a character class and
 * comment-looking JSX text are all code, and a byte scanner reads every one of
 * them as prose. The compiler already in `devDependencies` decides instead.
 *
 * Built the way `test/support/pinning.ts` is built: pure functions over
 * `{ path, text }` records, so a planted sample is graded by exactly the same
 * code as the tree is, with the samples parked under `.fixture` where the real
 * scan cannot read them.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import type { ScannedFile } from "./pinning.ts";

/**
 * Ported from the umbrella's `check_comment_density()`: the bound a committed
 * ceiling may never exceed, and the gap it keeps between error and warning.
 * Neither is derived from this tree, so neither lives in configuration where a
 * loosening would read as a threshold change.
 */
export const CAP = 50;
export const BAND = 10;

export type CommentDensityRule = "read-failed" | "tokenize-failed";

export const COMMENT_DENSITY_RULES: readonly CommentDensityRule[] = [
  "read-failed",
  "tokenize-failed",
];

export type CommentDensityFinding = {
  /** Repository-relative, forward slashes. Empty for a tree-level finding. */
  path: string;
  rule: CommentDensityRule;
  /** The offending value, verbatim. */
  reference: string;
  message: string;
};

export type FileMeasurement = {
  path: string;
  /** Non-blank lines. */
  countedLines: number;
  /** Counted lines whose every non-whitespace byte lies inside a comment. */
  commentLines: number;
  /** `commentLines` as a percentage of `countedLines`, in percentage points. */
  ratio: number;
};

/** Which files the sweep has an opinion about, and how small is too small. */
export type EligibilityConfig = {
  /**
   * Counted lines below which a file is excluded. One comment line in an
   * N-line file moves its ratio by 100/N points, so a short file's ratio is
   * noise rather than a measurement.
   */
  floor: number;
  extensions: readonly string[];
  /** Repository-relative prefixes left out of the eligible set. */
  excludedPaths: readonly string[];
  /** A file whose header comment carries this is generated output. */
  generatedMarker: string;
};

export const ELIGIBILITY_DEFAULTS: EligibilityConfig = {
  floor: 20,
  extensions: [".ts", ".mts", ".cts", ".tsx"],
  excludedPaths: [],
  generatedMarker: "@generated",
};

/** A file the tokenizer refused. Never scored: a refusal is not zero prose. */
export class CommentScanError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(filePath: string, reason: string) {
    super(`${filePath} ${reason}`);
    this.name = "CommentScanError";
    this.path = filePath;
    this.reason = reason;
  }
}

/**
 * The parser's own syntactic diagnostics. `parseDiagnostics` is not in the
 * public type, and nothing else reports an unterminated literal without
 * building a whole program.
 */
type ParsedSource = ts.SourceFile & {
  parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
};

const UNTERMINATED: ReadonlyMap<number, string> = new Map([
  [1002, "an unterminated string literal"],
  [1010, "an unterminated comment"],
  [1160, "an unterminated template literal"],
  [1161, "an unterminated regular expression literal"],
]);

function scriptKindOf(filePath: string): ts.ScriptKind {
  return path.extname(filePath) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export type SourceScan = {
  comments: readonly ts.CommentRange[];
  /** Offset of the first real token: everything before it is trivia. */
  firstTokenStart: number;
};

/**
 * Every comment in `text`, and where the code starts.
 *
 * A comment is trivia, so it is read off the token it precedes rather than
 * found in the tree. Both the leading and the trailing trivia of each token are
 * read: leading skips a comment that opens on a line of code, which is where a
 * block comment spanning three lines of prose begins. Positions at or past the
 * token's own start are dropped, because those helpers rescan raw text and will
 * happily report JSX text beginning `//` as a line comment.
 */
export function scanSource(filePath: string, text: string): SourceScan {
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(filePath),
  );
  for (const diagnostic of (source as ParsedSource).parseDiagnostics ?? []) {
    const reason = UNTERMINATED.get(diagnostic.code);
    if (reason !== undefined) {
      throw new CommentScanError(
        filePath,
        `carries ${reason} at offset ${diagnostic.start}, so the tokenizer ` +
          "cannot say where its prose ends",
      );
    }
  }

  const comments = new Map<number, ts.CommentRange>();
  let firstTokenStart = text.length;

  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const start = node.getStart(source);
    firstTokenStart = Math.min(firstTokenStart, start);
    if (start <= node.pos) return;
    const keep = (range: ts.CommentRange): void => {
      if (range.end <= start) comments.set(range.pos, range);
    };
    (ts.getLeadingCommentRanges(text, node.pos) ?? []).forEach(keep);
    (ts.getTrailingCommentRanges(text, node.pos) ?? []).forEach(keep);
  };
  visit(source);

  return {
    comments: [...comments.values()].sort((left, right) => left.pos - right.pos),
    firstTokenStart,
  };
}

/** Counted lines and comment lines. Throws `CommentScanError` on a refusal. */
export function measureText(filePath: string, text: string): FileMeasurement {
  const { comments } = scanSource(filePath, text);
  const inComment = new Uint8Array(text.length);
  for (const range of comments) inComment.fill(1, range.pos, range.end);

  let countedLines = 0;
  let commentLines = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    let hasContent = false;
    let hasCode = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index].trim() === "") continue;
      hasContent = true;
      if (inComment[offset + index] === 0) {
        hasCode = true;
        break;
      }
    }
    if (hasContent) {
      countedLines += 1;
      if (!hasCode) commentLines += 1;
    }
    offset += line.length + 1;
  }

  return {
    path: filePath,
    countedLines,
    commentLines,
    ratio: countedLines === 0 ? 0 : (commentLines * 100) / countedLines,
  };
}

/** The marker in the header comment, where a generator writes it. */
export function isGeneratedText(filePath: string, text: string, marker: string): boolean {
  if (marker === "" || !text.includes(marker)) return false;
  return text.slice(0, scanSource(filePath, text).firstTokenStart).includes(marker);
}

export type Exclusion = { path: string; reason: string };

export type MeasuredFiles = {
  /** Eligible and at or above the floor: the set a ceiling is derived from. */
  measurements: FileMeasurement[];
  belowFloor: FileMeasurement[];
  excluded: Exclusion[];
  findings: CommentDensityFinding[];
};

function excludedBy(filePath: string, config: EligibilityConfig): string | null {
  for (const prefix of config.excludedPaths) {
    if (filePath === prefix || filePath.startsWith(prefix)) {
      return `is under "${prefix}", which the committed configuration excludes`;
    }
  }
  return null;
}

/**
 * Measure `files`, keeping the exclusions and the refusals distinct from the
 * scores. A file the tokenizer refuses becomes a finding and is scored
 * nowhere: counting it as zero prose is how a broken scan reports a clean tree.
 */
export function measureFiles(
  files: readonly ScannedFile[],
  config: EligibilityConfig,
): MeasuredFiles {
  const outcome: MeasuredFiles = {
    measurements: [],
    belowFloor: [],
    excluded: [],
    findings: [],
  };

  for (const file of files) {
    const excluded = excludedBy(file.path, config);
    if (excluded !== null) {
      outcome.excluded.push({ path: file.path, reason: excluded });
      continue;
    }
    let measurement: FileMeasurement;
    try {
      if (isGeneratedText(file.path, file.text, config.generatedMarker)) {
        outcome.excluded.push({
          path: file.path,
          reason: `carries "${config.generatedMarker}" in its header, so it is generated output`,
        });
        continue;
      }
      measurement = measureText(file.path, file.text);
    } catch (error) {
      if (!(error instanceof CommentScanError)) throw error;
      outcome.findings.push({
        path: file.path,
        rule: "tokenize-failed",
        reference: error.reason,
        message:
          `${file.path} ${error.reason}. A file that cannot be tokenized is ` +
          "not a file with no prose in it, so this refuses rather than scoring it.",
      });
      continue;
    }
    if (measurement.countedLines < config.floor) {
      outcome.belowFloor.push(measurement);
      continue;
    }
    outcome.measurements.push(measurement);
  }

  outcome.measurements.sort((left, right) => right.ratio - left.ratio);
  return outcome;
}

/* ------------------------------------------------------------------ *
 * Reading the tree
 * ------------------------------------------------------------------ */

/** Other people's code, and things git does not track. */
const SKIPPED_ANYWHERE = new Set(["node_modules", ".git"]);

/** Build output and data, and only where a build actually writes them. */
const SKIPPED_AT_ROOT = new Set(["dist", "build", "coverage", "backups"]);

/** The extension this repository parks samples its own scans must not read. */
export const FIXTURE_EXTENSION = ".fixture";

export type CollectedFiles = {
  files: ScannedFile[];
  findings: CommentDensityFinding[];
};

function readFailure(relativePath: string, error: unknown): CommentDensityFinding {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    path: relativePath,
    rule: "read-failed",
    reference: reason,
    message:
      `${relativePath} could not be read (${reason}). A path the sweep cannot ` +
      "read is not a path with no prose in it: skipping it, or scoring it as " +
      "zero, is how a check that has stopped looking reports a clean tree.",
  };
}

/** Every TypeScript file the sweep reads, repository-relative. */
export function collectCommentDensityFiles(
  rootDir: string,
  config: EligibilityConfig,
): CollectedFiles {
  const collected: CollectedFiles = { files: [], findings: [] };

  const walk = (directory: string, atRoot: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch (error) {
      collected.findings.push(readFailure(relativeTo(rootDir, directory), error));
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_ANYWHERE.has(entry)) continue;
      if (atRoot && SKIPPED_AT_ROOT.has(entry)) continue;
      const absolute = path.join(directory, entry);
      const relative = relativeTo(rootDir, absolute);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(absolute).isDirectory();
      } catch (error) {
        collected.findings.push(readFailure(relative, error));
        continue;
      }
      if (isDirectory) {
        walk(absolute, false);
        continue;
      }
      if (path.extname(entry) === FIXTURE_EXTENSION) continue;
      if (!config.extensions.includes(path.extname(entry))) continue;
      try {
        collected.files.push({ path: relative, text: readFileSync(absolute, "utf8") });
      } catch (error) {
        collected.findings.push(readFailure(relative, error));
      }
    }
  };

  walk(rootDir, true);
  return collected;
}

function relativeTo(rootDir: string, absolute: string): string {
  return path.relative(rootDir, absolute).split(path.sep).join("/");
}

/** The findings as the message a failing check should carry. */
export function describeCommentDensityFindings(
  findings: readonly CommentDensityFinding[],
): string {
  if (findings.length === 0) return "no file is over the comment-density ceiling";
  return (
    `${findings.length} comment-density finding(s):\n` +
    findings
      .map((finding) => `  ${finding.path === "" ? "(tree)" : finding.path} [${finding.rule}] ${finding.message}`)
      .join("\n")
  );
}

/** One line per file, worst first: the distribution a measurement records. */
export function describeMeasurements(measurements: readonly FileMeasurement[]): string {
  return measurements
    .map(
      (measurement) =>
        `${measurement.ratio.toFixed(1).padStart(5)}  ` +
        `${String(measurement.commentLines).padStart(4)}/${String(measurement.countedLines).padEnd(4)}  ` +
        measurement.path,
    )
    .join("\n");
}
