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

export type CommentDensityRule =
  | "read-failed"
  | "tokenize-failed"
  | "over-ceiling"
  | "empty-eligible-set"
  | "ceiling-over-cap"
  | "warn-floor-band"
  | "ceiling-not-derived"
  | "record-command"
  | "record-commit"
  | "record-trim-set"
  | "record-trim-file";

export const COMMENT_DENSITY_RULES: readonly CommentDensityRule[] = [
  "read-failed",
  "tokenize-failed",
  "over-ceiling",
  "empty-eligible-set",
  "ceiling-over-cap",
  "warn-floor-band",
  "ceiling-not-derived",
  "record-command",
  "record-commit",
  "record-trim-set",
  "record-trim-file",
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

/** The eligible set, plus the two thresholds derived from a measurement. */
export type CommentDensityConfig = EligibilityConfig & {
  ceiling: number;
  warnFloor: number;
};

export const CONFIG_PATH = "config/comment-density.json";
export const RECORD_PATH = "docs/decisions/0006-comment-density.md";
export const REPORT_COMMAND = "pnpm run comment-density:report";
export const EMPTY_TRIM_SENTENCE =
  "the measured over-ceiling set is empty; no file was trimmed";

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

/* ------------------------------------------------------------------ *
 * The committed configuration
 * ------------------------------------------------------------------ */

function numberField(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${CONFIG_PATH} carries no numeric "${name}"`);
  }
  return value;
}

function stringsField(source: Record<string, unknown>, name: string): string[] {
  const value = source[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${CONFIG_PATH} carries no string list "${name}"`);
  }
  return value as string[];
}

export function readCommentDensityConfig(rootDir: string): CommentDensityConfig {
  const text = readFileSync(path.join(rootDir, CONFIG_PATH), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${CONFIG_PATH} is not a JSON object`);
  }
  const source = parsed as Record<string, unknown>;
  const marker = source["generatedMarker"];
  if (typeof marker !== "string") {
    throw new Error(`${CONFIG_PATH} carries no string "generatedMarker"`);
  }
  return {
    floor: numberField(source, "floor"),
    ceiling: numberField(source, "ceiling"),
    warnFloor: numberField(source, "warnFloor"),
    extensions: stringsField(source, "extensions"),
    excludedPaths: stringsField(source, "excludedPaths"),
    generatedMarker: marker,
  };
}

/** The smallest multiple of 5 at or above `value`. */
export function roundUpToFive(value: number): number {
  const rounded = Math.ceil((value - 1e-9) / 5) * 5;
  return rounded === 0 ? 0 : rounded;
}

/** Exact: the ratio is a fraction, and a comparison on it must not round. */
function over(measurement: FileMeasurement, threshold: number): boolean {
  return measurement.commentLines * 100 > threshold * measurement.countedLines;
}

/**
 * The bounds the committed thresholds may not break. Checked rather than
 * trusted, because the derivation is what stops a ceiling being raised to meet
 * whatever the tree happens to carry today.
 */
export function findThresholdFindings(
  config: CommentDensityConfig,
): CommentDensityFinding[] {
  const findings: CommentDensityFinding[] = [];
  if (config.ceiling > CAP) {
    findings.push({
      path: CONFIG_PATH,
      rule: "ceiling-over-cap",
      reference: String(config.ceiling),
      message:
        `commits a ceiling of ${config.ceiling} points, over the cap of ${CAP}. ` +
        "The cap is ported rather than derived, so no measurement of this tree " +
        "can raise a ceiling past it.",
    });
  }
  if (config.warnFloor !== config.ceiling - BAND) {
    findings.push({
      path: CONFIG_PATH,
      rule: "warn-floor-band",
      reference: String(config.warnFloor),
      message:
        `commits a warn floor of ${config.warnFloor}, which is not the ceiling ` +
        `of ${config.ceiling} minus the band of ${BAND}. A band that is not the ` +
        "ported one is a warning that fires somewhere nobody decided.",
    });
  }
  return findings;
}

export type CommentDensityReport = {
  measurements: FileMeasurement[];
  /** Above the warn floor and at or below the ceiling: reported, not refused. */
  warnings: FileMeasurement[];
  belowFloor: FileMeasurement[];
  excluded: Exclusion[];
  findings: CommentDensityFinding[];
};

/** The whole check over a real tree: the eligible set, then the thresholds. */
export function checkCommentDensity(
  rootDir: string,
  config: CommentDensityConfig,
): CommentDensityReport {
  const collected = collectCommentDensityFiles(rootDir, config);
  const measured = measureFiles(collected.files, config);
  const findings = [
    ...collected.findings,
    ...measured.findings,
    ...findThresholdFindings(config),
  ];

  for (const measurement of measured.measurements) {
    if (!over(measurement, config.ceiling)) continue;
    findings.push({
      path: measurement.path,
      rule: "over-ceiling",
      reference: measurement.ratio.toFixed(1),
      message:
        `${measurement.path} is ${measurement.ratio.toFixed(1)} percent prose ` +
        `(${measurement.commentLines} comment lines of ${measurement.countedLines} ` +
        `counted), over the committed ceiling of ${config.ceiling}. Say why once ` +
        "and delete the rest.",
    });
  }

  if (measured.measurements.length === 0) {
    findings.push({
      path: "",
      rule: "empty-eligible-set",
      reference: rootDir,
      message:
        "the eligible set is EMPTY, so this check has stopped looking rather " +
        "than found nothing over the ceiling. Either a path moved or an " +
        "exclusion widened; a clean sweep and a sweep that read nothing are " +
        "indistinguishable from their exit status alone.",
    });
  }

  return {
    measurements: measured.measurements,
    warnings: measured.measurements.filter(
      (measurement) =>
        over(measurement, config.warnFloor) && !over(measurement, config.ceiling),
    ),
    belowFloor: measured.belowFloor,
    excluded: measured.excluded,
    findings,
  };
}

/** The summary that tells a clean sweep apart from a sweep that never ran. */
export function summariseCommentDensity(
  report: CommentDensityReport,
  config: CommentDensityConfig,
): string {
  const worst = report.measurements[0];
  return (
    `comment-density: ${report.measurements.length} eligible file(s) swept, ` +
    `ceiling ${config.ceiling} points, warn floor ${config.warnFloor}, ` +
    `floor ${config.floor} counted lines, ` +
    `${report.belowFloor.length} file(s) under the floor, ` +
    `${report.excluded.length} excluded, ` +
    `${report.warnings.length} in the warn band` +
    (worst === undefined ? "" : `, worst ${worst.ratio.toFixed(1)} on ${worst.path}`)
  );
}

/* ------------------------------------------------------------------ *
 * The committed record
 * ------------------------------------------------------------------ */

function tableCells(line: string): string[] {
  return line.split("|").map((cell) => cell.trim());
}

/** The value of a `| label | value |` row, matched on the whole label. */
export function recordField(recordText: string, label: string): string | null {
  for (const line of recordText.split("\n")) {
    const cells = tableCells(line);
    if (cells.length >= 4 && cells[1] === label) return cells[2];
  }
  return null;
}

function sectionOf(recordText: string, heading: string): string {
  const lines = recordText.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

export type TrimRow = { path: string; before: number };

/** The trim set as the record lists it: a path and the ratio it carried. */
export function recordTrimRows(recordText: string): TrimRow[] {
  const rows: TrimRow[] = [];
  for (const line of sectionOf(recordText, "## The trim set").split("\n")) {
    const cells = tableCells(line);
    if (cells.length < 4) continue;
    const before = Number(cells[2]);
    if (!cells[1].endsWith(".ts") || !Number.isFinite(before)) continue;
    rows.push({ path: cells[1], before });
  }
  return rows;
}

/**
 * The record graded against the tree it describes: the ceiling follows from the
 * maximum it states, it names the command and the commit that reproduce it, and
 * every file it says was trimmed is now at or below the cap.
 */
export function findRecordFindings(
  recordText: string,
  config: CommentDensityConfig,
  measurements: readonly FileMeasurement[],
): CommentDensityFinding[] {
  const findings: CommentDensityFinding[] = [];
  const stated = recordField(recordText, "maximum ratio");
  const maximum = stated === null ? Number.NaN : Number(stated);

  if (!Number.isFinite(maximum)) {
    findings.push({
      path: RECORD_PATH,
      rule: "ceiling-not-derived",
      reference: stated ?? "",
      message:
        "states no maximum ratio, so the committed ceiling follows from " +
        "nothing anybody can re-derive.",
    });
  } else if (roundUpToFive(maximum) !== config.ceiling) {
    findings.push({
      path: RECORD_PATH,
      rule: "ceiling-not-derived",
      reference: stated ?? "",
      message:
        `states a maximum of ${maximum}, whose smallest multiple of 5 at or ` +
        `above is ${roundUpToFive(maximum)}, while ${CONFIG_PATH} commits a ` +
        `ceiling of ${config.ceiling}. A ceiling that is not the derivation is ` +
        "a number somebody picked.",
    });
  }

  if (!recordText.includes(REPORT_COMMAND)) {
    findings.push({
      path: RECORD_PATH,
      rule: "record-command",
      reference: REPORT_COMMAND,
      message:
        `names no command that reproduces its numbers. "${REPORT_COMMAND}" is ` +
        "what turns the measurement into something checkable rather than quoted.",
    });
  }

  const commit = recordField(recordText, "commit measured");
  if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) {
    findings.push({
      path: RECORD_PATH,
      rule: "record-commit",
      reference: commit ?? "",
      message:
        "names no commit it measured, so the numbers above belong to a tree " +
        "nobody can check out.",
    });
  }

  const rows = recordTrimRows(recordText);
  if (rows.length === 0 && !recordText.includes(EMPTY_TRIM_SENTENCE)) {
    findings.push({
      path: RECORD_PATH,
      rule: "record-trim-set",
      reference: "",
      message:
        "lists no trim set file by file and does not say, in those words, " +
        `"${EMPTY_TRIM_SENTENCE}". One of the two is what makes the trim a ` +
        "measurement rather than an edit somebody made.",
    });
  }

  const byPath = new Map(measurements.map((measurement) => [measurement.path, measurement]));
  for (const row of rows) {
    const measurement = byPath.get(row.path);
    if (measurement === undefined) {
      findings.push({
        path: row.path,
        rule: "record-trim-file",
        reference: row.before.toFixed(1),
        message:
          `is listed in the trim set and is not in the eligible set at all, so ` +
          "the record describes a tree this one is not.",
      });
      continue;
    }
    if (!over(measurement, CAP)) continue;
    findings.push({
      path: row.path,
      rule: "record-trim-file",
      reference: measurement.ratio.toFixed(1),
      message:
        `was trimmed from ${row.before.toFixed(1)} and is still ` +
        `${measurement.ratio.toFixed(1)} percent prose, over the cap of ${CAP}.`,
    });
  }

  return findings;
}

/** The record as committed, or a read failure rather than a silent pass. */
export function checkCommittedRecord(
  rootDir: string,
  config: CommentDensityConfig,
  measurements: readonly FileMeasurement[],
): CommentDensityFinding[] {
  let text: string;
  try {
    text = readFileSync(path.join(rootDir, RECORD_PATH), "utf8");
  } catch (error) {
    return [readFailure(RECORD_PATH, error)];
  }
  return findRecordFindings(text, config, measurements);
}
