/**
 * Real PostgreSQL containers for the integration tests.
 *
 * These tests do not mock the database. The phase's own evidence is a PERFORMED
 * restore, and a restore that was simulated proves nothing about pg_dump,
 * pg_restore, a named volume, or the schema they carry between them. Every
 * container here is created with a name unique to the test run and is removed
 * in a `finally`, including its named volume and its network.
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const execFile = promisify(execFileCallback);

export const POSTGRES_IMAGE = process.env.HISTORY_TEST_PG_IMAGE ?? "postgres:16-alpine";

export const DB_USER = "sentinel";
export const DB_PASSWORD = "sentinel-test";
export const DB_NAME = "deal_sentinel_history";

export type PostgresContainer = {
  /** Container name, unique to this test run. */
  name: string;
  /** The user-defined docker network the container sits on. */
  network: string;
  /** The named volume mounted onto the PostgreSQL data directory. */
  volume: string;
  /** Host port the container's 5432 is published on. */
  port: number;
  /** libpq URL reaching this container from the test process. */
  url: string;
  /**
   * libpq URL reaching this container from ANOTHER container on `network`,
   * which is how the backup and restore scripts reach it when they run
   * pg_dump / pg_restore out of the postgres image.
   */
  internalUrl: string;
};

export async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFile("docker", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export function dockerAvailable(): boolean {
  return process.env.HISTORY_TEST_SKIP_DOCKER !== "1";
}

/**
 * Whether this machine's Docker can actually START a container, answered by
 * starting one.
 *
 * `docker version` is not the question: a daemon can answer that and still hang
 * forever on `docker run`, which is what a sandboxed environment without the
 * kernel features a container needs does. A suite that asks the wrong question
 * waits for a hook timeout and reports a failure that is not about the code, so
 * this one asks the right question with a short deadline and lets the caller
 * skip honestly.
 */
export async function dockerCanRunContainers(timeoutMs = 20_000): Promise<boolean> {
  if (!dockerAvailable()) return false;
  try {
    await execFile("docker", ["run", "--rm", POSTGRES_IMAGE, "true"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return true;
  } catch {
    return false;
  }
}

let counter = 0;

/**
 * Start a PostgreSQL container with a durable NAMED VOLUME on its data
 * directory. The volume is the point: it is what survives the container, and
 * removing it is what `docker compose down -v` does.
 */
export async function startPostgres(
  label: string,
  options: { network?: string; volume?: string } = {},
): Promise<PostgresContainer> {
  const suffix = `${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const name = `ds-test-${label}-${suffix}`;
  const network = options.network ?? (await createNetwork(`ds-net-${suffix}`));
  const volume = options.volume ?? (await createVolume(`ds-vol-${label}-${suffix}`));

  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "-v",
    `${volume}:/var/lib/postgresql/data`,
    "-e",
    `POSTGRES_USER=${DB_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  );

  const port = await publishedPort(name);
  const url = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
  await waitForReady(name);
  await waitForConnection(url);

  return {
    name,
    network,
    volume,
    port,
    url,
    internalUrl: `postgres://${DB_USER}:${DB_PASSWORD}@${name}:5432/${DB_NAME}`,
  };
}

export async function createNetwork(name: string): Promise<string> {
  await docker("network", "create", name);
  return name;
}

export async function createVolume(name: string): Promise<string> {
  await docker("volume", "create", name);
  return name;
}

export async function removeContainer(name: string): Promise<void> {
  await docker("rm", "-f", "-v", name).catch(() => "");
}

export async function removeVolume(name: string): Promise<void> {
  await docker("volume", "rm", "-f", name).catch(() => "");
}

export async function removeNetwork(name: string): Promise<void> {
  await docker("network", "rm", name).catch(() => "");
}

/**
 * Tear a container down and take its named volume with it: the
 * `docker compose down -v` case the roadmap's fail-safe section names.
 */
export async function destroyPostgres(
  container: PostgresContainer,
  options: { keepNetwork?: boolean } = {},
): Promise<void> {
  await removeContainer(container.name);
  await removeVolume(container.volume);
  if (!options.keepNetwork) await removeNetwork(container.network);
}

async function publishedPort(name: string): Promise<number> {
  const mapping = await docker("port", name, "5432/tcp");
  const first = mapping.split("\n")[0];
  const port = Number(first.slice(first.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read a published port from "${mapping}"`);
  }
  return port;
}

async function waitForReady(name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await docker("exec", name, "pg_isready", "-U", DB_USER, "-d", DB_NAME);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  throw new Error(`${name} was not ready within ${timeoutMs}ms: ${lastError}`);
}

/**
 * `pg_isready` answers over the unix socket, and the official image runs a
 * temporary socket-only server while it initialises the data directory, then
 * restarts. A TCP client that believes `pg_isready` too early gets ECONNRESET,
 * so readiness here means a real connection over the published port.
 */
async function waitForConnection(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      await sleep(250);
    }
  }
  throw new Error(`no connection to ${redact(url)} within ${timeoutMs}ms: ${lastError}`);
}

/** Never print a password, not even a test one. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
