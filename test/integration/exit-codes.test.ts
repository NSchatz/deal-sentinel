/**
 * Spec S0135-deal-sentinel-exit-code-vocabulary, the four criteria that need a
 * PostgreSQL which really answers: AC-1, AC-2, AC-10 and AC-14.
 *
 * Nothing here is simulated. "The database answered and the marker is not
 * there" (3) against "the database never answered" (1) is the distinction this
 * whole item exists to draw, and a double standing in for the database would
 * assert the implementation rather than the criterion (`testing` T3).
 *
 * THE DATABASE IS DISPOSABLE AND THIS FILE CANNOT REACH ANY OTHER. Every spawn
 * below is given a scrubbed environment and the URL of a database
 * `startDisposableHistory` created for this run and destroys after it, because
 * `pnpm db:restore` replaces the schema it is pointed at and a history nobody
 * can rebuild is not a thing to grade a test against.
 *
 * The cases run in declaration order: the start-check refusal is graded on the
 * empty database before anything initializes it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { NO_DATABASE, startDisposableHistory } from "../support/history-database.ts";
import type { DisposableHistory } from "../support/history-database.ts";
import { readMarkerRows, query } from "../support/seed.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SCRUBBED = [
  "HISTORY_DATABASE_URL",
  "HISTORY_PG_RUNNER",
  "HISTORY_PG_IMAGE",
  "HISTORY_PG_NETWORK",
  "HISTORY_BACKUP_DIR",
];

const INIT = ["node", "packages/db/src/cli/init.ts"];
const START_CHECK = ["node", "packages/db/src/cli/start-check.ts"];
const BACKUP = ["bash", "packages/db/scripts/backup.sh"];
const RESTORE = ["bash", "packages/db/scripts/restore.sh"];
const GOVERNOR = ["node", "packages/governor/src/cli/start-check.ts"];

const FLOATING_IMAGE = "redis" + ":" + "7-alpine";

const history: DisposableHistory | null = await startDisposableHistory("exit-codes");
const skip = history === null ? NO_DATABASE : false;

const scratch = mkdtempSync(path.join(tmpdir(), "ds-exit-int-"));

after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  if (history !== null) await history.stop();
}, { timeout: 120_000 });

type Outcome = { status: number | null; stdout: string; stderr: string };

function run(
  command: readonly string[],
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): Outcome {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED) delete clean[key];
  const [program, ...fixed] = command;
  const outcome = spawnSync(program, [...fixed, ...args], {
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

/** The disposable database, as the two Node commands address it. */
function againstHistory(): NodeJS.ProcessEnv {
  return { HISTORY_DATABASE_URL: history!.url };
}

/** The same database as the two shell scripts address it, with their runner. */
function scriptEnv(url = history!.scriptUrl): NodeJS.ProcessEnv {
  return { ...history!.scriptEnv, HISTORY_DATABASE_URL: url };
}

async function schemaObjects(): Promise<Record<string, string | null>> {
  const rows = await query(
    history!.url,
    "select to_regclass('public.price_observations')::text as observations, " +
      "to_regclass('public.history_initialization')::text as marker",
  );
  return rows[0];
}

describe("the history commands answer a database that really answers", { skip }, () => {
  it("[AC-1] db:start-check exits 3 on a reachable history with no marker, and creates nothing", async () => {
    const before = await schemaObjects();
    assert.deepEqual(
      before,
      { observations: null, marker: null },
      "the disposable database was not empty, so this grades nothing",
    );

    const outcome = run(START_CHECK, [], againstHistory());

    assert.equal(outcome.status, 3, outcome.stderr);
    assert.match(outcome.stderr, /public\.history_initialization/);
    assert.match(outcome.stderr, /refusing to start/i);
    assert.deepEqual(
      await schemaObjects(),
      { observations: null, marker: null },
      "the start path created a schema, which is the one thing it must never do",
    );
  });

  it("[AC-10] the same refusal re-invoked unchanged is the same 3 and never 1", async () => {
    const first = run(START_CHECK, [], againstHistory());
    const second = run(START_CHECK, [], againstHistory());

    assert.equal(first.status, 3, first.stderr);
    assert.equal(second.status, first.status);
    assert.notEqual(second.status, 1, "a scheduler would retry this forever");
    assert.equal(second.stderr, first.stderr, "the stated reason changed between runs");
  });

  it("initializes the history once, which is the setup the next case refuses", () => {
    const outcome = run(INIT, [], againstHistory());
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /history initialized at /);
  });

  it("[AC-2] db:init exits 3 against an initialized history, names the date, and writes nothing", async () => {
    const before = await readMarkerRows(history!.url);
    assert.equal(before.length, 1);

    const outcome = run(INIT, [], againstHistory());

    assert.equal(outcome.status, 3, outcome.stderr);
    assert.match(outcome.stderr, /already initialized at \d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      await readMarkerRows(history!.url),
      before,
      "the refused run changed the stored history",
    );
  });

  it("[AC-10] the already-initialized refusal re-invoked is the same 3 and never 1", async () => {
    const before = await readMarkerRows(history!.url);
    const first = run(INIT, [], againstHistory());
    const second = run(INIT, [], againstHistory());

    assert.equal(first.status, 3, first.stderr);
    assert.equal(second.status, first.status);
    assert.notEqual(second.status, 1);
    assert.equal(second.stderr, first.stderr);
    assert.deepEqual(await readMarkerRows(history!.url), before);
  });

  it("[AC-10] the configuration refusal re-invoked is the same 3 and never 1", () => {
    const short = path.join(scratch, "short.json");
    writeFileSync(short, "{}\n");

    const first = run(GOVERNOR, [short]);
    const second = run(GOVERNOR, [short]);

    assert.equal(first.status, 3, first.stderr);
    assert.equal(second.status, first.status);
    assert.notEqual(second.status, 1);
    assert.equal(second.stderr, first.stderr);
  });

  it("[AC-10] the digestless-image refusal re-invoked is the same 3 and never 1", () => {
    const dump = path.join(scratch, "pin.dump");
    writeFileSync(dump, "");
    const env = {
      HISTORY_DATABASE_URL: history!.scriptUrl,
      HISTORY_PG_RUNNER: "docker",
      HISTORY_PG_IMAGE: FLOATING_IMAGE,
    };

    for (const command of [BACKUP, RESTORE]) {
      const first = run(command, [dump], env);
      const second = run(command, [dump], env);

      assert.equal(first.status, 3, first.stderr);
      assert.equal(second.status, first.status);
      assert.notEqual(second.status, 1);
      assert.equal(second.stderr, first.stderr);
    }
  });

  it("[AC-14] db:backup exits 1 when its pg_dump step fails, distinct from its 2 and its 3", { timeout: 300_000 }, () => {
    const output = path.join(scratch, "unwritten.dump");
    // The same server, a database it does not have: pg_dump runs for real and
    // answers non-zero, which is what "its PostgreSQL client step failed" is.
    const absent = history!.scriptUrl.replace("deal_sentinel_history", "no_such_history");

    const stepFailure = run(BACKUP, [output], scriptEnv(absent));
    const usageError = run(BACKUP, [output], { ...history!.scriptEnv, HISTORY_DATABASE_URL: "" });
    const refusal = run(BACKUP, [output], {
      HISTORY_DATABASE_URL: history!.scriptUrl,
      HISTORY_PG_RUNNER: "docker",
      HISTORY_PG_IMAGE: FLOATING_IMAGE,
    });

    assert.equal(stepFailure.status, 1, stepFailure.stderr);
    assert.match(stepFailure.stderr, /the pg_dump step failed/);
    assert.equal(usageError.status, 2, usageError.stderr);
    assert.equal(refusal.status, 3, refusal.stderr);
  });

  it("[AC-14] db:restore exits 1 when its pg_restore step fails, distinct from its 2 and its 3", { timeout: 300_000 }, () => {
    const dump = path.join(scratch, "not-an-archive.dump");
    // Not a pg_dump archive. pg_restore reads the header, refuses it and exits
    // non-zero without altering the target.
    writeFileSync(dump, "this is not a pg_dump custom-format archive\n");

    const stepFailure = run(RESTORE, [dump], scriptEnv());
    const usageError = run(RESTORE, [dump], { ...history!.scriptEnv, HISTORY_DATABASE_URL: "" });
    const refusal = run(RESTORE, [dump], {
      HISTORY_DATABASE_URL: history!.scriptUrl,
      HISTORY_PG_RUNNER: "docker",
      HISTORY_PG_IMAGE: FLOATING_IMAGE,
    });

    assert.equal(stepFailure.status, 1, stepFailure.stderr);
    assert.match(stepFailure.stderr, /the pg_restore step failed/);
    assert.equal(usageError.status, 2, usageError.stderr);
    assert.equal(refusal.status, 3, refusal.stderr);
  });
});
