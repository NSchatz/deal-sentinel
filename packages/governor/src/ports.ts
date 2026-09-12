/**
 * The ports the governor is built on, and why every one of them is a port
 * rather than an ambient call.
 *
 * The governor decides WHEN a request may leave the process. A component that
 * reads the wall clock, calls `Math.random()` or reaches an HTTP client
 * directly cannot be graded in bounded time and cannot be proven to have no
 * bypass, so time, randomness, the transport and the notification sink are all
 * injected. Production wiring is in `transport.ts` and `system.ts`.
 */

import type { RequestOutcomeClass } from "@deal-sentinel/shared";

/** Monotonic-enough time, injected so elapsed-time rules are gradeable. */
export type Clock = {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
};

/** In `[0, 1)`. A jitter nobody can reproduce is a jitter nobody can grade. */
export type RandomSource = () => number;

/**
 * The first three are the governor's own conditions. The fourth is a SOURCE's:
 * a vendor answering "the allocated call limit has been exceeded" has stopped
 * the source itself, and calling that `allowance-stop` would claim this system
 * reached its own configured cap when it did not. One is a local number to
 * raise, the other a refusal from a third party, so they are different words.
 */
export type NotificationKind =
  | "breaker-paused"
  | "allowance-warn"
  | "allowance-stop"
  | "source-limit-exceeded";

export type Notification = {
  kind: NotificationKind;
  sourceId: string;
  /** The instant on the injected clock, not on the wall clock. */
  at: Date;
  /** Human-readable condition. Never a secret, never a raw response body. */
  detail: string;
};

/** ALERT-4 owns the channel; this phase owns one notification per condition. */
export type Notifier = {
  notify(notification: Notification): void | Promise<void>;
};

/**
 * One completed request, as the durable record keeps it. The absences are
 * deliberate: no URL (this system's API key travels in one), no headers, no
 * body, no credential.
 */
export type RecordedRequestOutcome = {
  sourceId: string;
  outcomeClass: RequestOutcomeClass;
  /** Whole milliseconds on the injected clock, never below zero. */
  durationMs: number;
  recordedAt: Date;
};

/** A record that could not be written, handed back rather than swallowed. */
export type OutcomeRecordingFailure = {
  outcome: RecordedRequestOutcome;
  error: unknown;
  /** The failure in words, already safe to print: it names no URL. */
  detail: string;
};

/**
 * Where a completed request's outcome goes. `record` may fail - a database is a
 * thing that goes away - and when it does the governor hands the failure to
 * `recordingFailed` and carries on: a price not observed cannot be backfilled,
 * while a missing outcome row is one line of a report.
 */
export type RequestOutcomeSink = {
  record(outcome: RecordedRequestOutcome): void | Promise<void>;
  /** Never throws: it is the thing that runs when something already has. */
  recordingFailed(failure: OutcomeRecordingFailure): void;
};

export type TransportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Bounds a hostile robots.txt at the socket, not after it is in memory. */
  maxBytes: number;
  /**
   * Absent on every read this system makes. A notification channel is the first
   * caller with something to say rather than to ask, and it says it here,
   * through the same six gates: a channel that opened its own socket would be
   * the second way out of this process.
   */
  body?: string;
};

export type TransportResponse = {
  status: number;
  /** Header names lower-cased. Multiple values joined with ", " per RFC 9110. */
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

/**
 * One production implementation exists (`transport.ts`), which is what makes
 * "no path bypasses the governor" checkable rather than a habit.
 */
export type HttpTransport = {
  send(request: TransportRequest): Promise<TransportResponse>;
};

/**
 * A MARKER, not a transport: it has no `send`, so holding it sends nothing, and
 * the only way to reach a client is to hand it to a `Governor`, which does so
 * behind all six gates. Exporting the factory instead would let a caller import
 * one name and issue a request with no ceiling, delay, robots decision,
 * back-pressure, breaker or allowance.
 */
export const LIVE_TRANSPORT: unique symbol = Symbol.for(
  "@deal-sentinel/governor#live-transport",
);

/** A transport the caller supplies, for asserting on what was sent. */
export type TransportChoice = HttpTransport | typeof LIVE_TRANSPORT;

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
    // This phase asserts what the governor emits, never what a channel does.
  },
};
