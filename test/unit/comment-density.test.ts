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
  CAP,
  COMMENT_DENSITY_RULES,
  CommentScanError,
  ELIGIBILITY_DEFAULTS,
  collectCommentDensityFiles,
  describeCommentDensityFindings,
  isGeneratedText,
  measureFiles,
  measureText,
} from "../support/comment-density.ts";
import type { CommentDensityRule } from "../support/comment-density.ts";
import type { ScannedFile } from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLE_DIR = "test/fixtures/comment-density";

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
    const measured = measureFiles([sample], ELIGIBILITY_DEFAULTS);
    assert.deepEqual(measured.measurements, []);
    assert.equal(measured.belowFloor.length, 1);
    assert.equal(measured.belowFloor[0].ratio, 100);
    assert.ok(measured.belowFloor[0].countedLines < ELIGIBILITY_DEFAULTS.floor);
  });

  it("comment-density excludes generated output the configuration names by marker", () => {
    const sample = planted("generated-output.ts.fixture");
    assert.ok(isGeneratedText(sample.path, sample.text, ELIGIBILITY_DEFAULTS.generatedMarker));

    const measured = measureFiles([sample], ELIGIBILITY_DEFAULTS);
    assert.deepEqual(measured.measurements, []);
    assert.equal(measured.excluded.length, 1);
    assert.match(measured.excluded[0].reason, /generated/);

    const asOrdinarySource = measureFiles([sample], {
      ...ELIGIBILITY_DEFAULTS,
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
      ...ELIGIBILITY_DEFAULTS,
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
    const collected = collectCommentDensityFiles(REPO_ROOT, ELIGIBILITY_DEFAULTS);
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
    const measured = measureFiles(samples, ELIGIBILITY_DEFAULTS);

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

      const collected = collectCommentDensityFiles(root, ELIGIBILITY_DEFAULTS);
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

  it("comment-density demonstrated every rule it can report, and invented none", () => {
    assert.deepEqual(
      [...wentRed].sort(),
      [...COMMENT_DENSITY_RULES].sort(),
      "the rule table and the demonstration table have drifted apart",
    );
  });
});
