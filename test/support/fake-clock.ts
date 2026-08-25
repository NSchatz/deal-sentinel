/**
 * A virtual clock, because a criterion nobody can grade in bounded time is not
 * a criterion.
 *
 * The governor's rules are all about elapsed time: at least this delay between
 * releases, no more than that many releases per interval, hold this host for
 * two minutes, stop that source for the period. Asserting those against the
 * wall clock would mean a suite that sleeps for hours, so the clock is injected
 * and this is what gets injected.
 *
 * `sleep` registers a timer and the clock AUTO-ADVANCES: once every pending
 * promise job has run (a `setImmediate`, which is after the microtask queue),
 * virtual time jumps to the earliest pending timer and resolves it. Nothing
 * real is ever slept, and the code under test cannot tell the difference,
 * because the only thing it may ask about time is `now()`.
 */

import type { Clock } from "@deal-sentinel/governor";

type Timer = { at: number; sequence: number; resolve: () => void };

export class FakeClock implements Clock {
  #now: number;
  #timers: Timer[] = [];
  #sequence = 0;
  #scheduled = false;

  /** Every sleep this clock was asked for, in order. Evidence, not state. */
  readonly requestedSleeps: number[] = [];

  constructor(startMs = Date.UTC(2026, 7, 25, 12, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    this.requestedSleeps.push(ms);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#timers.push({ at: this.#now + ms, sequence: this.#sequence++, resolve });
      this.#schedulePump();
    });
  }

  /** Move virtual time forward by hand, resolving everything that comes due. */
  async advanceBy(ms: number): Promise<void> {
    const target = this.#now + ms;
    while (this.#timers.length > 0) {
      const earliest = this.#earliest();
      if (earliest === null || earliest.at > target) break;
      this.#fireUpTo(earliest.at);
      // Let the resumed continuations run before deciding what is next.
      await Promise.resolve();
    }
    this.#now = Math.max(this.#now, target);
  }

  /** How many sleeps are still waiting. Zero means nothing is mid-wait. */
  get pending(): number {
    return this.#timers.length;
  }

  #schedulePump(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      const earliest = this.#earliest();
      if (earliest === null) return;
      this.#fireUpTo(earliest.at);
      if (this.#timers.length > 0) this.#schedulePump();
    });
  }

  #earliest(): Timer | null {
    let earliest: Timer | null = null;
    for (const timer of this.#timers) {
      if (
        earliest === null ||
        timer.at < earliest.at ||
        (timer.at === earliest.at && timer.sequence < earliest.sequence)
      ) {
        earliest = timer;
      }
    }
    return earliest;
  }

  #fireUpTo(instant: number): void {
    if (instant > this.#now) this.#now = instant;
    const due = this.#timers
      .filter((timer) => timer.at <= this.#now)
      .sort((left, right) => left.at - right.at || left.sequence - right.sequence);
    this.#timers = this.#timers.filter((timer) => timer.at > this.#now);
    for (const timer of due) timer.resolve();
  }
}

/**
 * A randomness source that walks a fixed sequence and then repeats it. Jitter
 * has to be reproducible to be assertable, and "varies across a sample" has to
 * be asserted against values a test chose.
 */
export function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}
