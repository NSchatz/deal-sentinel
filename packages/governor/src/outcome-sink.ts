/**
 * Where a completed request's outcome goes, and what happens when it cannot go
 * there. The store itself lives in `@deal-sentinel/db` and takes a database
 * handle; this package opens no connections, so what is here is the SAFETY.
 *
 * Why a failure is reported rather than thrown or swallowed. Thrown, a database
 * hiccup would cost a request its result and an observation its row, and an
 * observation not taken is not backfillable: no retailer publishes the price a
 * page carried yesterday. Swallowed, the record would stop existing one day and
 * every count over it would read as a quiet source rather than a broken
 * recorder. The default report writes to standard error rather than notifying,
 * because the notifier is an owner's phone and adding a fourth condition to it
 * is a decision this phase does not get to make.
 */

import type {
  OutcomeRecordingFailure,
  RecordedRequestOutcome,
  RequestOutcomeSink,
} from "./ports.ts";

/** The one line a failed recording writes, prefixed so a log grep finds it. */
export const OUTCOME_RECORDING_FAILURE_PREFIX = "request-outcome-not-recorded";

/** Describe a failure in words that name no URL and carry no credential. */
export function describeRecordingFailure(
  outcome: RecordedRequestOutcome,
  error: unknown,
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return (
    `${OUTCOME_RECORDING_FAILURE_PREFIX}: ${outcome.sourceId} ` +
    `${outcome.outcomeClass} after ${outcome.durationMs}ms at ` +
    `${outcome.recordedAt.toISOString()} could not be recorded: ${reason}. The ` +
    "request itself was unaffected and any observation it fed was written."
  );
}

/** The default report: one line on standard error, never a notification. */
export function reportToStandardError(failure: OutcomeRecordingFailure): void {
  process.stderr.write(`${failure.detail}\n`);
}

/** A sink over any `record` function, with the failure path already built. */
export function createOutcomeSink(options: {
  record(outcome: RecordedRequestOutcome): void | Promise<void>;
  report?(failure: OutcomeRecordingFailure): void;
}): RequestOutcomeSink {
  const report = options.report ?? reportToStandardError;
  return {
    record: options.record,
    recordingFailed(failure) {
      try {
        report(failure);
      } catch {
        // A reporter that throws must not become the thing that stops a
        // request either. There is nowhere further to report to.
      }
    },
  };
}

/**
 * A sink that keeps nothing, for a caller with no database - a start check, a
 * one-shot script - that still has to hand the governor one.
 */
export const discardingOutcomeSink: RequestOutcomeSink = createOutcomeSink({
  record() {
    // Nothing is kept, and nothing pretends otherwise.
  },
});
