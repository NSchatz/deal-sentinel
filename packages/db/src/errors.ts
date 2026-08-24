/**
 * The refusals this package makes, each one carrying its reason in the message.
 *
 * "Refuse and say so" is the phase's fail-safe, not a nicety: a history that
 * quietly starts empty looks exactly like a history that was never collected,
 * and the difference is only visible months later when a rule needs a window
 * that is not there.
 */

/** The ordinary start path found no completed-initialization marker. */
export class HistoryNotInitializedError extends Error {
  readonly kind: "no-schema" | "no-marker";

  constructor(kind: "no-schema" | "no-marker", detail: string) {
    super(detail);
    this.name = "HistoryNotInitializedError";
    this.kind = kind;
  }
}

/** The one-time initialization action was run against a history that exists. */
export class HistoryAlreadyInitializedError extends Error {
  readonly initializedAt: Date;

  constructor(initializedAt: Date, detail: string) {
    super(detail);
    this.name = "HistoryAlreadyInitializedError";
    this.initializedAt = initializedAt;
  }
}

/** A caller handed the write path something the schema will not accept. */
export class InvalidObservationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidObservationError";
  }
}

/** No connection string was configured. */
export class MissingDatabaseUrlError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not set, so there is no history database to reach. ` +
        "Set it to the PostgreSQL URL of the history store, for example " +
        "postgres://sentinel:***@127.0.0.1:5432/deal_sentinel_history.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}
