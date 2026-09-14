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

import { createDatabase, emptyCounts } from "@deal-sentinel/db";
import type {
  HistoryDatabase,
  HistoryWriter,
  NewPriceObservationRow,
  RequestOutcomeStore,
  SourceOutcomeCounts,
} from "@deal-sentinel/db";
import { known, validateOpsConfig } from "@deal-sentinel/ops";
import type { DashboardModel, OpsConfig, PauseReader } from "@deal-sentinel/ops";
import type { RequestOutcomeClass } from "@deal-sentinel/shared";

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

/**
 * An operator configuration a test can bend one value of. These are TEST
 * numbers and are not the committed ones: the committed file is graded
 * separately, as itself.
 */
export function testOpsConfig(overrides: Partial<OpsConfig> = {}): OpsConfig {
  return validateOpsConfig({
    dashboard: {
      windowMs: 7 * DAY_MS,
      timeZone: "America/New_York",
      outputPath: "dashboard/index.html",
      ...overrides.dashboard,
    },
    sources: overrides.sources ?? {
      "bestbuy-api": { stalenessCeilingMs: 2 * DAY_MS },
      "second-source": { stalenessCeilingMs: 2 * DAY_MS },
    },
  });
}

/** A store whose reads fail, for the criterion about an unreadable store. */
export function unreadableOutcomeStore(failure = new Error("connection refused")): RequestOutcomeStore {
  return {
    record() {
      return Promise.reject(failure);
    },
    countsIn() {
      return Promise.reject(failure);
    },
    lastSuccessAt() {
      return Promise.reject(failure);
    },
  };
}

/** Five classes at a count each, for a card that shows a real distribution. */
export function countsOf(
  sourceId: string,
  counts: Partial<Record<RequestOutcomeClass, number>> = {},
): SourceOutcomeCounts {
  const full = { ...emptyCounts(), ...counts };
  return {
    sourceId,
    counts: full,
    total: Object.values(full).reduce((sum, count) => sum + count, 0),
  };
}

/**
 * A dashboard model a renderer test can bend one value of.
 *
 * Built by hand rather than read out of stores, because the renderer is pure
 * and the cases worth drawing - a figure nobody could compute, a listing with
 * no observations, a value carrying markup - are cases a healthy store does not
 * produce on demand.
 */
export function sampleDashboardModel(
  overrides: Partial<DashboardModel> = {},
): DashboardModel {
  const producedAt = new Date(NOW_MS);
  return {
    producedAt,
    window: { start: new Date(NOW_MS - 7 * DAY_MS), end: producedAt },
    timeZone: "America/New_York",
    pauseEvidence: ["period-stop"],
    sources: [
      {
        sourceId: "bestbuy-api",
        state: known("healthy"),
        pause: null,
        allowance: known({
          metered: true,
          consumed: 7,
          remaining: 93,
          limit: 100,
          periodStart: new Date(NOW_MS - HOUR_MS),
          periodEnd: new Date(NOW_MS + 23 * HOUR_MS),
        }),
        lastSuccessAt: known(new Date(NOW_MS - HOUR_MS)),
        counts: known(
          countsOf("bestbuy-api", {
            success: 12,
            "third-party-block": 1,
            "governor-refusal": 3,
          }),
        ),
      },
      {
        sourceId: "jsonld-generic",
        state: known("broken"),
        pause: null,
        allowance: known({ metered: false }),
        lastSuccessAt: known(null),
        counts: known(countsOf("jsonld-generic")),
      },
      {
        sourceId: "second-source",
        state: known("paused"),
        pause: {
          origin: "period-stop",
          condition: "the vendor answered 403",
          at: new Date(NOW_MS - 2 * HOUR_MS),
          until: new Date(NOW_MS + 22 * HOUR_MS),
        },
        allowance: known({
          metered: true,
          consumed: 100,
          remaining: 0,
          limit: 100,
          periodStart: new Date(NOW_MS - HOUR_MS),
          periodEnd: new Date(NOW_MS + 23 * HOUR_MS),
        }),
        lastSuccessAt: known(new Date(NOW_MS - 3 * HOUR_MS)),
        counts: known(countsOf("second-source", { "third-party-block": 4 })),
      },
    ],
    listings: [
      {
        sourceId: "bestbuy-api",
        listingId: "8880044",
        points: [
          {
            amountMinorUnits: 12999n,
            currency: "USD",
            observedAt: new Date(NOW_MS - 5 * DAY_MS),
            availability: "InStock",
          },
          {
            amountMinorUnits: 9999n,
            currency: "USD",
            observedAt: new Date(NOW_MS - 3 * DAY_MS),
            availability: "LimitedAvailability",
          },
          {
            amountMinorUnits: 14999n,
            currency: "USD",
            observedAt: new Date(NOW_MS - DAY_MS),
            availability: null,
          },
        ],
      },
      { sourceId: "bestbuy-api", listingId: "8880045", points: [] },
    ],
    ...overrides,
  };
}

/** A pause reader that sees nothing, for a case that is about something else. */
export const noPauses: PauseReader = {
  evidence: "period-stop",
  pauseFor() {
    return Promise.resolve(null);
  },
};
