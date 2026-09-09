/**
 * Spec S0061-deal-sentinel-pinning-1: everything this repository resolves
 * carries a tag AND a digest, and the next unpinned reference reds
 * `pnpm run test` instead of waiting for a human to notice it.
 *
 * The umbrella's `documentation/pinning-conventions.md` is the normative text
 * and `test/support/pinning.ts` enforces it. This file grades the check the
 * way `no-direct-http.test.ts` grades its own: by proving it can FAIL before
 * believing that it passes. In order:
 *
 *   1. six committed offending samples, one per shape the convention names,
 *      each asserted RED with the rule and the clause it breaks;
 *   2. the compliant counterpart of each, asserted GREEN, so the check is not
 *      simply refusing everything it is shown;
 *   3. the four files this repository actually resolves an image from, taken
 *      VERBATIM off disk, mutated to remove the pin, and asserted red - which
 *      is the only evidence that the pass over the real tree means anything;
 *   4. the two categories with no referent here, asserted ABSENT BY NAME
 *      rather than counted as scanned, and the refusal that fires when any
 *      other category stops producing references;
 *   5. the tree as it stands, asserted clean, and asserted to have been read;
 *   6. the runtime refusal: a digestless override of either image variable is
 *      refused with status 3 before anything reaches docker.
 *
 * Nothing here opens a connection, starts a daemon or needs a credential. It
 * reads committed text, so a machine with no route to a registry reaches the
 * same verdict as one with.
 *
 * Every offending sample lives in `test/fixtures/pinning/` behind a `.fixture`
 * extension, for the reason the no-direct-http samples do: the real scan must
 * not read them as tree content, and this file must not become a finding of
 * the check it is grading. The fixture's TEXT is handed to `scanPinning` under
 * a synthetic path, and that path is what decides which rules apply.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  EXPECTED_ABSENT_CATEGORIES,
  KNOWN_IMAGE_NAMES,
  PINNING_CATEGORIES,
  UNPINNED_IMAGE_EXIT_CODE,
  UnpinnedImageError,
  checkRepositoryPinning,
  collectPinningFiles,
  describeImagePin,
  describePinningFindings,
  findEmptyCategories,
  gitignoreExcludes,
  requirePinnedImage,
  scanPinning,
} from "../support/pinning.ts";
import type {
  PinningCategory,
  PinningFinding,
  ScannedFile,
} from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** A committed sample, handed to the scan under the path that decides its rules. */
function sample(name: string, asPath: string): ScannedFile {
  return {
    path: asPath,
    text: readFileSync(path.join(REPO_ROOT, "test/fixtures/pinning", name), "utf8"),
  };
}

/** A real file of this repository, verbatim, under its own path. */
function committed(relativePath: string): ScannedFile {
  return {
    path: relativePath,
    text: readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  };
}

function rules(findings: readonly PinningFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

/* ================================================================== *
 * 1. Six shapes, six red demonstrations
 * ================================================================== */

type Demonstration = {
  shape: string;
  fixture: string;
  asPath: string;
  rule: string;
  clause: string;
  lines: number[];
};

const DEMONSTRATIONS: readonly Demonstration[] = [
  {
    shape: "a compose image: key with a tag and no digest",
    fixture: "compose-floating-image.yml.fixture",
    asPath: "docker-compose.yml",
    rule: "compose-image-pin",
    clause: "P1",
    lines: [8],
  },
  {
    shape: "a base image with a tag and no digest",
    fixture: "base-image-floating.containerfile.fixture",
    asPath: "Dockerfile",
    rule: "base-image-pin",
    clause: "P2",
    lines: [5],
  },
  {
    shape: "a workflow action named by a mutable tag",
    fixture: "workflow-mutable-tag.yml.fixture",
    asPath: ".github/workflows/ci.yml",
    rule: "action-sha-pin",
    clause: "P3",
    lines: [12, 13],
  },
  {
    shape: "a workflow action pinned to a SHA with no version comment",
    fixture: "workflow-sha-without-version.yml.fixture",
    asPath: ".github/workflows/ci.yml",
    rule: "action-version-comment",
    clause: "P3",
    lines: [12, 13],
  },
  {
    shape: "a manifest dependency carrying a range or latest on a registry name",
    fixture: "manifest-floating-range.json.fixture",
    asPath: "packages/sample/package.json",
    rule: "manifest-dependency-pin",
    clause: "P4",
    lines: [11, 12, 15, 16],
  },
  {
    shape: "lifecycle scripts enabled with no committed reason",
    fixture: "lifecycle-scripts-enabled.yaml.fixture",
    asPath: "pnpm-workspace.yaml",
    rule: "lifecycle-scripts-off",
    clause: "P4",
    lines: [9],
  },
];

describe("the check goes red against a committed sample of each shape", () => {
  const wentRed: string[] = [];

  for (const demonstration of DEMONSTRATIONS) {
    it(`rejects ${demonstration.shape}`, () => {
      const { findings } = scanPinning([
        sample(demonstration.fixture, demonstration.asPath),
      ]);

      assert.ok(
        findings.length > 0,
        `${demonstration.fixture} breaks ${demonstration.clause} and the check reported nothing`,
      );
      const matching = findings.filter((finding) => finding.rule === demonstration.rule);
      assert.ok(
        matching.length > 0,
        `reported ${rules(findings).join(", ")} rather than ${demonstration.rule}`,
      );
      assert.deepEqual(
        matching.map((finding) => finding.line),
        demonstration.lines,
        describePinningFindings(findings),
      );
      for (const finding of matching) {
        assert.equal(finding.clause, demonstration.clause);
        assert.equal(finding.path, demonstration.asPath);
        assert.notEqual(finding.reference, "");
      }
      wentRed.push(demonstration.shape);
    });
  }

  it("ran six demonstrations and every one of them went red", () => {
    // The count is the criterion: five shapes proved and one forgotten is a
    // rule nobody has ever seen fail.
    assert.equal(DEMONSTRATIONS.length, 6, "a shape was dropped from the table");
    assert.equal(
      wentRed.length,
      6,
      `only ${wentRed.length} of six demonstrations went red: ${wentRed.join(" | ")}`,
    );
  });
});

/* ================================================================== *
 * 2. The compliant counterparts, which must pass
 * ================================================================== */

describe("the check accepts the compliant form of every shape", () => {
  const accepted: [string, string, string][] = [
    ["a pinned compose image", "compose-pinned-image.yml.fixture", "docker-compose.yml"],
    ["a pinned base image, a stage name and scratch", "base-image-pinned.containerfile.fixture", "Dockerfile"],
    ["a SHA-pinned action with its version comment", "workflow-pinned.yml.fixture", ".github/workflows/ci.yml"],
    ["exact versions beside a workspace link", "manifest-exact-versions.json.fixture", "packages/sample/package.json"],
    ["lifecycle scripts left off", "lifecycle-scripts-npmrc-off.npmrc.fixture", ".npmrc"],
    ["a reason beginning with the opt-in phrase", "lifecycle-scripts-opt-in.yaml.fixture", "pnpm-workspace.yaml"],
    ["a shell script pinned in code and in its documentation block", "script-pinned-image.sh.fixture", "packages/db/scripts/sample.sh"],
    ["a source constant pinned beside a host and a libpq URL", "source-pinned-image.ts.fixture", "test/support/sample.ts"],
  ];

  for (const [what, fixture, asPath] of accepted) {
    it(`accepts ${what}`, () => {
      const { findings } = scanPinning([sample(fixture, asPath)]);
      assert.deepEqual(findings, [], describePinningFindings(findings));
    });
  }

  it("does not read a stage name or scratch as an image reference", () => {
    const { findings, categories } = scanPinning([
      sample("base-image-pinned.containerfile.fixture", "Dockerfile"),
    ]);
    assert.deepEqual(findings, [], describePinningFindings(findings));
    // One reference examined, not three: the platform flag, the stage name and
    // `scratch` are none of them things a registry resolves.
    const report = categories.find((entry) => entry.category === "dockerfile-from");
    assert.equal(report?.referencesFound, 1);
  });
});

/* ================================================================== *
 * The rules that only a shell script or a source file spells
 * ================================================================== */

describe("the check reads an image out of the positions a script spells one in", () => {
  it("reports the binding, the container-run argument and the documentation block", () => {
    const { findings } = scanPinning([
      sample("script-floating-image.sh.fixture", "packages/db/scripts/sample.sh"),
    ]);

    assert.deepEqual(
      findings.map((finding) => `${finding.rule}:${finding.line}`).sort(),
      [
        // The default inside the parameter expansion the runner takes.
        "image-binding-pin:13",
        // A literal handed to a container run, over shell continuations.
        "container-run-image-pin:20",
        // The promise in the documentation block, which is a code-position
        // check's blind spot and is exactly how an operator learns what to
        // export.
        "known-image-pin:6",
      ].sort(),
      describePinningFindings(findings),
    );
  });

  it("reports a source-level image constant, and nothing beside it", () => {
    const { findings } = scanPinning([
      sample("source-floating-image.ts.fixture", "test/support/sample.ts"),
    ]);
    assert.equal(findings.length, 1, describePinningFindings(findings));
    assert.equal(findings[0].rule, "image-binding-pin");
    assert.equal(findings[0].line, 4);
  });

  it("names the file, the line, the reference and the clause it breaks", () => {
    const { findings } = scanPinning([
      sample("compose-floating-image.yml.fixture", "docker-compose.yml"),
    ]);
    const [finding] = findings;
    assert.equal(finding.path, "docker-compose.yml");
    assert.equal(finding.line, 8);
    assert.equal(finding.reference, "redis:7-alpine");
    assert.equal(finding.clause, "P1");

    const described = describePinningFindings(findings);
    assert.match(described, /docker-compose\.yml:8/);
    assert.match(described, /P1 compose-image-pin/);
    assert.match(described, /redis:7-alpine/);
  });
});

describe("P1 is applied to the reference itself", () => {
  it("wants a tag as well as a digest, and a digest of the stated shape", () => {
    const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.equal(describeImagePin(`redis:7-alpine@${digest}`).pinned, true);
    // A registry port is not a tag, and a tag after a slash still is one.
    assert.equal(describeImagePin(`registry.local:5000/team/redis:7@${digest}`).pinned, true);
    assert.equal(describeImagePin("redis:7-alpine").pinned, false);
    assert.equal(describeImagePin(`redis@${digest}`).pinned, false);
    assert.equal(describeImagePin("redis:7-alpine@sha256:NOTHEX").pinned, false);
    assert.equal(describeImagePin(`redis:7-alpine@${digest.toUpperCase()}`).pinned, false);
  });
});

describe("P4 over the lifecycle-scripts setting", () => {
  it("reports an .npmrc that appears and sets the option nowhere at all", () => {
    const { findings } = scanPinning([
      sample("lifecycle-scripts-silent.npmrc.fixture", ".npmrc"),
    ]);
    assert.deepEqual(rules(findings), ["lifecycle-scripts-off"]);
    assert.match(findings[0].message, /sets ignore-scripts nowhere at all/);
  });

  it("reports a workspace file that no longer carries the setting", () => {
    const { findings } = scanPinning([
      { path: "pnpm-workspace.yaml", text: 'packages:\n  - "packages/*"\n' },
    ]);
    assert.deepEqual(rules(findings), ["lifecycle-scripts-off"]);
    assert.equal(findings[0].line, 0);
  });

  it("takes the opt-in reason only when it is beside the line it excuses", () => {
    const enabled = "packages:\n  - \"packages/*\"\n\nignoreScripts: false\n";
    const excusedFarAway =
      "# pinning-conventions P4 opt-in: written at the top and nowhere near it\n" +
      "packages:\n  - \"packages/*\"\n\nignoreScripts: false\n";
    assert.equal(scanPinning([{ path: "pnpm-workspace.yaml", text: enabled }]).findings.length, 1);
    assert.equal(
      scanPinning([{ path: "pnpm-workspace.yaml", text: excusedFarAway }]).findings.length,
      1,
      "a reason at the far end of the file is not one a reviewer of that line sees",
    );
  });
});

describe("P4 over the lockfile", () => {
  it("reports a .gitignore that excludes it, by glob", () => {
    const { findings } = scanPinning([
      sample("gitignore-excludes-lockfile.fixture", ".gitignore"),
      { path: "pnpm-lock.yaml", text: "lockfileVersion: '9.0'\n" },
    ]);
    assert.deepEqual(rules(findings), ["lockfile-committed"]);
  });

  it("reads this repository's own .gitignore as not excluding it", () => {
    assert.equal(gitignoreExcludes(committed(".gitignore").text, "pnpm-lock.yaml"), false);
    // The same reader, on the patterns that ARE there.
    assert.equal(gitignoreExcludes(committed(".gitignore").text, "node_modules"), true);
    assert.equal(gitignoreExcludes(committed(".gitignore").text, "backups"), true);
  });

  it("reports a tree with no lockfile at all", () => {
    const { findings } = scanPinning([{ path: "package.json", text: "{}" }], {
      treeLevel: true,
    });
    assert.ok(
      findings.some((finding) => finding.rule === "lockfile-committed"),
      describePinningFindings(findings),
    );
  });
});

/* ================================================================== *
 * 3. The real files, mutated. This is what makes the pass mean something.
 * ================================================================== */

describe("the four files this repository resolves an image from go red when unpinned", () => {
  const unpin = (text: string): string => text.replace(/@sha256:[0-9a-f]{64}/g, "");

  const resolvers: [string, string][] = [
    ["the compose stack", "docker-compose.yml"],
    ["the backup script", "packages/db/scripts/backup.sh"],
    ["the restore script", "packages/db/scripts/restore.sh"],
    ["the integration harness", "test/support/postgres-container.ts"],
  ];

  for (const [what, relativePath] of resolvers) {
    it(`reports ${what} with its digests stripped`, () => {
      const file = committed(relativePath);
      const mutated = { path: file.path, text: unpin(file.text) };
      assert.notEqual(mutated.text, file.text, `${relativePath} carries no digest to strip`);

      const { findings } = scanPinning([mutated]);
      assert.ok(
        findings.length > 0,
        `${relativePath} names an unpinned image and the check reported nothing`,
      );
      for (const finding of findings) {
        assert.equal(finding.path, relativePath);
        assert.equal(finding.clause, "P1");
      }
    });

    it(`accepts ${what} exactly as it is committed`, () => {
      const { findings } = scanPinning([committed(relativePath)]);
      assert.deepEqual(findings, [], describePinningFindings(findings));
    });
  }

  it("reports the root manifest with one dependency loosened to a range", () => {
    const file = committed("package.json");
    const mutated = {
      path: file.path,
      text: file.text.replace('"typescript": "5.7.2"', '"typescript": "^5.7.2"'),
    };
    assert.notEqual(mutated.text, file.text);
    const { findings } = scanPinning([mutated]);
    assert.deepEqual(rules(findings), ["manifest-dependency-pin"]);
    assert.match(findings[0].reference, /^typescript@/);
  });

  it("reports the workspace file with lifecycle scripts turned back on", () => {
    const file = committed("pnpm-workspace.yaml");
    const mutated = {
      path: file.path,
      text: file.text.replace("ignoreScripts: true", "ignoreScripts: false"),
    };
    assert.notEqual(mutated.text, file.text);
    const { findings } = scanPinning([mutated]);
    assert.deepEqual(rules(findings), ["lifecycle-scripts-off"]);
  });
});

/* ================================================================== *
 * 4. Absence asserted by name, and the refusal to accept an empty category
 * ================================================================== */

describe("a category is never silently unexamined", () => {
  const tree = checkRepositoryPinning(REPO_ROOT);
  const report = (category: PinningCategory) =>
    tree.categories.find((entry) => entry.category === category)!;

  it("asserts by name that this repository carries no Dockerfile", () => {
    // Not "the scan found no FROM lines": the assertion is that the category
    // has no FILE in it, which is a fact about the tree rather than a fact
    // about a pattern. A repository that grows one is scanned like any other,
    // and updating this line is the reviewable diff that says so.
    const dockerfiles = collectPinningFiles(REPO_ROOT).filter(
      (file) => /(?:^|\/)Dockerfile(?:\..+)?$/.test(file.path) || /\.Dockerfile$/.test(file.path),
    );
    assert.deepEqual(dockerfiles.map((file) => file.path), []);
    assert.equal(report("dockerfile-from").filesScanned, 0);
    assert.equal(report("dockerfile-from").assertedAbsent, true);
  });

  it("asserts by name that this repository carries no workflow", () => {
    const workflows = collectPinningFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith(".github/"),
    );
    assert.deepEqual(workflows.map((file) => file.path), []);
    assert.equal(report("workflow-uses").filesScanned, 0);
    assert.equal(report("workflow-uses").assertedAbsent, true);
  });

  it("names exactly those two as the categories legitimately empty here", () => {
    assert.deepEqual([...EXPECTED_ABSENT_CATEGORIES], ["dockerfile-from", "workflow-uses"]);
  });

  it("refuses every other category that produced nothing, naming it", () => {
    // A file moved, or a pattern stopped matching. The tree looks compliant
    // and the check has stopped looking, which P7 says is worse than no check.
    const empty = findEmptyCategories(scanPinning([]).categories);
    assert.deepEqual(
      empty.map((finding) => finding.reference).sort(),
      PINNING_CATEGORIES.filter(
        (category) => !EXPECTED_ABSENT_CATEGORIES.includes(category),
      )
        .slice()
        .sort(),
    );
    for (const finding of empty) {
      assert.equal(finding.clause, "P7");
      assert.equal(finding.rule, "empty-category");
      assert.match(finding.message, /stopped looking/);
    }
  });

  it("refuses a known image name that is suddenly found nowhere", () => {
    const { findings } = scanPinning([{ path: "docker-compose.yml", text: "services: {}\n" }], {
      treeLevel: true,
    });
    const unseen = findings.filter((finding) => finding.rule === "known-image-unseen");
    assert.deepEqual(
      unseen.map((finding) => finding.reference),
      [...KNOWN_IMAGE_NAMES],
    );
  });

  it("finds every category non-empty on the tree as it stands", () => {
    assert.deepEqual(
      findEmptyCategories(tree.categories).map((finding) => finding.reference),
      [],
    );
  });
});

/* ================================================================== *
 * 5. The tree as it stands
 * ================================================================== */

describe("the tree as it stands is pinned everywhere it resolves anything", () => {
  const files = collectPinningFiles(REPO_ROOT);

  it("read the repository, not an empty list", () => {
    // The pass below means nothing if the scan never opened the four files
    // that actually name an image, or the manifests, or the two settings.
    for (const expected of [
      "docker-compose.yml",
      "packages/db/scripts/backup.sh",
      "packages/db/scripts/restore.sh",
      "test/support/postgres-container.ts",
      "package.json",
      "packages/db/package.json",
      "packages/governor/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".gitignore",
    ]) {
      assert.ok(
        files.some((file) => file.path === expected),
        `the scan did not reach ${expected}`,
      );
    }
    assert.ok(files.length > 20, `only ${files.length} files were read`);
  });

  it("does not read the offending samples as tree content", () => {
    // They are held behind a `.fixture` extension precisely so the real scan
    // cannot mistake them for this repository.
    assert.deepEqual(
      files.filter((file) => file.path.startsWith("test/fixtures/")).map((file) => file.path),
      [],
    );
  });

  it("reports nothing at all", () => {
    const { findings } = checkRepositoryPinning(REPO_ROOT);
    assert.deepEqual(findings, [], describePinningFindings(findings));
  });

  it("reaches the same verdict twice, because it reads committed text and nothing else", () => {
    const first = checkRepositoryPinning(REPO_ROOT);
    const second = checkRepositoryPinning(REPO_ROOT);
    assert.deepEqual(first.findings, second.findings);
    assert.deepEqual(first.categories, second.categories);
  });

  it("reaches that same verdict in a process with every route to the network broken", () => {
    // Not "it looks like it does not connect": a child process is given a
    // proxy on a closed port for every scheme and an empty no-proxy list, so
    // any attempt to leave this machine fails rather than succeeding quietly,
    // and the verdict is compared against the one reached with a network.
    const moduleUrl = new URL("../support/pinning.ts", import.meta.url).href;
    const source =
      `const pinning = await import(${JSON.stringify(moduleUrl)});\n` +
      `const report = pinning.checkRepositoryPinning(${JSON.stringify(REPO_ROOT)});\n` +
      "process.stdout.write(JSON.stringify(report.findings));\n";

    const deadProxy = "http" + "://127.0.0.1:9";
    const outcome = spawnSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "--eval", source],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          http_proxy: deadProxy,
          https_proxy: deadProxy,
          HTTP_PROXY: deadProxy,
          HTTPS_PROXY: deadProxy,
          all_proxy: deadProxy,
          no_proxy: "",
          NO_PROXY: "",
        },
      },
    );

    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), []);
    assert.deepEqual(
      JSON.parse(outcome.stdout),
      JSON.parse(JSON.stringify(checkRepositoryPinning(REPO_ROOT).findings)),
    );
  });

  it("adds no .github directory, so nothing here asks a third party whether it is up", () => {
    // P8, and the other half of AC-11: rot is discovered when a build fails,
    // deliberately. A scheduled liveness check reds every unrelated pull
    // request the day a registry has a bad afternoon.
    assert.deepEqual(
      collectPinningFiles(REPO_ROOT).filter((file) => file.path.startsWith(".github/")),
      [],
    );
  });
});

/* ================================================================== *
 * 6. The runtime refusal
 * ================================================================== */

describe("a digestless override is refused before anything reaches docker", () => {
  it("throws for the harness variable, naming it, the reference and the clause", () => {
    const floating = "redis" + ":" + "7-alpine";
    assert.throws(
      () => requirePinnedImage(floating, "HISTORY_TEST_PG_IMAGE"),
      (error: unknown) => {
        assert.ok(error instanceof UnpinnedImageError);
        assert.equal(error.exitCode, UNPINNED_IMAGE_EXIT_CODE);
        assert.equal(error.exitCode, 3);
        assert.equal(error.variable, "HISTORY_TEST_PG_IMAGE");
        assert.equal(error.reference, floating);
        assert.match(error.message, /HISTORY_TEST_PG_IMAGE/);
        assert.match(error.message, /pinning-conventions P1/);
        assert.match(error.message, /before contacting docker/);
        assert.match(error.message, /Supply the digest/);
        return true;
      },
    );
  });

  it("accepts a pinned override and hands it straight back", () => {
    const pinned =
      "redis:7-alpine@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.equal(requirePinnedImage(pinned, "HISTORY_TEST_PG_IMAGE"), pinned);
  });

  const scripts: [string, string][] = [
    ["backup", "packages/db/scripts/backup.sh"],
    ["restore", "packages/db/scripts/restore.sh"],
  ];

  for (const [name, script] of scripts) {
    it(`exits 3 from ${name}.sh, which is neither success nor its usage error`, () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "ds-pin-"));
      const dump = path.join(scratch, "history.dump");
      writeFileSync(dump, "");

      const outcome = spawnSync("bash", [script, dump], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HISTORY_DATABASE_URL: "postgres://sentinel:secret@127.0.0.1:1/history",
          HISTORY_PG_RUNNER: "docker",
          HISTORY_PG_IMAGE: "redis" + ":" + "7-alpine",
        },
      });

      assert.equal(
        outcome.status,
        3,
        `expected the pin refusal, got status ${outcome.status}: ${outcome.stderr}`,
      );
      // 2 is this script's usage error and has been since it was written. A
      // pin failure that shared it would be indistinguishable from a typo.
      assert.notEqual(outcome.status, 2);
      assert.match(outcome.stderr, /HISTORY_PG_IMAGE/);
      assert.match(outcome.stderr, /no @sha256: digest/);
      assert.match(outcome.stderr, /pinning-conventions P1/);
      assert.match(outcome.stderr, /docs\/decisions\/0005-container-image-pinning\.md/);
    });

    it(`still exits 2 from ${name}.sh for its own usage error`, () => {
      const outcome = spawnSync("bash", [script, "/nonexistent/history.dump"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, HISTORY_DATABASE_URL: "", HISTORY_PG_RUNNER: "docker" },
      });
      assert.equal(outcome.status, 2, outcome.stderr);
    });
  }
});
