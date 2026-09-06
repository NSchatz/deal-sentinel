/**
 * The refusals this package raises, each one naming the condition and the thing
 * an operator would have to change.
 *
 * Every one of them runs toward FEWER requests and toward LESS stored content,
 * which is the only direction this repository lets an uncertain answer run. A
 * source that cannot be configured correctly does not run; content whose
 * attribution cannot be carried is not emitted.
 */

/**
 * A source is configured wrongly, or is not configured at all where its own
 * published terms require a setting. Naming the source AND the setting is part
 * of the contract: "something is misconfigured" is not a message anybody can
 * act on at seven in the morning.
 */
export class SourceConfigError extends Error {
  readonly sourceId: string | null;
  readonly setting: string | null;

  constructor(
    detail: string,
    context: { sourceId?: string | null; setting?: string | null } = {},
  ) {
    super(detail);
    this.name = "SourceConfigError";
    this.sourceId = context.sourceId ?? null;
    this.setting = context.setting ?? null;
  }
}

/**
 * The credential a source needs is absent or empty where the system reads it
 * from. Carries the VARIABLE NAME and never a value: this error is designed to
 * be printed, and a class that could carry a secret into a log line would be
 * the exact failure the credential criteria exist to prevent.
 */
export class MissingCredentialError extends Error {
  readonly sourceId: string;
  readonly variable: string;

  constructor(sourceId: string, variable: string) {
    super(
      `${sourceId} needs its API credential in the environment variable ` +
        `${variable}, and that variable is absent or empty. The source will ` +
        "not run: an unauthenticated request to this vendor is answered 403, " +
        "which is the same status it uses for an exceeded call limit, so " +
        "sending one would spend the household's standing with that retailer " +
        "to learn something the environment already knows.",
    );
    this.name = "MissingCredentialError";
    this.sourceId = sourceId;
    this.variable = variable;
  }
}

/**
 * A display or export path was asked to emit content from a source that
 * declares an attribution requirement, without carrying that attribution.
 *
 * Thrown rather than repaired. Filling the attribution in here would make the
 * check ceremonial: the point is that a path which forgot it does not emit.
 */
export class UnattributedEmissionError extends Error {
  readonly sourceId: string;
  readonly attributeTo: string;

  constructor(sourceId: string, attributeTo: string, detail: string) {
    super(detail);
    this.name = "UnattributedEmissionError";
    this.sourceId = sourceId;
    this.attributeTo = attributeTo;
  }
}
