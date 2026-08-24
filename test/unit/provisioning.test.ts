/**
 * The provisioning artefacts, checked without starting anything.
 *
 * The durable named volume and the two procedures are files, and a file that
 * quietly loses the clause that makes it safe is exactly the kind of regression
 * nobody notices until the history is gone. These assertions are cheap and they
 * run without docker.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("the history volume is durable by construction", () => {
  const compose = read("docker-compose.yml");

  it("mounts a named volume onto the PostgreSQL data directory", () => {
    assert.match(compose, /- history:\/var\/lib\/postgresql\/data/);
    assert.match(compose, /name: deal-sentinel-history/);
  });

  it("declares that volume external, so `down -v` cannot remove it", () => {
    // `docker compose down -v` removes named volumes DECLARED in the compose
    // file. An external volume is neither created nor removed by compose, which
    // is the only thing standing between one flag and an unbackfillable
    // history.
    assert.match(compose, /external: true/);
  });

  it("binds the database to loopback rather than to every interface", () => {
    assert.match(compose, /"127\.0\.0\.1:\$\{HISTORY_DB_PORT:-5432\}:5432"/);
  });

  it("refuses to start without a password rather than inventing one", () => {
    assert.match(compose, /POSTGRES_PASSWORD: \$\{HISTORY_DB_PASSWORD:\?/);
  });
});

describe("the backup and restore procedures are scripts, not prose", () => {
  const backup = read("packages/db/scripts/backup.sh");
  const restore = read("packages/db/scripts/restore.sh");

  it("uses PostgreSQL's own pg_dump and pg_restore", () => {
    assert.match(backup, /pg_dump/);
    assert.match(restore, /pg_restore/);
  });

  it("dumps in the custom format pg_restore reads", () => {
    assert.match(backup, /--format=custom/);
  });

  it("restores atomically, so a failed restore is not half a history", () => {
    assert.match(restore, /--single-transaction/);
  });

  it("refuses without a target rather than guessing one", () => {
    assert.match(backup, /HISTORY_DATABASE_URL is not set/);
    assert.match(restore, /HISTORY_DATABASE_URL is not set/);
  });

  it("keeps the password out of every command line it controls", () => {
    // `-e HISTORY_DATABASE_URL` forwards the variable BY NAME. Writing the URL
    // out would put the password in `docker inspect` and in the host's process
    // list.
    assert.match(backup, /-e HISTORY_DATABASE_URL/);
    assert.match(restore, /-e HISTORY_DATABASE_URL/);
    assert.equal(/-e "HISTORY_DATABASE_URL=/.test(backup), false);
    assert.equal(/-e "HISTORY_DATABASE_URL=/.test(restore), false);
  });

  it("parses as bash", () => {
    for (const script of [
      "packages/db/scripts/backup.sh",
      "packages/db/scripts/restore.sh",
    ]) {
      execFileSync("bash", ["-n", path.join(REPO_ROOT, script)]);
    }
  });
});

describe("the migration carries every column the phase names", () => {
  const migration = read(
    "packages/db/migrations/0000_history_1_price_observations.sql",
  );

  const REQUIRED: Array<[string, RegExp]> = [
    ["source id", /"source_id" text NOT NULL/],
    ["listing identifier", /"listing_id" text NOT NULL/],
    ["nullable store id", /"store_id" text,/],
    ["amount as bigint", /"amount_minor_units" bigint NOT NULL/],
    ["ISO 4217 currency", /"currency" varchar\(3\) NOT NULL/],
    ["timestamptz instant", /"observed_at" timestamp with time zone NOT NULL/],
    ["source local time zone", /"source_time_zone" text NOT NULL/],
    [
      "vendor price-update timestamp, nullable",
      /"vendor_price_updated_at" timestamp with time zone,/,
    ],
    ["per-source retention", /"raw_context_retention_hours" integer,/],
    ["bounded raw context", /"raw_context" varchar\(8192\) NOT NULL/],
    ["availability token", /"availability" text/],
  ];

  for (const [what, pattern] of REQUIRED) {
    it(`carries the ${what}`, () => {
      assert.match(migration, pattern);
    });
  }

  it("keeps the completed-initialization marker in the same migration", () => {
    assert.match(migration, /CREATE TABLE "history_initialization"/);
    assert.match(migration, /history_initialization_is_singleton/);
  });

  it("does not make the store id the per-listing key", () => {
    // The listing identifier is what a row is attributed by. If store_id ever
    // becomes NOT NULL or part of a key, this phase's promise is broken.
    assert.equal(/"store_id" text NOT NULL/.test(migration), false);
    assert.equal(/"store_id"[^,\n]*PRIMARY KEY/.test(migration), false);
    assert.equal(/"store_id"[^,\n]*UNIQUE/.test(migration), false);
    // The one primary key in the table is the surrogate id.
    assert.match(migration, /"id" bigserial PRIMARY KEY NOT NULL/);
  });
});
