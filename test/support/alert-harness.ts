/**
 * The fixtures the alert tests are built from: a complete alert configuration a
 * test can bend one value of, a channel that records what it was asked to
 * deliver, and a synthetic price series.
 *
 * The configuration here is a TEST configuration. It is not the committed
 * `config/alerts.json` and it is not a recommendation: the numbers are small so
 * that an assertion about a window or a cooldown is readable in one line.
 */

import { validateAlertConfig } from "@deal-sentinel/alerts";
import type {
  AlertChannel,
  AlertConfig,
  AlertNotification,
  PricePoint,
} from "@deal-sentinel/alerts";

/** A window of exactly a day, in the units the configuration uses. */
export const DAY_MS = 86_400_000;

export type AlertConfigOverrides = {
  sourceId?: string;
  rules?: Record<string, unknown>;
  clearanceEndings?: Record<string, string[]>;
  channel?: Record<string, unknown>;
};

/** The document a complete alert configuration is, as JSON, before validation. */
export function alertDocument(
  overrides: AlertConfigOverrides = {},
): Record<string, unknown> {
  return {
    sourceId: overrides.sourceId ?? "alert-channel",
    rules: overrides.rules ?? {
      "window-low-test": {
        kind: "window-low",
        windowMs: 30 * DAY_MS,
        minimumObservations: 3,
        improvementMinorUnits: 100,
        cooldownMs: 7 * DAY_MS,
      },
    },
    clearanceEndings: overrides.clearanceEndings ?? {},
    channel: {
      endpoint: null,
      method: "POST",
      headers: {},
      titleHeader: null,
      linkHeader: null,
      credential: null,
      ...overrides.channel,
    },
  };
}

export function testAlertConfig(overrides: AlertConfigOverrides = {}): AlertConfig {
  return validateAlertConfig(alertDocument(overrides), "the test alert configuration");
}

export type RecordingChannel = AlertChannel & {
  /** Every notification this channel was ASKED to deliver, in order. */
  readonly asked: AlertNotification[];
  /** Every one it actually delivered. */
  readonly delivered: AlertNotification[];
};

/**
 * A channel that reaches nothing at all: it answers from a responder the test
 * supplies. Used where the criterion is about WHICH notifications are offered
 * rather than about what a server said; the delivery criteria are graded
 * against a real stub server on 127.0.0.1 instead.
 */
export function recordingChannel(
  responder: (
    notification: AlertNotification,
    index: number,
  ) => { status: number } | { refuse: true } | { fail: string } = () => ({ status: 200 }),
): RecordingChannel {
  const asked: AlertNotification[] = [];
  const delivered: AlertNotification[] = [];

  return {
    asked,
    delivered,
    describedAs: "the recording channel",
    deliver(notification) {
      const index = asked.length;
      asked.push(notification);
      const answer = responder(notification, index);

      if ("refuse" in answer) {
        return Promise.resolve({
          delivered: false as const,
          kind: "refused" as const,
          detail: "the recording channel refused this run's credential",
          stopChannel: true,
        });
      }
      if ("fail" in answer) {
        return Promise.resolve({
          delivered: false as const,
          kind: "failed" as const,
          detail: answer.fail,
          stopChannel: false,
        });
      }

      delivered.push(notification);
      return Promise.resolve({ delivered: true as const, status: answer.status });
    },
  };
}

/**
 * A synthetic series: `count` observations one day apart, ending `endingAt`,
 * every one at `amountMinorUnits`. The series a rule is graded against is
 * always built here rather than read from anywhere, which is what "the same
 * verdict on every run" is asserted over.
 */
export function flatSeries(options: {
  count: number;
  amountMinorUnits: bigint;
  currency?: string;
  endingAt: Date;
  stepMs?: number;
}): PricePoint[] {
  const step = options.stepMs ?? DAY_MS;
  const currency = options.currency ?? "USD";
  const points: PricePoint[] = [];
  for (let index = options.count - 1; index >= 0; index -= 1) {
    points.push({
      amountMinorUnits: options.amountMinorUnits,
      currency,
      observedAt: new Date(options.endingAt.getTime() - index * step),
    });
  }
  return points;
}

/** One observation, spelled out where a series would hide what a test means. */
export function point(
  amountMinorUnits: bigint,
  observedAt: Date,
  currency = "USD",
): PricePoint {
  return { amountMinorUnits, currency, observedAt };
}
