/**
 * The per-source circuit breaker.
 *
 * "WHEN a source's error or block rate crosses its configured threshold THE
 * SYSTEM SHALL pause that source and notify once, and SHALL leave every other
 * source running." Every piece of state here is keyed by source id, so pausing
 * one is arithmetically incapable of pausing another.
 *
 * Two readings worth stating, because the phrase "crosses its threshold" does
 * not fix them:
 *
 *   - the rate is failures over outcomes inside the configured window, and it
 *     is only consulted once `minimumOutcomes` outcomes are in that window: one
 *     failed request out of one is a rate of 1.0 and would otherwise pause a
 *     source on its first hiccup;
 *   - "crosses" is `>=`. A threshold reached is a threshold crossed, which is
 *     the direction that sends fewer requests.
 *
 * While a source is paused nothing is recorded against it, so the notification
 * that fires when it trips fires exactly once for that pause however many
 * requests arrive behind it.
 */

import type { BreakerSettings } from "./config.ts";
import type { Clock } from "./ports.ts";

export type OutcomeClass = "success" | "failure";

export type BreakerStatus =
  | { paused: false }
  | { paused: true; until: number; detail: string };

type SourceState = {
  outcomes: Array<{ at: number; outcome: OutcomeClass }>;
  pausedUntil: number;
  pauseDetail: string;
};

export class Breaker {
  readonly #clock: Clock;
  readonly #settingsFor: (sourceId: string) => BreakerSettings;
  readonly #sources = new Map<string, SourceState>();

  constructor(dependencies: {
    clock: Clock;
    settingsFor: (sourceId: string) => BreakerSettings;
  }) {
    this.#clock = dependencies.clock;
    this.#settingsFor = dependencies.settingsFor;
  }

  /** Is this source paused right now? Resuming happens here, lazily. */
  status(sourceId: string): BreakerStatus {
    const state = this.#stateFor(sourceId);
    const now = this.#clock.now();
    if (state.pausedUntil > now) {
      return { paused: true, until: state.pausedUntil, detail: state.pauseDetail };
    }
    if (state.pausedUntil !== 0) {
      // The pause has expired. Start the next window empty rather than with the
      // failures that caused the pause, or the source trips again on its first
      // request back.
      state.pausedUntil = 0;
      state.pauseDetail = "";
      state.outcomes = [];
    }
    return { paused: false };
  }

  /**
   * Record one outcome and report the pause it caused, if it caused one.
   *
   * The return value is the ONLY place a pause is announced, which is what
   * makes "notify once per pause" a property of this method rather than of its
   * callers.
   */
  record(sourceId: string, outcome: OutcomeClass): { paused: true; detail: string } | null {
    const state = this.#stateFor(sourceId);
    const now = this.#clock.now();
    if (state.pausedUntil > now) return null;

    const settings = this.#settingsFor(sourceId);
    state.outcomes.push({ at: now, outcome });
    state.outcomes = state.outcomes.filter((entry) => entry.at > now - settings.windowMs);

    const total = state.outcomes.length;
    if (total < settings.minimumOutcomes) return null;

    const failures = state.outcomes.filter((entry) => entry.outcome === "failure").length;
    const rate = failures / total;
    if (rate < settings.failureRateThreshold) return null;

    state.pausedUntil = now + settings.pauseMs;
    state.pauseDetail =
      `${failures} of the last ${total} outcomes in the configured ` +
      `${settings.windowMs}ms window were an error or a block, a rate of ` +
      `${rate.toFixed(2)} against the configured threshold of ` +
      `${settings.failureRateThreshold}. This source is paused for ` +
      `${settings.pauseMs}ms; every other source keeps running.`;
    return { paused: true, detail: state.pauseDetail };
  }

  #stateFor(sourceId: string): SourceState {
    let state = this.#sources.get(sourceId);
    if (state === undefined) {
      state = { outcomes: [], pausedUntil: 0, pauseDetail: "" };
      this.#sources.set(sourceId, state);
    }
    return state;
  }
}
