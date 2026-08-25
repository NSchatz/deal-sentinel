/**
 * Central allowance accounting for metered sources.
 *
 * `BRIEF.md` section 5: "Anything metered, including self-imposed daily caps on
 * hard targets, deserves central enforcement with warn-at-80% and a single
 * 'stopped for the month/day' notification, so a config mistake can't silently
 * exhaust a free tier or hammer a site." The 80% is the brief's illustration,
 * not a number this phase fixes: the fraction is configuration like every other
 * number here.
 *
 * Three properties this module exists to hold:
 *
 *   - a request that LEFT THE PROCESS is counted, whatever came back. An error,
 *     a 403 and a block all consumed the allowance; only counting successes is
 *     how a quota gets burned twice;
 *   - reaching the allowance STOPS the source for the period. It does not slow
 *     it. The documented answer to an exceeded limit on the source this phase
 *     was written against is a 403, not a queue;
 *   - the counter is durable, so a crash loop inside a period resumes the count
 *     rather than restarting it (spec ruling R5). The warn and stop marks are
 *     durable for the same reason: "exactly one warning for that period" has to
 *     survive the restart that made it tempting to send a second.
 */

import type { AllowanceSettings } from "./config.ts";
import type { Clock, Notification, Notifier } from "./ports.ts";

export type AllowanceRecord = {
  consumed: number;
  warnedAt: Date | null;
  stoppedAt: Date | null;
};

/**
 * The narrow port the ledger needs. `markWarned` and `markStopped` return true
 * only for the call that set the mark, so "exactly once" is decided by the
 * store rather than by a flag in one process's memory.
 */
export type AllowanceStore = {
  read(sourceId: string, periodStart: Date): Promise<AllowanceRecord>;
  consume(sourceId: string, periodStart: Date, amount: number): Promise<AllowanceRecord>;
  markWarned(sourceId: string, periodStart: Date, at: Date): Promise<boolean>;
  markStopped(sourceId: string, periodStart: Date, at: Date): Promise<boolean>;
};

export type AllowanceVerdict =
  | { stopped: false }
  | { stopped: true; detail: string };

/**
 * The start of the period `nowMs` falls in. Periods are aligned to the epoch,
 * so every process that reads the same clock agrees on the same boundary
 * without coordinating - which is what makes the durable counter meaningful
 * across a restart.
 */
export function periodStartFor(nowMs: number, periodMs: number): Date {
  return new Date(Math.floor(nowMs / periodMs) * periodMs);
}

export class AllowanceLedger {
  readonly #store: AllowanceStore;
  readonly #clock: Clock;
  readonly #notifier: Notifier;
  readonly #settingsFor: (sourceId: string) => AllowanceSettings | undefined;

  constructor(dependencies: {
    store: AllowanceStore;
    clock: Clock;
    notifier: Notifier;
    settingsFor: (sourceId: string) => AllowanceSettings | undefined;
  }) {
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
    this.#notifier = dependencies.notifier;
    this.#settingsFor = dependencies.settingsFor;
  }

  /** May this source be served? Asked before anything is released. */
  async check(sourceId: string): Promise<AllowanceVerdict> {
    const settings = this.#settingsFor(sourceId);
    if (settings === undefined) return { stopped: false };

    const now = this.#clock.now();
    const periodStart = periodStartFor(now, settings.periodMs);
    const record = await this.#store.read(sourceId, periodStart);
    if (record.consumed < settings.limit) return { stopped: false };

    await this.#announceStop(sourceId, periodStart, settings, record.consumed);
    return { stopped: true, detail: this.#stopDetail(settings, periodStart, record.consumed) };
  }

  /**
   * Count one request that is leaving the process, and emit the warning or the
   * stop notification this period owes - each at most once.
   */
  async count(sourceId: string): Promise<void> {
    const settings = this.#settingsFor(sourceId);
    if (settings === undefined) return;

    const now = this.#clock.now();
    const periodStart = periodStartFor(now, settings.periodMs);
    const record = await this.#store.consume(sourceId, periodStart, 1);

    if (record.consumed / settings.limit >= settings.warnFraction) {
      const first = await this.#store.markWarned(sourceId, periodStart, new Date(now));
      if (first) {
        await this.#notify({
          kind: "allowance-warn",
          sourceId,
          at: new Date(now),
          detail:
            `${sourceId} has used ${record.consumed} of its configured ` +
            `allowance of ${settings.limit} for the period beginning ` +
            `${periodStart.toISOString()}, crossing the configured warn ` +
            `fraction of ${settings.warnFraction}.`,
        });
      }
    }

    if (record.consumed >= settings.limit) {
      await this.#announceStop(sourceId, periodStart, settings, record.consumed);
    }
  }

  async #announceStop(
    sourceId: string,
    periodStart: Date,
    settings: AllowanceSettings,
    consumed: number,
  ): Promise<void> {
    const at = new Date(this.#clock.now());
    const first = await this.#store.markStopped(sourceId, periodStart, at);
    if (!first) return;
    await this.#notify({
      kind: "allowance-stop",
      sourceId,
      at,
      detail: this.#stopDetail(settings, periodStart, consumed),
    });
  }

  #stopDetail(
    settings: AllowanceSettings,
    periodStart: Date,
    consumed: number,
  ): string {
    return (
      `${consumed} of the configured allowance of ${settings.limit} has been ` +
      `used for the period beginning ${periodStart.toISOString()}. This source ` +
      "is stopped for the remainder of the period rather than slowed, and " +
      "every other source keeps running."
    );
  }

  async #notify(notification: Notification): Promise<void> {
    await this.#notifier.notify(notification);
  }
}
