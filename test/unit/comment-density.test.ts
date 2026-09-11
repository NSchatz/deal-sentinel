/**
 * The counter graded against samples planted to make each rule fire.
 *
 * Running the sweep over a compliant tree exits zero whether or not the
 * counting is right, so almost nothing here is graded that way: each rule is
 * shown RED against a sample, and the rule table and the demonstration table
 * are asserted to cover each other, so a rule that stops firing cannot hide.
 *
 * Every test name carries `comment-density`, which is what
 * `pnpm run test:comment-density` selects on.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BAND,
  CAP,
  COMMENT_DENSITY_RULES,
  CONFIG_PATH,
  CommentScanError,
  EMPTY_TRIM_SENTENCE,
  RECORD_PATH,
  REPORT_COMMAND,
  checkCommentDensity,
  checkCommittedRecord,
  collectCommentDensityFiles,
  describeCommentDensityFindings,
  findRecordFindings,
  findThresholdFindings,
  isGeneratedText,
  measureFiles,
  measureText,
  readCommentDensityConfig,
  recordTrimRows,
  roundUpToFive,
  summariseCommentDensity,
} from "../support/comment-density.ts";
import type {
  CommentDensityConfig,
  CommentDensityRule,
  FileMeasurement,
} from "../support/comment-density.ts";
import type { ScannedFile } from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLE_DIR = "test/fixtures/comment-density";

/** The thresholds as committed. Nothing here grades against a private copy. */
const CONFIG: CommentDensityConfig = readCommentDensityConfig(REPO_ROOT);
const RECORD = readFileSync(path.join(REPO_ROOT, RECORD_PATH), "utf8");

/** A planted sample, under the synthetic path that decides how it is read. */
function planted(name: string): ScannedFile {
  return {
    path: `planted/${name.replace(/\.fixture$/, "")}`,
    text: readFileSync(path.join(REPO_ROOT, SAMPLE_DIR, name), "utf8"),
  };
}

/** Refuse to grade a sample that no longer plants what it is named for. */
function plants(sample: ScannedFile, shapes: readonly string[]): void {
  for (const shape of shapes) {
    assert.ok(sample.text.includes(shape), `${sample.path} no longer plants ${shape}`);
  }
}

const wentRed = new Set<CommentDensityRule>();

function redOn(rule: CommentDensityRule, findings: readonly { rule: CommentDensityRule }[]): void {
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `nothing reported ${rule}`,
  );
  wentRed.add(rule);
}

/* ================================================================== *
 * Bytes that look like comments, and are not
 * ================================================================== */

describe("comment-density: comment-looking bytes that are not comments", () => {
  it("comment-density reads a URL, a string, a template literal and a regular expression as code", () => {
    const sample = planted("comment-looking-bytes.ts.fixture");
    plants(sample, [
      'https://example.com/docs//index.html',
      '"// not a comment',
      "`a /* not a comment */ b // nor this`",
      "/[//]/",
      "/https:\\/\\//",
      "// code first, so this line is code",
    ]);

    const measured = measureText(sample.path, sample.text);
    assert.equal(measured.commentLines, 0, "a byte in a literal was counted as prose");
    assert.equal(measured.countedLines, 26);
    assert.equal(measured.ratio, 0);
  });

  it("comment-density reads comment-looking JSX text as code and a JSX comment as prose", () => {
    const sample = planted("comment-looking-jsx.tsx.fixture");
    plants(sample, [
      "<p>// this is prose on a page, not a comment</p>",
      "<p>/* and neither is this */</p>",
      "/* this line is nothing but comment */",
    ]);

    const measured = measureText(sample.path, sample.text);
    assert.equal(measured.countedLines, 14);
    assert.equal(measured.commentLines, 1, "JSX text was counted as prose, or the comment was missed");
  });
});

/* ================================================================== *
 * What is prose, and what carries prose without being it
 * ================================================================== */

describe("comment-density: line comments, block comments and JSDoc are prose", () => {
  it("comment-density counts every line lying entirely inside a comment", () => {
    const sample = planted("narrated.ts.fixture");
    const measured = measureText(sample.path, sample.text);
    assert.equal(measured.countedLines, 17);
    assert.equal(measured.commentLines, 12);
    assert.equal(measured.ratio.toFixed(1), "70.6");
  });

  it("comment-density counts a line carrying code and a trailing comment as code", () => {
    const trailing = measureText("planted/trailing.ts", "const answer = 1; // why\n");
    assert.equal(trailing.countedLines, 1);
    assert.equal(trailing.commentLines, 0);
  });

  it("comment-density counts the continuation of a block opened on a code line as prose", () => {
    const opened = measureText(
      "planted/opened.ts",
      "const answer = 1; /* opened here\n   and this line is nothing else */\n",
    );
    assert.equal(opened.countedLines, 2);
    assert.equal(opened.commentLines, 1);
  });

  it("comment-density counts a blank line as neither", () => {
    const blanks = measureText("planted/blanks.ts", "const a = 1;\n\n   \n// why\n");
    assert.equal(blanks.countedLines, 2);
    assert.equal(blanks.commentLines, 1);
  });

  it("comment-density reaches the same verdict twice over the same text", () => {
    const sample = planted("narrated.ts.fixture");
    assert.deepEqual(measureText(sample.path, sample.text), measureText(sample.path, sample.text));
  });
});

/* ================================================================== *
 * What is not in the eligible set
 * ================================================================== */

describe("comment-density: the eligible set", () => {
  it("comment-density excludes a file under the floor at a ratio of 100", () => {
    const sample = planted("under-the-floor.ts.fixture");
    const measured = measureFiles([sample], CONFIG);
    assert.deepEqual(measured.measurements, []);
    assert.equal(measured.belowFloor.length, 1);
    assert.equal(measured.belowFloor[0].ratio, 100);
    assert.ok(measured.belowFloor[0].countedLines < CONFIG.floor);
  });

  it("comment-density excludes generated output the configuration names by marker", () => {
    const sample = planted("generated-output.ts.fixture");
    assert.ok(isGeneratedText(sample.path, sample.text, CONFIG.generatedMarker));

    const measured = measureFiles([sample], CONFIG);
    assert.deepEqual(measured.measurements, []);
    assert.equal(measured.excluded.length, 1);
    assert.match(measured.excluded[0].reason, /generated/);

    const asOrdinarySource = measureFiles([sample], {
      ...CONFIG,
      generatedMarker: "",
    });
    assert.ok(
      asOrdinarySource.measurements[0].ratio > CAP,
      "the sample no longer demonstrates an exclusion that matters",
    );
  });

  it("comment-density excludes a path the configuration names", () => {
    const sample = planted("over-the-ceiling.ts.fixture");
    const measured = measureFiles([sample], {
      ...CONFIG,
      excludedPaths: ["planted/"],
    });
    assert.deepEqual(measured.measurements, []);
    assert.equal(measured.excluded.length, 1);
    assert.match(measured.excluded[0].reason, /excludes/);
  });

  it("comment-density counts the marker only where a generator writes it", () => {
    const inTheBody = "export const note = 1;\n// @generated is mentioned here, in prose\n";
    assert.equal(isGeneratedText("planted/mention.ts", inTheBody, "@generated"), false);
  });

  it("comment-density does not read a planted sample as tree content", () => {
    const collected = collectCommentDensityFiles(REPO_ROOT, CONFIG);
    assert.deepEqual(collected.findings, [], describeCommentDensityFindings(collected.findings));
    assert.ok(collected.files.length > 0, "the sweep read nothing at all");
    assert.deepEqual(
      collected.files.filter((file) => file.path.endsWith(".fixture")).map((file) => file.path),
      [],
    );
    assert.deepEqual(
      collected.files.filter((file) => file.path.includes(SAMPLE_DIR)).map((file) => file.path),
      [],
    );
  });
});

/* ================================================================== *
 * Every refusal, demonstrated red
 * ================================================================== */

describe("comment-density: every refusal goes red against a planted sample", () => {
  it("comment-density refuses a file the tokenizer cannot finish reading", () => {
    const samples = [
      planted("unterminated-comment.ts.fixture"),
      planted("unterminated-string.ts.fixture"),
      planted("unterminated-template.ts.fixture"),
    ];
    const measured = measureFiles(samples, CONFIG);

    assert.deepEqual(measured.measurements, [], "a file that cannot be tokenized was scored");
    assert.deepEqual(measured.belowFloor, []);
    assert.equal(measured.findings.length, samples.length);
    for (const sample of samples) {
      const finding = measured.findings.find((candidate) => candidate.path === sample.path);
      assert.ok(finding !== undefined, `${sample.path} was skipped rather than refused`);
      assert.match(finding.message, /unterminated/);
      assert.match(finding.message, /not a file with no prose in it/);
    }
    redOn("tokenize-failed", measured.findings);
  });

  it("comment-density names the file and the reason when the tokenizer refuses", () => {
    const sample = planted("unterminated-comment.ts.fixture");
    assert.throws(
      () => measureText(sample.path, sample.text),
      (error: unknown) => {
        assert.ok(error instanceof CommentScanError);
        assert.equal(error.path, sample.path);
        assert.match(error.reason, /unterminated comment/);
        return true;
      },
    );
  });

  it("comment-density refuses a path the sweep cannot read rather than scoring it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "comment-density-"));
    try {
      writeFileSync(path.join(root, "readable.ts"), "export const answer = 1;\n");
      symlinkSync(path.join(root, "absent.ts"), path.join(root, "dangling.ts"));

      const locked = path.join(root, "locked.ts");
      writeFileSync(locked, "export const secret = 1;\n");
      chmodSync(locked, 0);
      let unreadable = true;
      try {
        readFileSync(locked, "utf8");
        unreadable = false;
      } catch {
        unreadable = true;
      }
      // A grader with the privilege to read anything is not shown a permission
      // denial, so the sample stops being one and the dangling link carries it.
      if (!unreadable) rmSync(locked);

      const collected = collectCommentDensityFiles(root, CONFIG);
      assert.deepEqual(
        collected.files.map((file) => file.path),
        ["readable.ts"],
        "a path that could not be read was collected as though it had been",
      );

      const refused = collected.findings.map((finding) => finding.path).sort();
      assert.deepEqual(refused, unreadable ? ["dangling.ts", "locked.ts"] : ["dangling.ts"]);
      for (const finding of collected.findings) {
        assert.equal(finding.rule, "read-failed");
        assert.notEqual(finding.reference, "");
        assert.match(finding.message, /could not be read/);
        assert.match(finding.message, /stopped looking/);
      }
      redOn("read-failed", collected.findings);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("comment-density refuses a tree it read nothing in", () => {
    const root = mkdtempSync(path.join(tmpdir(), "comment-density-empty-"));
    try {
      writeFileSync(path.join(root, "README.md"), "# nothing to count here\n");
      const report = checkCommentDensity(root, CONFIG);
      assert.deepEqual(report.measurements, []);
      const finding = report.findings.find((candidate) => candidate.path === "");
      assert.ok(finding !== undefined, "an empty sweep reported nothing at all");
      assert.match(finding.message, /stopped looking/);
      assert.match(finding.message, /EMPTY/);
      redOn("empty-eligible-set", report.findings);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * The thresholds, and the bounds they may not break
 * ================================================================== */

describe("comment-density: the committed thresholds", () => {
  it("comment-density accepts the committed configuration exactly as it stands", () => {
    const findings = findThresholdFindings(CONFIG);
    assert.deepEqual(findings, [], describeCommentDensityFindings(findings));
    assert.ok(CONFIG.ceiling <= CAP);
    assert.equal(CONFIG.warnFloor, CONFIG.ceiling - BAND);
  });

  it("comment-density refuses a ceiling raised past the cap", () => {
    const findings = findThresholdFindings({ ...CONFIG, ceiling: CAP + 5, warnFloor: CAP - 5 });
    const finding = findings.find((candidate) => candidate.rule === "ceiling-over-cap");
    assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
    assert.equal(finding.path, CONFIG_PATH);
    assert.match(finding.message, new RegExp(String(CAP + 5)));
    assert.match(finding.message, new RegExp(`cap of ${CAP}`));
    redOn("ceiling-over-cap", findings);
  });

  it("comment-density refuses a warn floor that is not the ceiling minus the band", () => {
    const findings = findThresholdFindings({ ...CONFIG, warnFloor: CONFIG.ceiling - 1 });
    const finding = findings.find((candidate) => candidate.rule === "warn-floor-band");
    assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
    assert.match(finding.message, new RegExp(String(CONFIG.ceiling - 1)));
    assert.match(finding.message, new RegExp(`band of ${BAND}`));
    redOn("warn-floor-band", findings);
  });

  it("comment-density rounds a maximum up to the next multiple of five", () => {
    assert.equal(roundUpToFive(0), 0);
    assert.equal(roundUpToFive(45), 45);
    assert.equal(roundUpToFive(45.1), 50);
    assert.equal(roundUpToFive(49.2), 50);
  });
});

/* ================================================================== *
 * Over the ceiling, and inside the band
 * ================================================================== */

/** A tree of planted samples, swept exactly as the repository is. */
function sweptTree(files: Record<string, string>, use: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "comment-density-tree-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(root, name), text);
    }
    use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("comment-density: the ceiling and the warn band", () => {
  it("comment-density refuses a file over the ceiling, naming it, its ratio and the ceiling", () => {
    sweptTree({ "over.ts": planted("over-the-ceiling.ts.fixture").text }, (root) => {
      const report = checkCommentDensity(root, CONFIG);
      const finding = report.findings.find((candidate) => candidate.rule === "over-ceiling");
      assert.ok(finding !== undefined, describeCommentDensityFindings(report.findings));
      assert.equal(finding.path, "over.ts");
      assert.match(finding.message, /over\.ts/);
      assert.match(finding.message, new RegExp(report.measurements[0].ratio.toFixed(1)));
      assert.match(finding.message, new RegExp(`ceiling of ${CONFIG.ceiling}`));
      redOn("over-ceiling", report.findings);
    });
  });

  it("comment-density reports a file in the warn band and does not fail on it", () => {
    const sample = planted("in-the-warn-band.ts.fixture");
    const measured = measureText(sample.path, sample.text);
    assert.ok(
      measured.ratio > CONFIG.warnFloor && measured.ratio <= CONFIG.ceiling,
      `the sample is ${measured.ratio.toFixed(1)}, outside the committed band of ` +
        `${CONFIG.warnFloor} to ${CONFIG.ceiling}: re-plant it`,
    );

    sweptTree({ "drifting.ts": sample.text }, (root) => {
      const report = checkCommentDensity(root, CONFIG);
      assert.deepEqual(report.findings, [], describeCommentDensityFindings(report.findings));
      assert.deepEqual(
        report.warnings.map((warning) => warning.path),
        ["drifting.ts"],
      );
      assert.match(summariseCommentDensity(report, CONFIG), /1 in the warn band/);
    });
  });

  it("comment-density leaves a fixture and a generated file out of a swept tree", () => {
    const overCeiling = planted("over-the-ceiling.ts.fixture").text;
    sweptTree(
      {
        "ordinary.ts": planted("in-the-warn-band.ts.fixture").text,
        "generated.ts": planted("generated-output.ts.fixture").text,
        "parked.ts.fixture": overCeiling,
      },
      (root) => {
        const report = checkCommentDensity(root, CONFIG);
        assert.deepEqual(
          report.measurements.map((measurement) => measurement.path),
          ["ordinary.ts"],
          "a parked sample or a generated file reached the eligible set",
        );
        assert.deepEqual(
          report.excluded.map((exclusion) => exclusion.path),
          ["generated.ts"],
        );
        assert.deepEqual(report.findings, [], describeCommentDensityFindings(report.findings));
      },
    );
  });

  it("comment-density counts the floor exclusions it made", () => {
    sweptTree(
      {
        "ordinary.ts": planted("in-the-warn-band.ts.fixture").text,
        "tiny.ts": planted("under-the-floor.ts.fixture").text,
      },
      (root) => {
        const report = checkCommentDensity(root, CONFIG);
        assert.deepEqual(
          report.belowFloor.map((measurement) => measurement.path),
          ["tiny.ts"],
        );
        assert.match(summariseCommentDensity(report, CONFIG), /1 file\(s\) under the floor/);
      },
    );
  });
});

/* ================================================================== *
 * The committed record
 * ================================================================== */

/** The record with one `| label | value |` row rewritten, or removed. */
function recordWithRow(label: string, value: string | null): string {
  const lines = RECORD.split("\n");
  const at = lines.findIndex((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    return cells.length >= 4 && cells[1] === label;
  });
  assert.notEqual(at, -1, `the record no longer carries a "${label}" row`);
  if (value === null) lines.splice(at, 1);
  else lines[at] = `| ${label} | ${value} |`;
  return lines.join("\n");
}

describe("comment-density: the committed record", () => {
  const measurements = checkCommentDensity(REPO_ROOT, CONFIG).measurements;

  it("comment-density accepts the committed record against the committed tree", () => {
    const findings = findRecordFindings(RECORD, CONFIG, measurements);
    assert.deepEqual(findings, [], describeCommentDensityFindings(findings));
    assert.equal(recordTrimRows(RECORD).length, 15);
  });

  it("comment-density refuses a ceiling the record's maximum does not derive", () => {
    for (const mutated of [recordWithRow("maximum ratio", null), recordWithRow("maximum ratio", "60.0")]) {
      const findings = findRecordFindings(mutated, CONFIG, measurements);
      const finding = findings.find((candidate) => candidate.rule === "ceiling-not-derived");
      assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
      assert.equal(finding.path, RECORD_PATH);
      redOn("ceiling-not-derived", findings);
    }
  });

  it("comment-density refuses a record naming no command that reproduces it", () => {
    const mutated = RECORD.split(REPORT_COMMAND).join("some other command");
    assert.notEqual(mutated, RECORD);
    const findings = findRecordFindings(mutated, CONFIG, measurements);
    const finding = findings.find((candidate) => candidate.rule === "record-command");
    assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
    assert.match(finding.message, /reproduces its numbers/);
    redOn("record-command", findings);
  });

  it("comment-density refuses a record naming no commit it measured", () => {
    for (const mutated of [
      recordWithRow("commit measured", null),
      recordWithRow("commit measured", "the tree as it was"),
    ]) {
      const findings = findRecordFindings(mutated, CONFIG, measurements);
      const finding = findings.find((candidate) => candidate.rule === "record-commit");
      assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
      redOn("record-commit", findings);
    }
  });

  it("comment-density refuses a record carrying neither a trim set nor the empty sentence", () => {
    const heading = "## The trim set";
    const at = RECORD.indexOf(heading);
    const next = RECORD.indexOf("\n## ", at + heading.length);
    const mutated = `${RECORD.slice(0, at)}${heading}\n\nNothing to say.\n${RECORD.slice(next)}`;
    assert.deepEqual(recordTrimRows(mutated), []);

    const findings = findRecordFindings(mutated, CONFIG, measurements);
    const finding = findings.find((candidate) => candidate.rule === "record-trim-set");
    assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
    assert.match(finding.message, new RegExp(EMPTY_TRIM_SENTENCE));
    redOn("record-trim-set", findings);

    const withSentence = `${mutated}\n\n${EMPTY_TRIM_SENTENCE}\n`;
    assert.deepEqual(
      findRecordFindings(withSentence, CONFIG, measurements).filter(
        (candidate) => candidate.rule === "record-trim-set",
      ),
      [],
      "the sentence the spec fixes was not accepted in place of a trim set",
    );
  });

  it("comment-density refuses a listed file that is still over the cap, or gone", () => {
    const listed = recordTrimRows(RECORD)[0];
    const stillOverCap: FileMeasurement[] = measurements.map((measurement) =>
      measurement.path === listed.path
        ? { ...measurement, commentLines: 80, countedLines: 100, ratio: 80 }
        : measurement,
    );
    const findings = findRecordFindings(RECORD, CONFIG, stillOverCap);
    const finding = findings.find((candidate) => candidate.rule === "record-trim-file");
    assert.ok(finding !== undefined, describeCommentDensityFindings(findings));
    assert.equal(finding.path, listed.path);
    assert.match(finding.message, new RegExp(`over the cap of ${CAP}`));
    redOn("record-trim-file", findings);

    const gone = measurements.filter((measurement) => measurement.path !== listed.path);
    const missing = findRecordFindings(RECORD, CONFIG, gone).find(
      (candidate) => candidate.rule === "record-trim-file",
    );
    assert.ok(missing !== undefined);
    assert.match(missing.message, /not in the eligible set/);
  });
});

/* ================================================================== *
 * The tree as it stands
 * ================================================================== */

describe("comment-density: the tree this repository commits", () => {
  const report = checkCommentDensity(REPO_ROOT, CONFIG);

  it("comment-density sweeps the committed tree and reports nothing over the ceiling", () => {
    console.log(summariseCommentDensity(report, CONFIG));
    assert.deepEqual(report.findings, [], describeCommentDensityFindings(report.findings));
    assert.ok(report.measurements.length > 0, "the sweep read nothing at all");
  });

  it("comment-density keeps the worst file inside the warn band, so the band is not vacuous", () => {
    const worst = report.measurements[0];
    assert.ok(worst.ratio > CONFIG.warnFloor, `the warn band is empty above ${CONFIG.warnFloor}`);
    assert.ok(worst.ratio <= CONFIG.ceiling);
    assert.equal(report.warnings[0]?.path, worst.path);
  });

  it("comment-density grades the committed record against the tree it describes", () => {
    const findings = checkCommittedRecord(REPO_ROOT, CONFIG, report.measurements);
    assert.deepEqual(findings, [], describeCommentDensityFindings(findings));
  });

  it("comment-density reaches the same verdict twice, reading committed text and nothing else", () => {
    assert.deepEqual(checkCommentDensity(REPO_ROOT, CONFIG), report);
  });
});

describe("comment-density: the rule table and the demonstrations cover each other", () => {
  it("comment-density demonstrated every rule it can report, and invented none", () => {
    assert.deepEqual(
      [...wentRed].sort(),
      [...COMMENT_DENSITY_RULES].sort(),
      "the rule table and the demonstration table have drifted apart",
    );
  });
});
