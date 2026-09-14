/**
 * A disposable history database for the integration suite, and NOTHING ELSE.
 *
 * The exit-code criteria have to be graded against a PostgreSQL that really
 * answers: "the marker is missing" and "the database is unreachable" are the
 * two states this repository's start gate exists to tell apart, and a double
 * standing in for the subject would assert the implementation rather than the
 * criterion (`testing` T3).
 *
 * It is disposable BY CONSTRUCTION. Nothing here reads `HISTORY_DATABASE_URL`:
 * `pnpm db:restore` replaces the schema it is pointed at, and a suite that
 * could reach a configured history would be one bad environment away from
 * overwriting a record no re-run rebuilds.
 *
 * Two ways to get one, in this order:
 *
 *   1. the docker container harness the rest of this suite uses, which is what
 *      CI runs;
 *   2. a PostgreSQL cluster started from `initdb` and `pg_ctl` on PATH, in a
 *      temporary directory, listening on a unix socket and no TCP port at all.
 *      That is the route on a machine whose Docker cannot start a container -
 *      a sandbox without the kernel features one needs, say - and it keeps
 *      these criteria graded there rather than skipped.
 *
 * Neither exists: the caller is told so and skips honestly.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  POSTGRES_IMAGE,
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "./postgres-container.ts";

const execFile = promisify(execFileCallback);

export const DB_NAME = "deal_sentinel_history";
export const DB_ROLE = "sentinel";

export type DisposableHistory = {
  /** libpq URL of a database this suite created and will destroy. */
  url: string;
  /**
   * The same database as the backup and restore scripts must address it. The
   * docker runner reaches it by container name from another container, which is
   * not the URL this process uses.
   */
  scriptUrl: string;
  /** `HISTORY_PG_*` settings those two scripts need to reach `scriptUrl`. */
  scriptEnv: Record<string, string>;
  /** How it was obtained, for the message a failing assertion prints. */
  how: "docker" | "local-cluster";
  stop: () => Promise<void>;
};

export const NO_DATABASE =
  "no disposable PostgreSQL is reachable here: this machine's Docker cannot " +
  "start a container and the PostgreSQL programs are not on PATH, so a " +
  "criterion that needs a database that really answers cannot be graded";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "(the server wrote no log)";
  }
}

async function onPath(program: string): Promise<boolean> {
  try {
    await execFile(program, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A cluster in a temporary directory, speaking over a unix socket. The socket
 * keeps it off every TCP port, so two of these never collide and neither one
 * is reachable from anywhere but this filesystem.
 */
async function startLocalCluster(label: string): Promise<DisposableHistory> {
  const root = mkdtempSync(path.join(tmpdir(), `dsh-${label}-`));
  const data = path.join(root, "d");
  const socket = path.join(root, "s");

  const stop = async (): Promise<void> => {
    await execFile("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]).catch(
      () => undefined,
    );
    rmSync(root, { recursive: true, force: true });
  };

  const logPath = path.join(root, "log");
  mkdirSync(socket, { recursive: true });

  try {
    await execFile("initdb", [
      "-D",
      data,
      "-U",
      DB_ROLE,
      "--auth=trust",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    // No TCP listener at all: `-h ''` is an empty `listen_addresses`, so the
    // only way in is the socket directory this process owns and deletes.
    await execFile("pg_ctl", [
      "-D",
      data,
      "-l",
      logPath,
      "-o",
      `-k ${socket} -h ''`,
      "-w",
      "start",
    ]);
    await execFile("createdb", ["-h", socket, "-U", DB_ROLE, DB_NAME]);
  } catch (error) {
    const log = readLog(logPath);
    await stop();
    throw new Error(`could not start a local PostgreSQL: ${messageOf(error)}\n${log}`);
  }

  const url = `postgresql:///${DB_NAME}?host=${socket}&user=${DB_ROLE}`;
  return {
    url,
    scriptUrl: url,
    scriptEnv: { HISTORY_PG_RUNNER: "local" },
    how: "local-cluster",
    stop,
  };
}

/**
 * A history database nothing else owns, or `null` when this machine can produce
 * neither. The caller skips on `null` and says why.
 */
export async function startDisposableHistory(
  label: string,
): Promise<DisposableHistory | null> {
  if (await dockerCanRunContainers()) {
    const container = await startPostgres(label);
    return {
      url: container.url,
      scriptUrl: container.internalUrl,
      scriptEnv: {
        HISTORY_PG_RUNNER: "docker",
        HISTORY_PG_IMAGE: POSTGRES_IMAGE,
        HISTORY_PG_NETWORK: container.network,
      },
      how: "docker",
      stop: () => destroyPostgres(container),
    };
  }

  // Every program the local route needs, including the two the backup and
  // restore scripts shell out to: a cluster with no pg_dump beside it would
  // grade half these criteria and skip the other half without saying so.
  const programs = ["initdb", "pg_ctl", "createdb", "pg_dump", "pg_restore"];
  for (const program of programs) {
    if (!(await onPath(program))) return null;
  }
  return startLocalCluster(label);
}
