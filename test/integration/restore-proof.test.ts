/**
 * Acceptance criterion 5, and the evidence this phase is done:
 *
 *   WHEN the history database is restored from a backup THE SYSTEM SHALL
 *   reproduce every observation the pre-backup database held, and that
 *   performed restore SHALL be the evidence this phase is done.
 *
 * Nothing here is simulated. The test:
 *
 *   1. starts PostgreSQL on a durable NAMED VOLUME and initializes the history;
 *   2. seeds it by running the real extractor over the committed fixtures and
 *      writing the results through the real write path;
 *   3. reads every column of every row back, as text, and keeps it;
 *   4. runs the committed `packages/db/scripts/backup.sh` (pg_dump);
 *   5. DESTROYS the container and its named volume - the `docker compose
 *      down -v` case the roadmap's fail-safe section names;
 *   6. starts a fresh PostgreSQL on a fresh volume, and proves it is empty by
 *      watching the start-up check refuse it;
 *   7. runs the committed `packages/db/scripts/restore.sh` (pg_restore);
 *   8. compares the restored rows against the pre-backup rows, row for row and
 *      column for column, and confirms the start-up check now passes.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  HistoryNotInitializedError,
  assertHistoryInitialized,
  createDatabase,
  drizzleWriter,
  initializeHistory,
  recordObservation,
} from "@deal-sentinel/db";

import {
  POSTGRES_IMAGE,
  createNetwork,
  destroyPostgres,
  removeNetwork,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import {
  readMarkerRows,
  readObservations,
  seedObservations,
} from "../support/seed.ts";
import type { ComparableRow } from "../support/seed.ts";

const execFile = promisify(execFileCallback);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BACKUP_SCRIPT = path.join(REPO_ROOT, "packages/db/scripts/backup.sh");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "packages/db/scripts/restore.sh");

let network: string;
let source: PostgresContainer;
let restored: PostgresContainer | undefined;
let backupDir: string;
let dumpPath: string;
let beforeBackup: ComparableRow[];
let markerBefore: ComparableRow[];

/** Run a committed script exactly as an operator would, and return its output. */
async function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout, stderr } = await execFile("bash", [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

before(async () => {
  network = await createNetwork(
    `ds-net-restore-${process.pid}-${Date.now().toString(36)}`,
  );
  backupDir = mkdtempSync(path.join(REPO_ROOT, "backups-test-"));

  source = await startPostgres("restore-src", { network });
  const pool = new pg.Pool({ connectionString: source.url });
  try {
    await initializeHistory(pool, { note: "restore proof: the pre-backup history" });
    const seeded = await seedObservations(drizzleWriter(createDatabase(pool)));
    assert.ok(
      seeded.some((entry) => entry.outcome.written),
      "the seed wrote no observations, so a restore would prove nothing",
    );
  } finally {
    await pool.end();
  }

  beforeBackup = await readObservations(source.url);
  markerBefore = await readMarkerRows(source.url);
}, { timeout: 420_000 });

after(async () => {
  if (source) await destroyPostgres(source, { keepNetwork: true });
  if (restored) await destroyPostgres(restored, { keepNetwork: true });
  if (network) await removeNetwork(network);
  if (backupDir) rmSync(backupDir, { recursive: true, force: true });
}, { timeout: 180_000 });

describe("the restore is performed, not assumed", () => {
  it("has a pre-backup history worth restoring", () => {
    assert.ok(
      beforeBackup.length >= 6,
      `expected the fixture-derived seed to write several rows, got ${beforeBackup.length}`,
    );
    assert.equal(markerBefore.length, 1);
  });

  it("backs the history up with pg_dump, through the committed script", { timeout: 300_000 }, async () => {
    dumpPath = path.join(backupDir, "history.dump");
    const output = await runScript(BACKUP_SCRIPT, [dumpPath], {
      HISTORY_DATABASE_URL: source.internalUrl,
      HISTORY_PG_RUNNER: "docker",
      HISTORY_PG_IMAGE: POSTGRES_IMAGE,
      HISTORY_PG_NETWORK: network,
    });

    assert.match(output, /backup: wrote /);
    // The script must not print the password it was handed.
    assert.equal(output.includes("sentinel-test"), false);

    const dump = statSync(dumpPath);
    assert.ok(dump.size > 0, "pg_dump produced an empty file");
    assert.deepEqual(readdirSync(backupDir), ["history.dump"]);
  });

  it("survives the volume being destroyed: down -v takes everything", { timeout: 300_000 }, async () => {
    // Container AND named volume, which is what `docker compose down -v`
    // removes. After this line the pre-backup database does not exist.
    await destroyPostgres(source, { keepNetwork: true });

    restored = await startPostgres("restore-dst", { network });
    const pool = new pg.Pool({ connectionString: restored.url });
    try {
      await assert.rejects(
        assertHistoryInitialized(pool),
        (error: unknown) =>
          error instanceof HistoryNotInitializedError && error.kind === "no-schema",
        "the fresh instance was not actually empty, so the restore proves nothing",
      );
    } finally {
      await pool.end();
    }
  });

  it("restores into the fresh instance with pg_restore, through the committed script", { timeout: 300_000 }, async () => {
    const output = await runScript(RESTORE_SCRIPT, [dumpPath], {
      HISTORY_DATABASE_URL: restored!.internalUrl,
      HISTORY_PG_RUNNER: "docker",
      HISTORY_PG_IMAGE: POSTGRES_IMAGE,
      HISTORY_PG_NETWORK: network,
    });
    assert.match(output, /restore: restored /);
    assert.equal(output.includes("sentinel-test"), false);
  });

  it("reproduces every observation the pre-backup database held, row for row", async () => {
    const afterRestore = await readObservations(restored!.url);

    assert.equal(
      afterRestore.length,
      beforeBackup.length,
      "the restored database holds a different number of observations",
    );

    for (let index = 0; index < beforeBackup.length; index += 1) {
      assert.deepEqual(
        afterRestore[index],
        beforeBackup[index],
        `row ${index} (id ${beforeBackup[index].id}) did not come back unchanged`,
      );
    }

    // deepEqual over the whole set as well, so a reordering is caught too.
    assert.deepEqual(afterRestore, beforeBackup);
  });

  it("brings the exact stored values back, not merely the right number of rows", async () => {
    const afterRestore = await readObservations(restored!.url);
    const byListing = new Map(
      afterRestore.map((row) => [String(row.listing_id), row]),
    );

    const jpy = byListing.get("https://example.invalid/tools/folding-saw-240");
    assert.ok(jpy, "the JPY observation did not come back");
    assert.equal(jpy.amount_minor_units, "12800");
    assert.equal(jpy.currency, "JPY");
    assert.equal(jpy.source_time_zone, "Asia/Tokyo");

    const kwd = byListing.get("https://example.invalid/tools/router-bit-set");
    assert.ok(kwd, "the KWD observation did not come back");
    assert.equal(kwd.amount_minor_units, "12995");

    const unrecognised = byListing.get(
      "https://example.invalid/tools/benchtop-mortiser",
    );
    assert.ok(unrecognised, "the unrecognised-availability observation did not come back");
    assert.equal(
      unrecognised.availability,
      "https://schema.org/ShipsInTwoToThreeWeeks",
    );

    const absent = byListing.get("https://example.invalid/tools/sanding-belt-pack");
    assert.ok(absent, "the no-availability observation did not come back");
    assert.equal(absent.availability, null);
  });

  it("brings the completed-initialization marker back, so the restored history starts", async () => {
    const markerAfter = await readMarkerRows(restored!.url);
    assert.deepEqual(markerAfter, markerBefore);

    const pool = new pg.Pool({ connectionString: restored!.url });
    try {
      const marker = await assertHistoryInitialized(pool);
      assert.equal(marker.note, "restore proof: the pre-backup history");
    } finally {
      await pool.end();
    }
  });

  it("restored a schema the write path can keep using", async () => {
    const pool = new pg.Pool({ connectionString: restored!.url });
    try {
      const database = createDatabase(pool);
      const outcome = await recordAfterRestore(database);
      assert.equal(outcome.written, true);
    } finally {
      await pool.end();
    }
  });
});

/** Write one more observation into the restored database, the ordinary way. */
async function recordAfterRestore(database: ReturnType<typeof createDatabase>) {
  return recordObservation(
    drizzleWriter(database),
    {
      ok: true,
      amountMinorUnits: 999n,
      currency: "USD",
      availability: "https://schema.org/InStock",
    },
    {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/after-restore",
      observedAt: new Date("2026-08-24T15:00:00.000Z"),
      sourceTimeZone: "America/New_York",
      rawContext: "<offer/>",
    },
  );
}
