/**
 * Spec S0062-deal-sentinel-ci-gate: the pull-request gate gates, and the next
 * change that quietly stops it gating reds `pnpm run test` instead of waiting
 * to be noticed by whoever eventually wonders why the merge button never lights.
 *
 * `test/support/ci-workflows.ts` holds the rules; this file grades the check the
 * way `pinning.test.ts` grades its own, by proving it can FAIL before believing
 * that it passes. In order:
 *
 *   1. every rule the module can report, demonstrated RED against a MUTATION OF
 *      A REAL COMMITTED WORKFLOW wherever a mutation can express it - not
 *      against an invented sample that resembles one. The rule table and the
 *      demonstration table are asserted to cover each other, so a rule that
 *      stops firing cannot hide;
 *   2. the committed workflows, verbatim, asserted GREEN, so the check is not
 *      simply refusing everything it is shown;
 *   3. the YAML reader itself, on the constructs a workflow is written in and
 *      on the ones it must refuse rather than misread - `on` staying the key
 *      `"on"` most of all, since a reader that turns it into `true` reports a
 *      confident green over a workflow whose triggers it never looked at;
 *   4. the skip refusal the `test` check run rests on, against TWO REAL
 *      CAPTURES of `node --test`, including one taken on a machine with no
 *      Docker - which exits 0 and reports `skipped 0` having run nothing;
 *   5. the tree as it stands, asserted clean, and asserted to have been read.
 *
 * Nothing here opens a connection, starts a container or needs a credential. It
 * reads committed text and captured output, so this file reaches the same
 * verdict on a machine with no route to GitHub as on one with. What it therefore
 * CANNOT establish - that a run really happened, that a runner really had a
 * daemon, that branch protection is really set - is graded on real runs and
 * recorded under `work/specs/S0062-deal-sentinel-ci-gate/probes/` in the
 * umbrella instead.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CI_RULES,
  DEFAULT_BRANCH,
  FULL_TEST_CONTEXT,
  REQUIRED_CONTEXTS,
  SKIP_REFUSAL_PATH,
  WorkflowParseError,
  checkCiWorkflows,
  collectCiWorkflows,
  contextNameOf,
  describeCiFindings,
  parseWorkflowYaml,
  readNodeFloor,
  scanCiWorkflows,
  stripYamlComment,
} from "../support/ci-workflows.ts";
import type { CiFinding, YamlNode } from "../support/ci-workflows.ts";
import {
  SKIPPED_TESTS_EXIT_CODE,
  findSkipMarkers,
  readTestRunSummary,
  refuseSkippedTests,
} from "../support/test-run-summary.ts";
import type { ScannedFile } from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const TEST_WORKFLOW = ".github/workflows/test.yml";
const TYPECHECK_WORKFLOW = ".github/workflows/typecheck.yml";

/** A real file of this repository, verbatim, under its own path. */
function committed(relativePath: string): ScannedFile {
  return {
    path: relativePath,
    text: readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  };
}

function capture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, "test/fixtures/ci-workflows", name), "utf8");
}

const NODE_FLOOR = (() => {
  const manifest = JSON.parse(committed("package.json").text) as {
    engines?: { node?: string };
  };
  const range = manifest.engines?.node ?? "";
  const floor = readNodeFloor(range);
  assert.ok(floor !== null, `package.json engines.node is "${range}", which this test cannot read`);
  return floor;
})();

function grade(files: readonly ScannedFile[], treeLevel = false): CiFinding[] {
  return scanCiWorkflows(files, { nodeFloor: NODE_FLOOR, treeLevel });
}

function rules(findings: readonly CiFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

/* ================================================================== *
 * 1. Every rule, demonstrated red
 * ================================================================== */

type Demonstration = {
  /** What somebody would plausibly be doing when they broke it. */
  shape: string;
  /** The rule this must report. Others may fire too; this one must. */
  rule: string;
  /** Applied to the named committed workflow, or to a synthetic tree. */
  break: (text: string) => string;
  file?: string;
};

/** Replace once, and refuse to continue if the target was not there. */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `the committed workflow no longer contains ${JSON.stringify(from)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const DEMONSTRATIONS: readonly Demonstration[] = [
  {
    shape: "a path filter added to make the gate cheaper on documentation changes",
    rule: "no-path-filter",
    break: (text) =>
      replaceOnce(text, "  pull_request:\n", "  pull_request:\n    paths:\n      - packages/**\n"),
  },
  {
    shape: "the push trigger dropped, leaving the branch's state inherited from pull requests",
    rule: "push-trigger",
    break: (text) => replaceOnce(text, "  push:\n    branches: [main]\n", ""),
  },
  {
    shape: "the pull_request trigger dropped",
    rule: "pull-request-trigger",
    break: (text) => replaceOnce(text, "  pull_request:\n    branches: [main]\n", ""),
  },
  {
    shape: "the trigger narrowed to a branch that is not the protected one",
    rule: "default-branch-covered",
    break: (text) => replaceOnce(text, "branches: [main]", "branches: [release]"),
  },
  {
    shape: "pull_request narrowed to types that leave out opened and synchronize",
    rule: "pull-request-types",
    break: (text) =>
      replaceOnce(text, "  pull_request:\n", "  pull_request:\n    types: [labeled]\n"),
  },
  {
    shape: "a job condition, which makes the required context skip instead of report",
    rule: "no-job-condition",
    break: (text) =>
      replaceOnce(text, "    runs-on:", "    if: github.ref != 'refs/heads/wip'\n    runs-on:"),
  },
  {
    shape: "a matrix, which renames every check run out from under the protection rule",
    rule: "no-matrix",
    break: (text) =>
      replaceOnce(
        text,
        "    runs-on:",
        "    strategy:\n      matrix:\n        node: [24.20.0]\n    runs-on:",
      ),
  },
  {
    shape: "continue-on-error, which reports success over work that failed",
    rule: "no-continue-on-error",
    break: (text) => replaceOnce(text, "    runs-on:", "    continue-on-error: true\n    runs-on:"),
  },
  {
    shape: "a step condition, so part of what the context claims is unproved",
    rule: "no-step-condition",
    break: (text) =>
      replaceOnce(
        text,
        "        run: pnpm install --frozen-lockfile",
        "        if: runner.os == 'Linux'\n        run: pnpm install --frozen-lockfile",
      ),
  },
  {
    shape: "the lockfile explicitly unfrozen",
    rule: "frozen-install",
    break: (text) =>
      replaceOnce(text, "pnpm install --frozen-lockfile", "pnpm install --no-frozen-lockfile"),
  },
  {
    shape: "the frozen flag simply dropped",
    rule: "frozen-install",
    break: (text) => replaceOnce(text, "pnpm install --frozen-lockfile", "pnpm install"),
  },
  {
    shape: "the setup action left to install for itself, with flags nobody can read",
    rule: "frozen-install",
    break: (text) => replaceOnce(text, "run_install: false", "run_install: true"),
  },
  {
    shape: "lifecycle scripts turned back on for the install",
    rule: "no-lifecycle-scripts",
    break: (text) =>
      replaceOnce(
        text,
        "run: pnpm install --frozen-lockfile",
        "run: pnpm config set ignore-scripts=false && pnpm install --frozen-lockfile",
      ),
  },
  {
    shape: "the install step removed, leaving the context resting on nothing",
    rule: "install-present",
    break: (text) =>
      replaceOnce(
        text,
        "      - name: Install exactly what the lockfile already names\n        run: pnpm install --frozen-lockfile\n",
        "",
      ),
  },
  {
    shape: "the test target quietly downgraded to the unit half",
    rule: "full-test-target",
    break: (text) => replaceOnce(text, "pnpm run test 2>&1", "pnpm run test:unit 2>&1"),
  },
  {
    shape: "the skip refusal dropped, so a run that ran nothing reports green",
    rule: "skip-refusal",
    break: (text) =>
      replaceOnce(
        text,
        `      - name: Refuse a green that skipped a test\n        run: node ${SKIP_REFUSAL_PATH} test-output.txt\n`,
        "",
      ),
  },
  {
    shape: "the bash shell lost, so a failing suite's status dies in the pipe",
    rule: "pipefail",
    break: (text) => replaceOnce(text, "    shell: bash\n", "    working-directory: .\n"),
  },
  {
    shape: "a runner whose hosted image carries no container daemon",
    rule: "container-capable-runner",
    break: (text) => replaceOnce(text, "runs-on: ubuntu-24.04", "runs-on: macos-14"),
  },
  {
    shape: "a moving runner label",
    rule: "pinned-runner",
    break: (text) => replaceOnce(text, "runs-on: ubuntu-24.04", "runs-on: ubuntu-latest"),
  },
  {
    shape: "a token that can write the contents it was asked to read",
    rule: "no-write-permission",
    break: (text) => replaceOnce(text, "  contents: read", "  contents: write"),
  },
  {
    shape: "write-all, which is every scope at once",
    rule: "no-write-permission",
    break: (text) => replaceOnce(text, "permissions:\n  contents: read", "permissions: write-all"),
  },
  {
    shape: "no permissions block at all, so the job takes the repository default",
    rule: "permissions-declared",
    break: (text) => replaceOnce(text, "permissions:\n  contents: read\n", ""),
  },
  {
    shape: "a secret put in reach of a job that reads no credential",
    rule: "no-secrets",
    break: (text) =>
      replaceOnce(
        text,
        "        run: pnpm install --frozen-lockfile",
        "        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: pnpm install --frozen-lockfile",
      ),
  },
  {
    shape: "a floating Node major, which is a different runtime every month",
    rule: "node-version-exact",
    break: (text) => replaceOnce(text, "node-version: 24.20.0", "node-version: 24"),
  },
  {
    shape: "a Node below this repository's own engines floor",
    rule: "node-version-floor",
    break: (text) => replaceOnce(text, "node-version: 24.20.0", "node-version: 20.11.0"),
  },
  {
    shape: "a floating pnpm major, with no packageManager field to fall back on",
    rule: "pnpm-version-exact",
    break: (text) => replaceOnce(text, "version: 11.25.0", "version: 11"),
  },
  {
    shape: "a workflow this reader cannot parse, which is a workflow it is not grading",
    rule: "workflow-readable",
    break: (text) => replaceOnce(text, "permissions:\n", "permissions:\npermissions:\n"),
  },
];

describe("every rule goes red against a mutation of a real committed workflow", () => {
  const wentRed = new Set<string>();

  for (const demonstration of DEMONSTRATIONS) {
    it(`reports ${demonstration.shape}`, () => {
      const file = committed(demonstration.file ?? TEST_WORKFLOW);
      const mutated = { path: file.path, text: demonstration.break(file.text) };
      assert.notEqual(mutated.text, file.text, "the mutation changed nothing");

      const findings = grade([mutated]);
      assert.ok(findings.length > 0, `${demonstration.shape} was accepted`);
      assert.ok(
        rules(findings).includes(demonstration.rule),
        `reported ${rules(findings).join(", ")} rather than ${demonstration.rule}\n` +
          describeCiFindings(findings),
      );
      for (const finding of findings) {
        assert.equal(finding.path, mutated.path);
        assert.notEqual(finding.reference, "");
        assert.notEqual(finding.message, "");
      }
      wentRed.add(demonstration.rule);
    });
  }

  it("reports a tree carrying no workflow at all", () => {
    const findings = scanCiWorkflows([], { nodeFloor: NODE_FLOOR, treeLevel: true });
    assert.ok(rules(findings).includes("workflows-present"), describeCiFindings(findings));
    wentRed.add("workflows-present");
  });

  it("reports a required context that no job produces, and one that two do", () => {
    const missing = scanCiWorkflows([committed(TYPECHECK_WORKFLOW)], {
      nodeFloor: NODE_FLOOR,
      treeLevel: true,
    }).filter((finding) => finding.rule === "required-context-produced");
    assert.deepEqual(missing.map((finding) => finding.reference), [FULL_TEST_CONTEXT]);
    assert.match(missing[0].message, /no committed job/);

    const twice = committed(TEST_WORKFLOW);
    const duplicated = scanCiWorkflows(
      [twice, { path: ".github/workflows/test-again.yml", text: twice.text }],
      { nodeFloor: NODE_FLOOR, treeLevel: true },
    ).filter((finding) => finding.rule === "required-context-produced");
    assert.ok(
      twice.text.includes("name: test"),
      "the committed workflow no longer names the test context",
    );
    assert.ok(
      twice.text.length > 0 &&
        twice.text.includes("jobs:") &&
        duplicated.some((finding) => finding.reference === FULL_TEST_CONTEXT),
      describeCiFindings(duplicated),
    );
    assert.match(
      duplicated.find((finding) => finding.reference === FULL_TEST_CONTEXT)!.message,
      /2 jobs produce a check run by that name/,
    );
    wentRed.add("required-context-produced");
  });

  it("demonstrated every rule the module can report, and invented none", () => {
    // The count is the criterion: twenty-five rules proved and one forgotten is
    // a rule nobody has ever seen fail, which is a rule that may not work.
    assert.deepEqual(
      [...wentRed].sort(),
      [...CI_RULES].sort(),
      "the rule table and the demonstration table have drifted apart",
    );
  });
});

/* ================================================================== *
 * 2. The committed workflows, exactly as they are
 * ================================================================== */

describe("the committed workflows are accepted exactly as they stand", () => {
  for (const relativePath of [TEST_WORKFLOW, TYPECHECK_WORKFLOW]) {
    it(`accepts ${relativePath}`, () => {
      const findings = grade([committed(relativePath)]);
      assert.deepEqual(findings, [], describeCiFindings(findings));
    });
  }

  it("names the check runs the default branch is protected on", () => {
    const produced = collectCiWorkflows(REPO_ROOT).flatMap((file) => {
      const document = parseWorkflowYaml(file.text) as { jobs: Record<string, never> };
      return Object.entries(document.jobs).map(([id, job]) => contextNameOf(id, job));
    });
    assert.deepEqual(produced.slice().sort(), [...REQUIRED_CONTEXTS].sort());
  });

  it("triggers both of them on the default branch, by pull request and by push", () => {
    for (const file of collectCiWorkflows(REPO_ROOT)) {
      const document = parseWorkflowYaml(file.text) as Record<string, YamlNode>;
      const on = document["on"] as Record<string, YamlNode>;
      assert.deepEqual(Object.keys(on).sort(), ["pull_request", "push"], file.path);
      for (const event of ["pull_request", "push"]) {
        const filters = on[event] as Record<string, YamlNode>;
        assert.deepEqual(filters["branches"], [DEFAULT_BRANCH], `${file.path} ${event}`);
        assert.equal(filters["paths"], undefined, `${file.path} ${event} carries a path filter`);
        assert.equal(filters["paths-ignore"], undefined, `${file.path} ${event}`);
      }
    }
  });
});

/* ================================================================== *
 * 3. The YAML reader, on what it claims to read and what it refuses
 * ================================================================== */

describe("the reader reads the workflow constructs, and refuses the rest", () => {
  it("keeps `on` as the key `on`, and never as the boolean a YAML 1.1 reader makes of it", () => {
    // This is the single most common way a workflow grader silently stops
    // looking: `on` is a YAML 1.1 boolean, so a reader that resolves it hands
    // back a document keyed `true` and every trigger rule quietly matches
    // nothing at all while reporting a confident green.
    const document = parseWorkflowYaml("on:\n  push:\n    branches: [main]\n") as Record<
      string,
      YamlNode
    >;
    assert.deepEqual(Object.keys(document), ["on"]);
    assert.equal(document["true"], undefined);
    assert.deepEqual(document["on"], { push: { branches: ["main"] } });
  });

  it("reads a sequence of steps, each a mapping opened on its own dash line", () => {
    const document = parseWorkflowYaml(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: owner/action@0123456789abcdef0123456789abcdef01234567 # v1.2.3",
        "        with:",
        "          key: value",
        "      - name: second",
        "        run: echo hi",
        "",
      ].join("\n"),
    ) as { jobs: { build: { steps: Record<string, YamlNode>[] } } };
    assert.equal(document.jobs.build.steps.length, 2);
    assert.equal(
      document.jobs.build.steps[0]["uses"],
      "owner/action@0123456789abcdef0123456789abcdef01234567",
    );
    assert.deepEqual(document.jobs.build.steps[0]["with"], { key: "value" });
    assert.equal(document.jobs.build.steps[1]["run"], "echo hi");
  });

  it("reads a block scalar verbatim, shell comments and all", () => {
    const document = parseWorkflowYaml(
      ["steps:", "  - run: |", "      # not a YAML comment", "      echo one", "      echo two", ""].join(
        "\n",
      ),
    ) as { steps: Record<string, YamlNode>[] };
    assert.equal(document.steps[0]["run"], "# not a YAML comment\necho one\necho two");
  });

  it("strips a trailing comment and leaves a hash inside quotes alone", () => {
    assert.equal(stripYamlComment("  uses: owner/a@sha # v1"), "  uses: owner/a@sha");
    assert.equal(stripYamlComment('  run: echo "a # b"'), '  run: echo "a # b"');
    assert.equal(stripYamlComment("# whole line"), "");
    assert.equal(stripYamlComment("  name: sharp#not-a-comment"), "  name: sharp#not-a-comment");
  });

  it("refuses a duplicate key rather than silently taking one of them", () => {
    assert.throws(
      () => parseWorkflowYaml("permissions:\n  contents: read\n  contents: write\n"),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowParseError);
        assert.equal(error.line, 3);
        return true;
      },
    );
  });

  it("refuses an unclosed flow collection, and an anchor it cannot follow", () => {
    assert.throws(() => parseWorkflowYaml("on:\n  push:\n    branches: [main\n"), WorkflowParseError);
    assert.throws(() => parseWorkflowYaml("---\non: [push]\n"), WorkflowParseError);
  });

  it("turns a file it cannot read into a finding rather than an exception", () => {
    const findings = grade([{ path: TEST_WORKFLOW, text: "on:\n  push:\n    branches: [main\n" }]);
    assert.deepEqual(rules(findings), ["workflow-readable"]);
    assert.match(findings[0].message, /stopped looking/);
  });
});

/* ================================================================== *
 * 4. The skip refusal, against two real captures
 * ================================================================== */

describe("a run that skipped something is refused, however it skipped it", () => {
  const green = capture("test-run-green.txt.fixture");
  const dockerAbsent = capture("test-run-docker-absent.txt.fixture");

  it("accepts a real green run and reads its counts", () => {
    const summary = readTestRunSummary(green);
    assert.notEqual(summary, null);
    assert.equal(summary!.fail, 0);
    assert.equal(summary!.skipped, 0);
    assert.ok(summary!.pass > 0);
    assert.deepEqual(findSkipMarkers(green), []);
    assert.equal(refuseSkippedTests(green, "a green run"), null);
  });

  it("refuses a real run taken where no container daemon existed", () => {
    // The trap this whole check exists for, and it is not hypothetical: this is
    // a capture of one of the three Docker-guarded suites on a machine with no
    // Docker. Read the summary it printed - `skipped 0` - and the status it
    // exited with - zero. The count alone would have called this green.
    const summary = readTestRunSummary(dockerAbsent);
    assert.notEqual(summary, null);
    assert.equal(summary!.skipped, 0, "the capture no longer demonstrates the trap");
    assert.equal(summary!.fail, 0);
    assert.equal(summary!.tests, 0);

    const markers = findSkipMarkers(dockerAbsent);
    assert.equal(markers.length, 1);
    assert.match(markers[0], /cannot start a container/);

    const refusal = refuseSkippedTests(dockerAbsent, "a run with no daemon");
    assert.notEqual(refusal, null);
    assert.match(refusal!, /did not run/);
    assert.match(refusal!, /skipped SUITE never reaches that count/);
  });

  it("refuses output carrying no summary at all, rather than assuming it was fine", () => {
    assert.notEqual(refuseSkippedTests("", "empty output"), null);
    assert.notEqual(refuseSkippedTests("ℹ pass 3\n", "a truncated capture"), null);
    assert.match(refuseSkippedTests("", "empty output")!, /not evidence/);
  });

  it("refuses a summary in which every test was cancelled", () => {
    const cancelled = green
      .replace("ℹ pass 7", "ℹ pass 5")
      .replace("ℹ cancelled 0", "ℹ cancelled 2");
    assert.notEqual(cancelled, green);
    assert.notEqual(refuseSkippedTests(cancelled, "a cancelled run"), null);
  });

  it("does not mistake a test whose name ends in a number for a count", () => {
    const noisy = `✔ retries 3 times before giving up 4\n${green}`;
    const summary = readTestRunSummary(noisy);
    assert.deepEqual(summary, readTestRunSummary(green));
  });
});

describe("the command the workflow actually calls exits with a status that names why", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SKIP_REFUSAL_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

  it("exits 0 over a real green run, printing the counts it read", () => {
    const outcome = run("test/fixtures/ci-workflows/test-run-green.txt.fixture");
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /0 skipped/);
  });

  it("exits 4 over the capture taken with no container daemon", () => {
    const outcome = run("test/fixtures/ci-workflows/test-run-docker-absent.txt.fixture");
    assert.equal(outcome.status, SKIPPED_TESTS_EXIT_CODE, outcome.stdout);
    assert.equal(outcome.status, 4);
    // 2 is this command's usage error. A skip that shared it would be
    // indistinguishable from a typo in the workflow.
    assert.notEqual(outcome.status, 2);
    assert.match(outcome.stderr, /did not run/);
  });

  it("still exits 2 for its own usage error", () => {
    assert.equal(run().status, 2);
    assert.equal(run("/nonexistent/capture.txt").status, 2);
    assert.match(run().stderr, /usage:/);
  });
});

/* ================================================================== *
 * 5. The tree as it stands
 * ================================================================== */

describe("the workflows this repository actually commits are gated", () => {
  const workflows = collectCiWorkflows(REPO_ROOT);

  it("found them by scanning the directory, not by naming them", () => {
    // The pass below means nothing if the scan never opened a file. Both
    // committed workflows are expected here, but the collector reached them by
    // reading `.github/workflows/`, so one added tomorrow is graded the moment
    // it is committed rather than the moment somebody remembers this list.
    assert.deepEqual(
      workflows.map((file) => file.path),
      [TEST_WORKFLOW, TYPECHECK_WORKFLOW],
    );
    for (const file of workflows) assert.ok(file.text.length > 0, `${file.path} is empty`);
  });

  it("does not read the captured samples as tree content", () => {
    assert.deepEqual(
      workflows.filter((file) => file.path.includes("fixtures")).map((file) => file.path),
      [],
    );
  });

  it("reports nothing at all", () => {
    const findings = checkCiWorkflows(REPO_ROOT, NODE_FLOOR);
    assert.deepEqual(findings, [], describeCiFindings(findings));
  });

  it("reaches the same verdict twice, because it reads committed text and nothing else", () => {
    assert.deepEqual(
      checkCiWorkflows(REPO_ROOT, NODE_FLOOR),
      checkCiWorkflows(REPO_ROOT, NODE_FLOOR),
    );
  });

  it("commits the command its own test job calls, at the path the workflow names", () => {
    // A workflow step referring to a file nobody committed is a red check run
    // that says nothing about the code, and it would not be caught by any rule
    // that only reads YAML.
    assert.ok(
      readFileSync(path.join(REPO_ROOT, SKIP_REFUSAL_PATH), "utf8").length > 0,
      `${SKIP_REFUSAL_PATH} is named by the test workflow and is not committed`,
    );
    assert.ok(committed(TEST_WORKFLOW).text.includes(SKIP_REFUSAL_PATH));
  });

  it("keeps the committed workflow clean of the pattern its own rules forbid", () => {
    // Belt and braces on the one rule that is a plain text scan: no committed
    // workflow may mention a secret at all.
    for (const file of workflows) {
      assert.ok(!/\bsecrets\s*\./.test(file.text), `${file.path} reaches for a secret`);
    }
  });
});
