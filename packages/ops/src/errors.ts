/**
 * What the operator surface refuses, and what each refusal names.
 *
 * The rule this package inherits: warn or typed error, never a confident wrong
 * answer. A surface that answers "healthy" because it could not read the store
 * is worse than one that will not draw at all, because the owner acts on it.
 */

/** Configuration is absent, unparseable, or short of a required value. */
export class OpsConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "OpsConfigError";
  }
}

/**
 * No staleness ceiling is configured for this source, so nothing here knows how
 * old a silence has to be before it is a fault. A ceiling invented in code is a
 * threshold nobody chose, which CLAUDE.md rule 8 forbids, so this refuses the
 * source's health instead and names the setting that is missing.
 */
export class MissingStalenessCeilingError extends Error {
  readonly sourceId: string;
  readonly setting: string;

  constructor(sourceId: string, setting: string) {
    super(
      `${sourceId} has no configured staleness ceiling, so how old its last ` +
        `successful request may be before the source is broken is unknown. Add ` +
        `${setting} to config/ops.json deliberately; there is no default to ` +
        "fall back to, and a ceiling invented here would be a threshold " +
        "nobody chose.",
    );
    this.name = "MissingStalenessCeilingError";
    this.sourceId = sourceId;
    this.setting = setting;
  }
}

/**
 * A read the surface depends on failed. Thrown rather than answered around: an
 * empty count and an unreadable store look identical on a page, and one of them
 * means "nothing is wrong".
 */
export class StoreUnreadableError extends Error {
  readonly read: string;
  /** What actually failed, kept so a caller can say more than this message. */
  readonly failure: unknown;

  constructor(read: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `${read} could not be read (${reason}), so no health and no history are ` +
        "produced for this run. An empty answer and an unreadable store are " +
        "indistinguishable once they reach a page, and one of them reads as " +
        "nothing being wrong.",
    );
    this.name = "StoreUnreadableError";
    this.read = read;
    this.failure = cause;
  }
}

/** Run `read`, or fail naming which read it was. Never returns an empty stand-in. */
export async function readOrRefuse<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StoreUnreadableError) throw error;
    throw new StoreUnreadableError(what, error);
  }
}
