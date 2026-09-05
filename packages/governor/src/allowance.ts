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
 * Four properties this module exists to hold:
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
 *     survive the restart that made it tempting to send a second;
 *   - SPENDING IS ATOMIC. A caller does not read the counter, decide, and then
 *     write it: it asks the STORE to take one unit if and only if the total
 *     that results is still inside the limit, and the store answers with the
 *     total it now holds. Nothing about a concurrent caller can make that answer
 *     wrong, because no second caller can observe the counter between the
 *     addition and the test - they are one statement.
 *
 * The last one is the reason `reserve` and not `count`. Requests for ONE metered
 * source on DIFFERENT hosts are serialised by nothing: `HostScheduler` is per
 * host by design, because AC4 forbids one host at its ceiling from holding up
 * another. So a shape that reads the consumption, waits, and then adds to it
 * lets every one of those requests read the same number, pass the same test, and
 * leave - and the overspend is bounded by how many hosts an adapter offers at
 * once rather than by the configured allowance. Read-then-write is not a slower
 * version of this module's job; it is a different and wrong one.
 *
 * The three calls, and the state each of them is allowed to be in:
 *
 *   - `check` is ADVISORY. It reads, it can only refuse, and it is there so a
 *     source that is already finished for the period is turned away cheaply -
 *     before a robots.txt is fetched on its behalf. It never authorises a send;
 *   - `reserve` is BINDING and is the only thing that authorises one. Exactly
 *     one store statement, so the caller may put it immediately before the wire;
 *   - `settle` is what the caller owes a reservation whose request LEFT, and it
 *     is where the warn and the stop notifications are emitted. Deliberately
 *     AFTER the send: emitting them from `reserve` would put two more store
 *     round trips between the reservation and the request, which is the very gap
 *     this shape exists to close. A notification is not a gate - the gate is the
 *     counter - so nothing is decided any later for being told any later;
 *   - `release` is what it owes a reservation whose request did NOT leave. Only
 *     the caller knows that, because only the caller knows what it did after the
 *     reservation was granted.
 */

import type { AllowanceSettings } from "./config.ts";
import type { Clock, Notification, Notifier } from "./ports.ts";

export type AllowanceRecord = {
  consumed: number;
  warnedAt: Date | null;
  stoppedAt: Date | null;
};

/** What `reserve` answered: whether the unit is held, and the total that now stands. */
export type AllowanceReservationRecord = {
  granted: boolean;
  consumed: number;
};

/**
 * The narrow port the ledger needs.
 *
 * Three of the four mutations are decided BY THE STORE and not by the caller,
 * which is what makes them safe under concurrency: `reserve` adds and tests in
 * one statement, and `markWarned` / `markStopped` return true only for the call
 * that set the mark. "Exactly once" and "no more than the allowance" are
 * therefore properties of a statement, not of a flag in one process's memory,
 * and they survive two workers inside one period as well as two requests inside
 * one worker.
 */
export type AllowanceStore = {
  read(sourceId: string, periodStart: Date): Promise<AllowanceRecord>;
  /**
   * Add `amount` to this period's consumption IF AND ONLY IF the resulting
   * total is at most `limit`, and report the total that stands afterwards.
   *
   * ATOMIC: an implementation may not read the counter and then write it. The
   * addition and the test are one indivisible step, so no concurrent caller can
   * observe or act on the value between them.
   */
  reserve(
    sourceId: string,
    periodStart: Date,
    amount: number,
    limit: number,
  ): Promise<AllowanceReservationRecord>;
  /**
   * Give `amount` back, for a granted reservation whose request never left the
   * process. Single statement for the same reason `reserve` is.
   */
  release(sourceId: string, periodStart: Date, amount: number): Promise<void>;
  markWarned(sourceId: string, periodStart: Date, at: Date): Promise<boolean>;
  markStopped(sourceId: string, periodStart: Date, at: Date): Promise<boolean>;
};

export type AllowanceVerdict =
  | { stopped: false }
  | { stopped: true; detail: string };

/**
 * One unit of a metered source's allowance, held for a request that has been
 * authorised but has not left yet.
 *
 * `spent: false` covers both "this source is not metered, so there was nothing
 * to spend" and "the period is finished". They are distinguished by `refused`,
 * and only `refused` may stop a request.
 */
export type AllowanceReservation =
  | { spent: false; refused: false }
  | { spent: false; refused: true; detail: string }
  | {
      spent: true;
      refused: false;
      sourceId: string;
      periodStart: Date;
      /** The store's total AFTER this unit was taken. Not a value read earlier. */
      consumed: number;
      settings: AllowanceSettings;
    };

/** Nothing was spent and nothing is stopped: the source carries no allowance. */
const UNMETERED: AllowanceReservation = { spent: false, refused: false };

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

  /**
   * May this source be served? ADVISORY, and asked early so that a source which
   * is already finished for the period costs nothing further - in particular so
   * that no `/robots.txt` is fetched on behalf of a source that cannot be
   * served anyway.
   *
   * This answer is a statement about the moment it was read and NOTHING may be
   * released on the strength of it: by the time a caller acts, another request
   * for the same source on another host may have spent the units this read saw.
   * `reserve` is the answer that authorises a send. This one can only refuse.
   */
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
   * Take one unit for a request that is about to leave, or refuse.
   *
   * EXACTLY ONE STORE STATEMENT, so a caller may place this immediately before
   * the wire with nothing in between. The verdict is derived from the total the
   * store returns - the total this call itself produced - and never from a value
   * read an `await` earlier. That is the whole difference between this and a
   * counter that can be overspent by the number of hosts offered at once.
   *
   * Nothing is notified here, deliberately: see the module header.
   */
  async reserve(sourceId: string): Promise<AllowanceReservation> {
    const settings = this.#settingsFor(sourceId);
    if (settings === undefined) return UNMETERED;

    const periodStart = periodStartFor(this.#clock.now(), settings.periodMs);
    const reservation = await this.#store.reserve(
      sourceId,
      periodStart,
      1,
      settings.limit,
    );

    if (!reservation.granted) {
      return {
        spent: false,
        refused: true,
        detail: this.#stopDetail(settings, periodStart, reservation.consumed),
      };
    }

    return {
      spent: true,
      refused: false,
      sourceId,
      periodStart,
      consumed: reservation.consumed,
      settings,
    };
  }

  /**
   * The reservation's request LEFT THE PROCESS. Emit the warning or the stop
   * notification the resulting total owes - each at most once for the period,
   * decided by the store's marks rather than by anything held here.
   *
   * Called after the send and whatever came back, because AC20 counts a request
   * that left however it ended: an error, a 403 and a block alike.
   */
  async settle(reservation: AllowanceReservation): Promise<void> {
    if (!reservation.spent) return;
    const { sourceId, periodStart, consumed, settings } = reservation;
    const at = new Date(this.#clock.now());

    if (consumed / settings.limit >= settings.warnFraction) {
      const first = await this.#store.markWarned(sourceId, periodStart, at);
      if (first) {
        await this.#notify({
          kind: "allowance-warn",
          sourceId,
          at,
          detail:
            `${sourceId} has used ${consumed} of its configured ` +
            `allowance of ${settings.limit} for the period beginning ` +
            `${periodStart.toISOString()}, crossing the configured warn ` +
            `fraction of ${settings.warnFraction}.`,
        });
      }
    }

    if (consumed >= settings.limit) {
      await this.#announceStop(sourceId, periodStart, settings, consumed);
    }
  }

  /**
   * The reservation's request did NOT leave the process, so the unit it holds
   * was never spent and goes back.
   *
   * AC20 counts what left, and nothing left, so keeping the unit would be an
   * overcount: an allowance quietly smaller than the configured one. The window
   * in which the counter reads one high is bounded by this call and errs toward
   * FEWER requests, which is this package's fail-safe direction; the window in
   * which it read one LOW is the defect this shape exists to remove, and does
   * not exist at all.
   *
   * Nothing is notified: nothing happened.
   */
  async release(reservation: AllowanceReservation): Promise<void> {
    if (!reservation.spent) return;
    await this.#store.release(reservation.sourceId, reservation.periodStart, 1);
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
