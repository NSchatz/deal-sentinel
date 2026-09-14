/**
 * Per-source health, assembled from four things this system already knows.
 *
 * Nothing here decides anything about collection and nothing here can send.
 * It READS: the request record for counts and for the last success, the
 * governor's own allowance counter, whatever paused a source, and the
 * configured staleness ceiling. Every one of them is a port, so the whole layer
 * is graded without a database and without a governor holding a socket.
 *
 * THE FAIL-SAFE THIS PHASE INHERITS, in the roadmap's own words: "a source with
 * no recent successful fetch reads as broken, not quiet". So silence is a
 * fault, not a rest state, and `broken` wins over `paused` in the one field
 * that carries a single word - while the pause itself is reported beside it,
 * because an owner needs to know both.
 *
 * WHERE A PAUSE IS VISIBLE FROM is worth saying once. A breaker pause lives in
 * the collecting process's memory, and a period stop lives in a table. A
 * surface produced inside the collecting process sees both; one produced by a
 * separate command sees the durable half. `PauseReader` is therefore a port
 * with an implementation for each, and what a report was built from is carried
 * on the report rather than implied by it.
 */

import type { Clock, GovernorConfig } from "@deal-sentinel/governor";
import { periodStartFor } from "@deal-sentinel/governor";
import type { AllowanceStore } from "@deal-sentinel/governor";
import type {
  OutcomeWindow,
  RequestOutcomeStore,
  SourceOutcomeCounts,
} from "@deal-sentinel/db";
import { emptyCounts } from "@deal-sentinel/db";

import type { OpsConfig } from "./config.ts";
import { stalenessCeilingSetting } from "./config.ts";
import { MissingStalenessCeilingError, readOrRefuse } from "./errors.ts";

/** Why a source is not being asked anything, and since when. */
export type SourcePause = {
  /** `breaker` is this process's own memory; `period-stop` is a table. */
  origin: "breaker" | "period-stop";
  /** The condition in words. Never a response body, never a credential. */
  condition: string;
  at: Date;
  /** When the pause lifts, where that is known. */
  until: Date | null;
};

export type PauseReader = {
  /** What this reader can see, for a report that states its evidence. */
  readonly evidence: SourcePause["origin"];
  pauseFor(sourceId: string): Promise<SourcePause | null>;
};

/**
 * A metered source's period, or the fact that it has none.
 *
 * An unmetered source reports neither a consumed figure nor a remaining one. A
 * zero consumed would read as "nothing spent yet" and an unlimited remaining
 * would read as a decision somebody made; both are claims about a meter that
 * does not exist.
 */
export type AllowanceState =
  | { metered: false }
  | {
      metered: true;
      consumed: number;
      remaining: number;
      limit: number;
      periodStart: Date;
      periodEnd: Date;
    };

export type SourceState = "healthy" | "paused" | "broken";

export type SourceHealth = {
  sourceId: string;
  state: SourceState;
  /** Present whenever the source is paused, whatever `state` says. */
  pause: SourcePause | null;
  allowance: AllowanceState;
  /** Null where this source has never had a successful request at all. */
  lastSuccessAt: Date | null;
  /** How old that success is, in milliseconds. Null where there is none. */
  lastSuccessAgeMs: number | null;
  stalenessCeilingMs: number;
  counts: SourceOutcomeCounts;
};

export type HealthReport = {
  /** The instant this report was produced, on the injected clock. */
  producedAt: Date;
  window: OutcomeWindow;
  /** What the pause column of this report was read from. */
  pauseEvidence: SourcePause["origin"][];
  sources: SourceHealth[];
  /**
   * Sources whose health was refused, and why. A refusal is carried rather than
   * thrown for the whole report: one source added without a ceiling must not
   * take the other sources' health down with it.
   */
  refused: { sourceId: string; detail: string }[];
};

export type HealthDependencies = {
  config: OpsConfig;
  /** The governor's own configuration: which sources exist, and their meters. */
  governorConfig: GovernorConfig;
  outcomes: RequestOutcomeStore;
  allowance: AllowanceStore;
  pauses: PauseReader;
  clock: Clock;
};

/** A reader that combines several, first answer wins, in the order given. */
export function combinePauseReaders(
  readers: readonly PauseReader[],
): PauseReader & { readonly evidenceOf: SourcePause["origin"][] } {
  return {
    evidence: readers[0]?.evidence ?? "period-stop",
    evidenceOf: readers.map((reader) => reader.evidence),
    async pauseFor(sourceId) {
      for (const reader of readers) {
        const pause = await reader.pauseFor(sourceId);
        if (pause !== null) return pause;
      }
      return null;
    },
  };
}

/** What one source's breaker says, read through a live governor. */
export type BreakerReader = {
  pauseStatus(sourceId: string): { paused: false } | { paused: true; until: number; detail: string };
};

/**
 * Pauses as the in-process breaker knows them. The breaker reports when a pause
 * LIFTS rather than when it began, so the instant reported is derived from the
 * configured pause length: the two are the same fact stated from either end.
 */
export function breakerPauses(
  breaker: BreakerReader,
  config: GovernorConfig,
): PauseReader {
  return {
    evidence: "breaker",
    pauseFor(sourceId) {
      const status = breaker.pauseStatus(sourceId);
      if (!status.paused) return Promise.resolve(null);
      const pauseMs = config.sources[sourceId]?.breaker?.pauseMs ?? config.breaker.pauseMs;
      return Promise.resolve({
        origin: "breaker" as const,
        condition: status.detail,
        at: new Date(status.until - pauseMs),
        until: new Date(status.until),
      });
    },
  };
}

/** The narrow read a period stop needs, so this package imports no table. */
export type PeriodStopReader = {
  read(sourceId: string, periodStart: Date): Promise<{ stoppedAt: Date; reason: string } | null>;
};

/**
 * Pauses as the durable stop record knows them: a source the VENDOR stopped for
 * the period. Durable, so this is the half a separately produced page can see.
 */
export function periodStopPauses(
  stops: PeriodStopReader,
  clock: Clock,
  periodMsFor: (sourceId: string) => number,
): PauseReader {
  return {
    evidence: "period-stop",
    async pauseFor(sourceId) {
      const periodMs = periodMsFor(sourceId);
      const periodStart = periodStartFor(clock.now(), periodMs);
      const stop = await readOrRefuse(`the stop record for ${sourceId}`, () =>
        stops.read(sourceId, periodStart),
      );
      if (stop === null) return null;
      return {
        origin: "period-stop" as const,
        condition: stop.reason,
        at: stop.stoppedAt,
        until: new Date(periodStart.getTime() + periodMs),
      };
    },
  };
}

/** How long a source's stop lasts, from configuration and never invented. */
export function stopPeriodsFrom(config: GovernorConfig): (sourceId: string) => number {
  return (sourceId) => {
    const settings = config.sources[sourceId];
    if (settings?.allowance !== undefined) return settings.allowance.periodMs;
    return settings?.breaker?.pauseMs ?? config.breaker.pauseMs;
  };
}

/** One source's health, or a refusal naming what configuration is missing. */
export async function readSourceHealth(
  dependencies: HealthDependencies,
  sourceId: string,
  counts: SourceOutcomeCounts,
): Promise<SourceHealth> {
  const { config, governorConfig, clock } = dependencies;
  const ceiling = config.sources[sourceId]?.stalenessCeilingMs;
  if (ceiling === undefined) {
    throw new MissingStalenessCeilingError(sourceId, stalenessCeilingSetting(sourceId));
  }

  const now = clock.now();
  const lastSuccessAt = await readOrRefuse(
    `the last successful request for ${sourceId}`,
    () => dependencies.outcomes.lastSuccessAt(sourceId),
  );
  const pause = await dependencies.pauses.pauseFor(sourceId);
  const allowance = await readAllowance(dependencies, sourceId, now);

  const ageMs = lastSuccessAt === null ? null : now - lastSuccessAt.getTime();
  // The fail-safe: never had one, or older than the configured ceiling, is
  // BROKEN. Not idle, not quiet, not healthy. A source that has stopped
  // answering looks exactly like one nobody asked, and only one of those is
  // something an owner needs to act on today.
  const stale = ageMs === null || ageMs > ceiling;

  return {
    sourceId,
    state: stale ? "broken" : pause !== null ? "paused" : "healthy",
    pause,
    allowance,
    lastSuccessAt,
    lastSuccessAgeMs: ageMs,
    stalenessCeilingMs: ceiling,
    counts,
  };
}

async function readAllowance(
  dependencies: HealthDependencies,
  sourceId: string,
  now: number,
): Promise<AllowanceState> {
  const settings = dependencies.governorConfig.sources[sourceId]?.allowance;
  if (settings === undefined) return { metered: false };

  const periodStart = periodStartFor(now, settings.periodMs);
  const record = await readOrRefuse(`the allowance counter for ${sourceId}`, () =>
    dependencies.allowance.read(sourceId, periodStart),
  );
  return {
    metered: true,
    consumed: record.consumed,
    // Never below zero: a release that outran a reservation would otherwise
    // report an allowance larger than the configured one.
    remaining: Math.max(0, settings.limit - record.consumed),
    limit: settings.limit,
    periodStart,
    periodEnd: new Date(periodStart.getTime() + settings.periodMs),
  };
}

/**
 * Every configured source's health, over one window, with the window reported
 * beside it.
 *
 * The set is the governor's configured sources: a source it has never heard of
 * is refused at the first gate, so it cannot have made a request, and one that
 * is configured but silent is exactly the case the fail-safe is about.
 */
export async function readHealthReport(
  dependencies: HealthDependencies,
  window?: OutcomeWindow,
): Promise<HealthReport> {
  const now = dependencies.clock.now();
  const asked = window ?? {
    start: new Date(now - dependencies.config.dashboard.windowMs),
    end: new Date(now),
  };

  const report = await readOrRefuse("the request outcome record", () =>
    dependencies.outcomes.countsIn(asked),
  );
  const bySource = new Map(report.sources.map((source) => [source.sourceId, source]));

  const sources: SourceHealth[] = [];
  const refused: { sourceId: string; detail: string }[] = [];
  for (const sourceId of Object.keys(dependencies.governorConfig.sources).sort()) {
    const counts = bySource.get(sourceId) ?? {
      sourceId,
      counts: emptyCounts(),
      total: 0,
    };
    try {
      sources.push(await readSourceHealth(dependencies, sourceId, counts));
    } catch (error) {
      if (!(error instanceof MissingStalenessCeilingError)) throw error;
      refused.push({ sourceId, detail: error.message });
    }
  }

  return {
    producedAt: new Date(now),
    window: report.window,
    pauseEvidence: evidenceOf(dependencies.pauses),
    sources,
    refused,
  };
}

function evidenceOf(reader: PauseReader): SourcePause["origin"][] {
  const combined = reader as { evidenceOf?: SourcePause["origin"][] };
  return combined.evidenceOf ?? [reader.evidence];
}
