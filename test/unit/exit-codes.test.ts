/**
 * Spec S0135-deal-sentinel-exit-code-vocabulary: every command a caller can
 * invoke by name returns a status saying which KIND of failure happened.
 *
 * One case per acceptance criterion this suite can reach without a database,
 * each naming its criterion (`testing` T1, T2). The four that need a PostgreSQL
 * which really answers are in `test/integration/exit-codes.test.ts`.
 *
 * Every command is SPAWNED rather than imported. The exit status is the subject
 * here, and a status is a property of a process: importing the module would
 * grade a return value nobody's caller ever sees, and `cli` L1's whole claim is
 * about what survives when stderr was discarded.
 *
 * The environment each spawn gets is scrubbed of `HISTORY_DATABASE_URL` and of
 * every credential variable, so no case in this file can reach a configured
 * history and none of them passes because this machine happens to hold a key.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { EXIT_CODES, EXIT_CODE_MEANINGS } from "@deal-sentinel/shared";
import type { ExitCode } from "@deal-sentinel/shared";

import {
  UNPINNED_IMAGE_EXIT_CODE,
  UnpinnedImageError,
  requirePinnedImage,
} from "../support/pinning.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Nothing in this file may inherit one of these from the machine it runs on. */
const SCRUBBED = [
  "HISTORY_DATABASE_URL",
  "HISTORY_PG_RUNNER",
  "HISTORY_PG_IMAGE",
  "HISTORY_PG_NETWORK",
  "HISTORY_BACKUP_DIR",
  "HISTORY_TEST_PG_IMAGE",
  "BESTBUY_API_KEY",
  "DEAL_SENTINEL_ALERT_TOKEN",
];

type Outcome = { status: number | null; stdout: string; stderr: string };

type Command = {
  label: string;
  program: string;
  args: string[];
  /** Every code the spec asserts for this command (AC-11). */
  codes: ExitCode[];
  /** A distinctive fragment of its one runnable example. */
  exampleNames: string;
};

const DB_INIT: Command = {
  label: "pnpm db:init",
  program: "node",
  args: ["packages/db/src/cli/init.ts"],
  codes: [0, 1, 2, 3],
  exampleNames: "pnpm db:init",
};
const DB_START_CHECK: Command = {
  label: "pnpm db:start-check",
  program: "node",
  args: ["packages/db/src/cli/start-check.ts"],
  codes: [0, 1, 2, 3],
  exampleNames: "pnpm db:start-check",
};
const GOVERNOR: Command = {
  label: "pnpm governor:start-check",
  program: "node",
  args: ["packages/governor/src/cli/start-check.ts"],
  codes: [0, 1, 2, 3],
  exampleNames: "pnpm governor:start-check",
};
const SOURCES: Command = {
  label: "pnpm sources:start-check",
  program: "node",
  args: ["packages/sources/src/cli/start-check.ts"],
  codes: [0, 1, 2, 3],
  exampleNames: "pnpm sources:start-check",
};
const ALERTS: Command = {
  label: "pnpm alerts:start-check",
  program: "node",
  args: ["packages/alerts/src/cli/start-check.ts"],
  codes: [0, 1, 2, 3],
  exampleNames: "pnpm alerts:start-check",
};
const DENSITY: Command = {
  label: "pnpm comment-density:report",
  program: "node",
  args: ["test/support/comment-density-report.ts"],
  codes: [0, 1, 2, 4],
  exampleNames: "pnpm comment-density:report",
};
const BACKUP: Command = {
  label: "pnpm db:backup",
  program: "bash",
  args: ["packages/db/scripts/backup.sh"],
  codes: [0, 1, 2, 3],
  exampleNames: "packages/db/scripts/backup.sh backups/history.dump",
};
const RESTORE: Command = {
  label: "pnpm db:restore",
  program: "bash",
  args: ["packages/db/scripts/restore.sh"],
  codes: [0, 1, 2, 3],
  exampleNames: "packages/db/scripts/restore.sh backups/history.dump",
};

/** The eight invocable commands of the spec's `## Scope`, and nothing else. */
const EVERY_COMMAND: Command[] = [
  DB_INIT,
  DB_START_CHECK,
  GOVERNOR,
  SOURCES,
  ALERTS,
  DENSITY,
  BACKUP,
  RESTORE,
];

const CONFIG_COMMANDS: Command[] = [GOVERNOR, SOURCES, ALERTS];

function run(
  command: Command,
  extraArgs: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): Outcome {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED) delete clean[key];
  const outcome = spawnSync(command.program, [...command.args, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...clean, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: outcome.status,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
  };
}

const scratch: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `ds-exit-${label}-`));
  scratch.push(directory);
  return directory;
}

function fileHolding(label: string, text: string): string {
  const target = path.join(temporaryDirectory(label), `${label}.json`);
  writeFileSync(target, text);
  return target;
}

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/* ================================================================== *
 * AC-3: no connection string means no connection
 * ================================================================== */

describe("[AC-3] an absent HISTORY_DATABASE_URL is the caller's mistake", () => {
  // A directory that cannot exist. libpq reads PGHOST when a connection string
  // carries no host, so this path reaches stderr if and only if a connection
  // was attempted - which is what makes "attempt no connection" assertable
  // rather than merely stated.
  const SENTINEL_HOST = "/ds-no-such-socket-directory-7f3a";
  const probe = { PGHOST: SENTINEL_HOST, PGCONNECT_TIMEOUT: "3" };

  for (const command of [DB_INIT, DB_START_CHECK]) {
    for (const [shape, value] of [
      ["unset", undefined],
      ["empty", ""],
    ] as const) {
      it(`[AC-3] ${command.label} exits 2 and connects to nothing when it is ${shape}`, () => {
        const env: NodeJS.ProcessEnv = { ...probe };
        if (value !== undefined) env.HISTORY_DATABASE_URL = value;
        const outcome = run(command, [], env);

        assert.equal(outcome.status, 2, outcome.stderr);
        assert.match(outcome.stderr, /HISTORY_DATABASE_URL/);
        assert.equal(
          outcome.stderr.includes(SENTINEL_HOST),
          false,
          "the command reached libpq's default host, so it did attempt a connection",
        );
      });
    }

    it(`[AC-3] the same probe DOES name that host once ${command.label} is given a URL`, () => {
      // The control. Without it, "stderr does not mention the host" would pass
      // against a command that never mentions anything at all.
      const outcome = run(command, [], { ...probe, HISTORY_DATABASE_URL: "postgres://" });
      assert.equal(outcome.status, 1, outcome.stderr);
      assert.ok(
        outcome.stderr.includes(SENTINEL_HOST),
        `a connection was attempted and the host was not named: ${outcome.stderr}`,
      );
    });
  }
});

/* ================================================================== *
 * AC-4: a dependency that could not be reached is a stated state
 * ================================================================== */

describe("[AC-4] a history database that cannot be reached is 1, with the O4 record", () => {
  // Port 1 is reserved and nothing listens on it, so this is a real refused
  // connection rather than a double standing in for one (`testing` T3).
  const UNREACHABLE = "postgres://sentinel:hunter2@127.0.0.1:1/deal_sentinel_history";

  for (const command of [DB_INIT, DB_START_CHECK]) {
    it(`[AC-4] ${command.label} exits 1 and records the dependency and what it tried`, () => {
      const outcome = run(command, [], { HISTORY_DATABASE_URL: UNREACHABLE });

      assert.equal(outcome.status, 1, outcome.stderr);
      assert.match(outcome.stderr, /could not reach the history database/);
      assert.match(outcome.stderr, /dependency:.*127\.0\.0\.1:1/);
      assert.match(outcome.stderr, /tried:/);
      assert.match(outcome.stderr, /next:/);
      assert.match(outcome.stderr, /HISTORY_DATABASE_URL/);
      assert.equal(
        outcome.stderr.includes("hunter2"),
        false,
        "the record printed the password out of the connection string",
      );
    });
  }
});

/* ================================================================== *
 * AC-5 and AC-6: a configuration refused, against a path not read
 * ================================================================== */

describe("[AC-5] a configuration read and refused is 3", () => {
  for (const command of CONFIG_COMMANDS) {
    it(`[AC-5] ${command.label} exits 3 for a configuration short of a required value`, () => {
      const empty = fileHolding("short", "{}\n");
      const outcome = run(command, [empty]);

      assert.equal(outcome.status, 3, outcome.stderr);
      assert.match(outcome.stderr, /refusing to start/);
      assert.match(
        outcome.stderr,
        /required key "[^"]+"/,
        `the refusal named no missing value: ${outcome.stderr}`,
      );
    });

    it(`[AC-5] ${command.label} exits 3 for a configuration that will not parse`, () => {
      const broken = fileHolding("unparseable", "{ this is not json\n");
      const outcome = run(command, [broken]);

      assert.equal(outcome.status, 3, outcome.stderr);
      assert.match(outcome.stderr, /refusing to start/);
      assert.match(outcome.stderr, /parseable as JSON/);
    });
  }
});

describe("[AC-6] a path the caller named and this process cannot read is 2", () => {
  for (const command of CONFIG_COMMANDS) {
    it(`[AC-6] ${command.label} exits 2, names the path, and 2 is not its refusal code`, () => {
      const absent = path.join(temporaryDirectory("absent"), "not-here.json");
      const unreadable = run(command, [absent]);
      const refused = run(command, [fileHolding("short", "{}\n")]);

      assert.equal(unreadable.status, 2, unreadable.stderr);
      assert.ok(
        unreadable.stderr.includes(absent),
        `the refusal did not name the path: ${unreadable.stderr}`,
      );
      assert.equal(refused.status, 3, refused.stderr);
      assert.notEqual(
        unreadable.status,
        refused.status,
        "a path that was never read and a configuration that was read and " +
          "refused answer with the same code",
      );
    });
  }
});

/* ================================================================== *
 * AC-7: the invocation itself
 * ================================================================== */

describe("[AC-7] a wrong invocation is 2, with the usage on stderr", () => {
  for (const command of EVERY_COMMAND) {
    it(`[AC-7] ${command.label} exits 2 for an unrecognized flag`, () => {
      const outcome = run(command, ["--definitely-not-a-flag"]);

      assert.equal(outcome.status, 2, outcome.stderr);
      assert.match(outcome.stderr, /--definitely-not-a-flag/);
      assert.match(outcome.stderr, /usage:/);
      assert.equal(outcome.stdout, "", "the usage went to stdout (`cli` L2)");
    });
  }

  it("[AC-7] pnpm db:restore exits 2 when the argument it requires is absent", () => {
    const outcome = run(RESTORE, [], { HISTORY_DATABASE_URL: "postgres://u@h/d" });

    assert.equal(outcome.status, 2, outcome.stderr);
    assert.match(outcome.stderr, /missing required argument DUMP_FILE/);
    assert.match(outcome.stderr, /usage:/);
  });

  it("[AC-7] pnpm db:backup exits 2 when it is given more arguments than it takes", () => {
    const outcome = run(BACKUP, ["one.dump", "two.dump"], {
      HISTORY_DATABASE_URL: "postgres://u@h/d",
    });

    assert.equal(outcome.status, 2, outcome.stderr);
    assert.match(outcome.stderr, /takes at most 1/);
    assert.match(outcome.stderr, /usage:/);
  });
});

/* ================================================================== *
 * AC-8: reported and permitted keeps the gate open
 * ================================================================== */

describe("[AC-8] a condition a start-check reports but permits stays 0", () => {
  it("[AC-8] pnpm sources:start-check exits 0 with a source whose credential is absent", () => {
    const outcome = run(SOURCES);

    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /credential BESTBUY_API_KEY: ABSENT/);
    assert.match(outcome.stdout, /every other source will/);
  });

  it("[AC-8] pnpm alerts:start-check exits 0 with no channel configured", () => {
    const outcome = run(ALERTS);

    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /channel: NONE CONFIGURED/);
  });

  it("[AC-8] pnpm governor:start-check exits 0 on the committed configuration", () => {
    const outcome = run(GOVERNOR);

    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /is complete/);
  });
});

/* ================================================================== *
 * AC-9: a finding is not a failure to run
 * ================================================================== */

describe("[AC-9] comment-density:report answers 4 for a finding", () => {
  /** A tree with its own threshold file, one file in it, worst case chosen. */
  function tree(label: string, options: { config: boolean; prose: boolean }): string {
    const root = temporaryDirectory(label);
    if (options.config) {
      mkdirSync(path.join(root, "config"), { recursive: true });
      writeFileSync(
        path.join(root, "config/comment-density.json"),
        JSON.stringify({
          floor: 20,
          ceiling: 50,
          warnFloor: 40,
          extensions: [".ts"],
          excludedPaths: [],
          generatedMarker: "@generated",
        }),
      );
    }
    const prose = Array.from({ length: 24 }, (_, index) => `// line ${index}`);
    const code = Array.from({ length: 24 }, (_, index) => `export const v${index} = ${index};`);
    const body = options.prose ? [...prose, ...code.slice(0, 4)] : code;
    writeFileSync(path.join(root, "subject.ts"), `${body.join("\n")}\n`);
    return root;
  }

  it("[AC-9] exits 4 when the report carries at least one finding", () => {
    const outcome = run(DENSITY, [tree("finding", { config: true, prose: true })]);

    assert.equal(outcome.status, 4, `${outcome.stdout}${outcome.stderr}`);
    assert.match(outcome.stderr, /over the committed ceiling/);
  });

  it("[AC-9] exits 0 for the same tree with nothing over the ceiling", () => {
    const outcome = run(DENSITY, [tree("clean", { config: true, prose: false })]);

    assert.equal(outcome.status, 0, `${outcome.stdout}${outcome.stderr}`);
  });

  it("[AC-9] 4 is distinct from the code it returns when no report was produced", () => {
    const outcome = run(DENSITY, [tree("no-config", { config: false, prose: true })]);

    assert.equal(outcome.status, 1, `${outcome.stdout}${outcome.stderr}`);
    assert.match(outcome.stderr, /could not produce a report/);
    assert.notEqual(outcome.status, 4);
  });
});

/* ================================================================== *
 * AC-11: help publishes the contract
 * ================================================================== */

function exampleIn(help: string): string {
  const index = help.search(/^example:$/im);
  assert.ok(index >= 0, `no example section in:\n${help}`);
  return help.slice(index).split("\n").slice(1).join("\n").trim();
}

describe("[AC-11] --help prints every code this spec asserts, with its meaning", () => {
  for (const command of EVERY_COMMAND) {
    it(`[AC-11] ${command.label} --help exits 0 and publishes its contract`, () => {
      const outcome = run(command, ["--help"]);
      const help = outcome.stdout;

      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(help, /usage:/);
      assert.ok(help.includes("-h, --help"), `no flag list in:\n${help}`);

      for (const code of command.codes) {
        assert.ok(
          help.includes(`  ${code}  ${EXIT_CODE_MEANINGS[code]}`),
          `${command.label} does not publish ${code} with the meaning ` +
            `"${EXIT_CODE_MEANINGS[code]}":\n${help}`,
        );
      }
      for (const code of EXIT_CODES) {
        if (command.codes.includes(code)) continue;
        assert.equal(
          help.includes(`  ${code}  ${EXIT_CODE_MEANINGS[code]}`),
          false,
          `${command.label} publishes ${code}, which this spec does not assert for it`,
        );
      }

      const example = exampleIn(help);
      assert.ok(
        example.includes(command.exampleNames),
        `${command.label}'s example does not name it:\n${example}`,
      );
    });
  }

  it("[AC-11] -h is the same answer as --help", () => {
    for (const command of EVERY_COMMAND) {
      assert.deepEqual(run(command, ["-h"]).stdout, run(command, ["--help"]).stdout);
    }
  });
});

/* ================================================================== *
 * AC-12: the pin refusal, unchanged from the pinned tree
 * ================================================================== */

describe("[AC-12] a digestless image is still refused with 3", () => {
  const floating = "redis" + ":" + "7-alpine";

  for (const command of [BACKUP, RESTORE]) {
    it(`[AC-12] ${command.label} exits 3 for a digestless HISTORY_PG_IMAGE`, () => {
      const dump = path.join(temporaryDirectory("pin"), "history.dump");
      writeFileSync(dump, "");

      const outcome = run(command, [dump], {
        HISTORY_DATABASE_URL: "postgres://sentinel:secret@127.0.0.1:1/history",
        HISTORY_PG_RUNNER: "docker",
        HISTORY_PG_IMAGE: floating,
      });

      assert.equal(outcome.status, 3, outcome.stderr);
      assert.match(outcome.stderr, /no @sha256: digest/);
      assert.match(outcome.stderr, /pinning-conventions P1/);
    });
  }

  it("[AC-12] a digestless HISTORY_TEST_PG_IMAGE is refused with the same 3", () => {
    // The harness variable never reaches either script: it is refused where the
    // suite resolves it, so no test run can hand one of them an unpinned image.
    assert.throws(
      () => requirePinnedImage(floating, "HISTORY_TEST_PG_IMAGE"),
      (error: unknown) => {
        assert.ok(error instanceof UnpinnedImageError);
        assert.equal(error.exitCode, UNPINNED_IMAGE_EXIT_CODE);
        assert.equal(error.exitCode, 3);
        assert.equal(error.variable, "HISTORY_TEST_PG_IMAGE");
        return true;
      },
    );
  });
});

/* ================================================================== *
 * AC-13: the table a reader of this repository finds
 * ================================================================== */

describe("[AC-13] the repository's own CLAUDE.md carries the table", () => {
  it("[AC-13] names all five codes with the meaning Definitions gives each", () => {
    const text = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");

    for (const code of EXIT_CODES) {
      assert.ok(
        text.includes(`| ${code} | ${EXIT_CODE_MEANINGS[code]} |`),
        `CLAUDE.md carries no row for ${code} with the meaning ` +
          `"${EXIT_CODE_MEANINGS[code]}"`,
      );
    }
    assert.equal(EXIT_CODES.length, 5, "a code was dropped from the vocabulary");
  });
});
