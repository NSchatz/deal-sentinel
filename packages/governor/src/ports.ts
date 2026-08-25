/**
 * The ports the governor is built on, and the reason every one of them is a
 * port rather than an ambient call.
 *
 * The governor's whole job is to decide WHEN a request may leave the process.
 * A component that reads the wall clock, calls `Math.random()` or reaches an
 * HTTP client directly cannot be graded in bounded time and cannot be proven to
 * have no bypass. So: time, randomness, the transport and the notification sink
 * are all injected. The production wiring is in `transport.ts` (the one module
 * in this repository that may name an HTTP client) and in `system.ts`; every
 * test substitutes a fake and asserts against virtual time.
 */

/** Monotonic-enough time, injected so elapsed-time rules are gradeable. */
export type Clock = {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolve after `ms` have elapsed on this clock. */
  sleep(ms: number): Promise<void>;
};

/**
 * A source of randomness in `[0, 1)`, injected for the same reason the clock
 * is: a jitter nobody can reproduce is a jitter nobody can grade.
 */
export type RandomSource = () => number;

/** What the governor tells the outside world about, and nothing more. */
export type NotificationKind =
  | "breaker-paused"
  | "allowance-warn"
  | "allowance-stop";

export type Notification = {
  kind: NotificationKind;
  /** The source the notification is about. */
  sourceId: string;
  /** The instant on the injected clock, not on the wall clock. */
  at: Date;
  /** Human-readable condition. Never a secret, never a raw response body. */
  detail: string;
};

/**
 * The notification port. ALERT-4 owns the channel; this phase owns only the
 * promise that the governor emits exactly one notification per pause, per warn
 * and per stop, which is a counted call on a sink.
 */
export type Notifier = {
  notify(notification: Notification): void | Promise<void>;
};

export type TransportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /**
   * Stop reading the body after this many bytes. The robots gate passes its
   * configured parsing limit here, so a hostile or enormous robots.txt is
   * bounded at the socket rather than after it is already in memory.
   */
  maxBytes: number;
};

export type TransportResponse = {
  status: number;
  /** Header names lower-cased. Multiple values joined with ", " per RFC 9110. */
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut off at `maxBytes`. */
  truncated: boolean;
};

/**
 * The narrow port an HTTP client is reached through. Exactly one production
 * implementation exists (`transport.ts`), which is what makes "no path bypasses
 * the governor" a checkable property rather than a habit.
 */
export type HttpTransport = {
  send(request: TransportRequest): Promise<TransportResponse>;
};

/** The wall clock and `Math.random`, for production wiring only. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export const systemRandom: RandomSource = () => Math.random();

/** A notifier that drops everything. ALERT-4 replaces it with a transport. */
export const nullNotifier: Notifier = {
  notify() {
    // Deliberately empty: this phase asserts what the governor emits, never
    // what a channel promises.
  },
};
