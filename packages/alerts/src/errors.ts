/**
 * The refusals this package raises.
 *
 * Both of them run toward FEWER notifications, which is the only direction an
 * uncertain answer is allowed to run here: BRIEF.md section 7 names
 * over-alerting as the failure mode that kills these tools, and a false alert
 * is a financial defect wearing a notification costume - the owner spends real
 * money on the strength of the machine's claim, and the money is gone whatever
 * the code does afterwards.
 */

/**
 * The alert configuration is absent, unparseable, or short of a setting a
 * configured rule requires. Naming the FILE and the SETTING is part of the
 * contract, exactly as `SourceConfigError` and `GovernorConfigError` do it:
 * "the alert config is wrong" is not something anybody can act on.
 */
export class AlertConfigError extends Error {
  readonly setting: string | null;

  constructor(detail: string, context: { setting?: string | null } = {}) {
    super(detail);
    this.name = "AlertConfigError";
    this.setting = context.setting ?? null;
  }
}

/**
 * The channel's credential is absent or empty where the configuration says it
 * is read from. Carries the VARIABLE NAME and never a value: this error exists
 * to be printed.
 */
export class MissingChannelCredentialError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(
      `the alert channel is configured to read its credential from the ` +
        `environment variable ${variable}, and that variable is absent or ` +
        "empty. Nothing is delivered: an unauthenticated publish to a channel " +
        "that wants a credential is answered with a refusal, and spending a " +
        "request to learn what the environment already knows helps nobody.",
    );
    this.name = "MissingChannelCredentialError";
    this.variable = variable;
  }
}
