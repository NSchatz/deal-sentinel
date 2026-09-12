/**
 * The fixtures the OPS-5 suites are built from.
 *
 * NOTHING HERE REACHES A THIRD PARTY, and nothing here opens a listening
 * socket. The governor is the one in `source-3-harness.ts`, wired to a stub
 * transport that answers from saved payloads; the database is either the
 * in-memory store or a CAPTURING one that records the SQL a query would have
 * sent and answers with no rows.
 *
 * The capturing database is the reason the Drizzle half of this work is graded
 * at all on a machine with no container runtime: the window a count answers for
 * is a property of the SQL, and a suite that only ever exercised the in-memory
 * store would be asserting a second implementation of the rule rather than the
 * one that runs in the house.
 */

import { createDatabase } from "@deal-sentinel/db";
import type { HistoryDatabase, HistoryWriter } from "@deal-sentinel/db";
import type { NewPriceObservationRow } from "@deal-sentinel/db";

/** One statement a query builder produced, with whatever it was given. */
export type CapturedStatement = { text: string; values: unknown[] };

export type CapturingDatabase = {
  database: HistoryDatabase;
  statements: CapturedStatement[];
  /** The statements naming a table, for a test that asserts on one query. */
  against(table: string): CapturedStatement[];
};

/**
 * A Drizzle database over a pool that answers every query with no rows and
 * keeps the SQL.
 *
 * It connects to nothing: `pg.Pool` opens a socket when a query runs, and no
 * query ever reaches a real one here. What comes back is an empty result, so a
 * caller under test takes its empty path - which is the other half of what this
 * is for.
 */
export function capturingDatabase(): CapturingDatabase {
  const statements: CapturedStatement[] = [];

  const record = (first: unknown, second: unknown): void => {
    const config = first as { text?: string; values?: unknown[] };
    const text = typeof first === "string" ? first : (config.text ?? "");
    const values = Array.isArray(second) ? second : (config.values ?? []);
    statements.push({ text, values });
  };

  const answer = (): Promise<unknown> =>
    Promise.resolve({ rows: [], rowCount: 0, fields: [], command: "SELECT" });

  const pool = {
    query(first: unknown, second: unknown) {
      record(first, second);
      return answer();
    },
    connect() {
      return Promise.resolve({
        query(first: unknown, second: unknown) {
          record(first, second);
          return answer();
        },
        release() {
          // Nothing was taken, so nothing is given back.
        },
      });
    },
    end() {
      return Promise.resolve();
    },
  };

  return {
    database: createDatabase(pool as never),
    statements,
    against(table) {
      return statements.filter((statement) => statement.text.includes(`"${table}"`));
    },
  };
}

export type MemoryHistoryWriter = HistoryWriter & {
  readonly rows: NewPriceObservationRow[];
};

/**
 * The narrow write port, in memory, so a criterion about an observation write
 * surviving something else's failure can be graded without a container.
 */
export function memoryHistoryWriter(): MemoryHistoryWriter {
  const rows: NewPriceObservationRow[] = [];
  return {
    rows,
    insertObservation(row) {
      rows.push(row);
      return Promise.resolve(BigInt(rows.length));
    },
  };
}

/** A whole number of milliseconds, for windows a reader can hold in the head. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The instant every OPS-5 suite hangs its windows off. */
export const NOW_MS = Date.UTC(2026, 8, 1, 12, 0, 0);
