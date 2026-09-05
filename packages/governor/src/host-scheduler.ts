/**
 * Per-host release accounting: the ceiling, the randomised delay, and the holds
 * that back-pressure puts on a host.
 *
 * Three independent things decide when a request may be released to a host, and
 * the release waits for the LATEST of them:
 *
 *   1. the ceiling - no more than `maxRequests` releases inside any
 *      `intervalMs`, measured over the releases actually made;
 *   2. the delay - at least `minDelayMs` since the previous release to this
 *      host, plus a randomised `[0, jitterMs]` on top, drawn per request from
 *      the injected randomness so a sample varies rather than marching in step;
 *   3. any hold a `Retry-After` or a 429 has placed on this host.
 *
 * Accounting is per host and so is the queue, which is what makes one host at
 * its ceiling irrelevant to another host's next request.
 */

import type { HostCeiling } from "./config.ts";
import type { Clock, RandomSource } from "./ports.ts";

export type Release = {
  host: string;
  /** The instant on the injected clock at which the request was released. */
  at: number;
  /** The delay this release was required to observe, jitter included. */
  delayMs: number;
  /** How long this release actually waited for the ceiling, delay or a hold. */
  waitedMs: number;
};

type HostState = {
  /** Instants of the releases still inside the widest window we care about. */
  releases: number[];
  lastRelease: number | null;
  holdUntil: number;
  /** Serialises the releases to this host, and nothing else. */
  queue: Promise<void>;
};

export class HostScheduler {
  readonly #clock: Clock;
  readonly #random: RandomSource;
  readonly #hosts = new Map<string, HostState>();

  constructor(dependencies: { clock: Clock; random: RandomSource }) {
    this.#clock = dependencies.clock;
    this.#random = dependencies.random;
  }

  /**
   * Wait until this host may be given another request, then record the release.
   *
   * Callers must send immediately afterwards: the release is counted at the
   * moment this resolves, which is the moment the request leaves the process.
   */
  async release(host: string, ceiling: HostCeiling): Promise<Release> {
    const state = this.#stateFor(host);

    const previous = state.queue;
    let done!: () => void;
    state.queue = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;

    try {
      // One draw per request. A delay recomputed inside the wait loop would
      // converge on the mean and stop being a jitter at all.
      const delayMs =
        ceiling.minDelayMs + Math.floor(this.#random() * (ceiling.jitterMs + 1));
      const startedAt = this.#clock.now();

      for (;;) {
        const now = this.#clock.now();
        const target = this.#earliestRelease(state, ceiling, delayMs, startedAt, now);
        if (target <= now) break;
        await this.#clock.sleep(target - now);
      }

      const at = this.#clock.now();
      state.releases.push(at);
      state.lastRelease = at;
      this.#prune(state, ceiling, at);

      return { host, at, delayMs, waitedMs: at - startedAt };
    } finally {
      done();
    }
  }

  /** Hold a host until `until`, never shortening a hold already in place. */
  hold(host: string, until: number): void {
    const state = this.#stateFor(host);
    state.holdUntil = Math.max(state.holdUntil, until);
  }

  /** The instant this host is held until, or 0 when it is not held. */
  heldUntil(host: string): number {
    return this.#hosts.get(host)?.holdUntil ?? 0;
  }

  #earliestRelease(
    state: HostState,
    ceiling: HostCeiling,
    delayMs: number,
    offeredAt: number,
    now: number,
  ): number {
    // The delay applies to EVERY release, the first one included. "Applies a
    // randomised delay before that request leaves the process" is not a rule
    // with an exemption for the first request of a run, and a fleet of
    // processes all starting at once is exactly when an exemption would hurt.
    const since = state.lastRelease ?? offeredAt;
    let target = Math.max(now, since + delayMs);

    const inWindow = state.releases.filter((at) => at > now - ceiling.intervalMs);
    if (inWindow.length >= ceiling.maxRequests) {
      // The release that has to age out of the window before another one fits.
      const oldestThatCounts = inWindow[inWindow.length - ceiling.maxRequests];
      target = Math.max(target, oldestThatCounts + ceiling.intervalMs);
    }

    return Math.max(target, state.holdUntil);
  }

  #prune(state: HostState, ceiling: HostCeiling, now: number): void {
    state.releases = state.releases.filter((at) => at > now - ceiling.intervalMs);
  }

  #stateFor(host: string): HostState {
    let state = this.#hosts.get(host);
    if (state === undefined) {
      state = {
        releases: [],
        lastRelease: null,
        holdUntil: 0,
        queue: Promise.resolve(),
      };
      this.#hosts.set(host, state);
    }
    return state;
  }
}
