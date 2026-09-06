/**
 * THE RULE, AS A PURE DECISION.
 *
 * `evaluateWindowLow` takes exactly three things - the observation, the history
 * window and the rule configuration - and returns a verdict. It reads NO wall
 * clock, NO randomness, NO database and NO environment, which is what makes
 * "the same verdict on every run" a property of the function's arguments rather
 * than a claim about a test run. Over-alerting is then something a test can
 * demonstrate against a synthetic series instead of something the owner
 * discovers by living with it.
 *
 * The window is derived from the OBSERVATION'S OWN INSTANT and not from now:
 * `(observedAt - windowMs, observedAt)`, OPEN AT BOTH ENDS. That is the only
 * choice that keeps the function pure, and it is also the right reading of "a
 * 90-day low" - the question is whether this price beats the last ninety days as
 * of when it was seen, which is a fact that stays true after the fact. The upper
 * end is open because the observation is not a reference for itself: closing it
 * would mean a listing holding one stored row "holds one observation in the
 * window", which is exactly the weakening the minimum-count assertion exists to
 * prevent.
 *
 * EVERY NUMBER IS A `bigint` MINOR UNIT. Nothing here divides, no percentage is
 * computed, no `Number` touches a price. The improvement margin is configured
 * in minor units for that reason: a percentage of an integer is a rational
 * number, and the cheap way to compute one introduces the first float on a path
 * that runs from a stored row to a claim about money.
 *
 * FOUR REFUSALS, in the order they are asked, and the order is deliberate:
 *
 *   1. AN EMPTY WINDOW. A listing with no stored observation inside the window
 *      is skipped, not failed: a freshly added listing is the ordinary case,
 *      and a run that reported it as an error would train the owner to ignore
 *      the report.
 *   2. A CURRENCY THAT DISAGREES. Two amounts in different currencies are not
 *      comparable, and comparing them anyway produces a confident all-time low
 *      that is arithmetic about nothing. Asked before the minimum count so that
 *      the defect is REPORTED rather than hidden behind "not enough history
 *      yet"; neither path notifies, so nothing turns on the order but what the
 *      owner gets told.
 *   3. TOO LITTLE HISTORY. Below the rule's own minimum the rule is not
 *      evaluated at all. This is the assertion that stops a listing added
 *      yesterday declaring an all-time low on its second day, which is the
 *      quickest way to teach an owner that these alerts mean nothing.
 *   4. NOT LOW ENOUGH. The ordinary answer, and the quiet one.
 */

/** A price, as it is stored and as it is compared: exact, and carrying its code. */
export type PricePoint = {
  /** Exact integer in the currency's own minor unit. Never a float. */
  amountMinorUnits: bigint;
  /** ISO 4217 alphabetic code, upper case. */
  currency: string;
  observedAt: Date;
};

/**
 * The one rule type this phase ships: is this the lowest price inside a window,
 * by at least a margin?
 *
 * Every number is configuration and none of them is a default. The roadmap
 * phase says thresholds, windows and cooldown lengths are OUTPUTS of living
 * with the system, and CLAUDE.md rule 8 forbids inventing one and treating it
 * as decided.
 */
export type WindowLowRule = {
  /** How `config/alerts.json` names it. This is what a notification says fired. */
  ruleId: string;
  kind: "window-low";
  /** How far back the comparison looks, from the observation's own instant. */
  windowMs: number;
  /** How many observations must be inside that window before it is evaluated. */
  minimumObservations: number;
  /**
   * How much lower than the reference the observation must be, in the same
   * minor units. Zero means "at least equal to the previous low", which is a
   * different rule than "beats it", so the number is required and not defaulted.
   */
  improvementMinorUnits: bigint;
  /** How long this rule stays quiet for a listing after it fires. */
  cooldownMs: number;
};

export type RuleRefusal =
  | "empty-window"
  | "currency-mismatch"
  | "insufficient-history"
  | "not-lower";

export type RuleVerdict =
  | {
      fired: true;
      ruleId: string;
      observed: PricePoint;
      /** The lowest observation inside the window - what the alert says it beat. */
      reference: PricePoint;
      /** How many observations were inside the window, reference included. */
      windowCount: number;
    }
  | {
      fired: false;
      ruleId: string;
      reason: RuleRefusal;
      /** Never a price the caller did not already have; safe to print. */
      detail: string;
      windowCount: number;
    };

/**
 * Evaluate one window-low rule against one observation.
 *
 * `history` is every stored observation for this listing that the caller could
 * find; this function does the windowing itself, so the window is part of the
 * decision rather than part of the query the caller happened to write. Entries
 * at or after the observation's own instant are ignored: an observation is not
 * a reference for itself, and a row from the future is not history.
 */
export function evaluateWindowLow(
  observation: PricePoint,
  history: readonly PricePoint[],
  rule: WindowLowRule,
): RuleVerdict {
  const until = observation.observedAt.getTime();
  const after = until - rule.windowMs;
  const window = history.filter((point) => {
    const at = point.observedAt.getTime();
    return at > after && at < until;
  });

  if (window.length === 0) {
    return {
      fired: false,
      ruleId: rule.ruleId,
      reason: "empty-window",
      detail:
        `no stored observation falls inside the ${rule.windowMs}ms window ` +
        `ending ${observation.observedAt.toISOString()}, so there is nothing ` +
        "to compare against and the listing is skipped.",
      windowCount: 0,
    };
  }

  const mismatched = window.find((point) => point.currency !== observation.currency);
  if (mismatched !== undefined) {
    return {
      fired: false,
      ruleId: rule.ruleId,
      reason: "currency-mismatch",
      detail:
        `the observation is in ${observation.currency} and the window holds an ` +
        `observation in ${mismatched.currency}, recorded ` +
        `${mismatched.observedAt.toISOString()}. Two amounts in different ` +
        "currencies are not comparable, so no rule is evaluated across this " +
        "pair and no notification is sent for it.",
      windowCount: window.length,
    };
  }

  if (window.length < rule.minimumObservations) {
    return {
      fired: false,
      ruleId: rule.ruleId,
      reason: "insufficient-history",
      detail:
        `${window.length} observation(s) inside the window, and ${rule.ruleId} ` +
        `requires ${rule.minimumObservations}. The rule is not evaluated ` +
        "against this listing.",
      windowCount: window.length,
    };
  }

  const reference = lowest(window);
  // Exact integers throughout: a + b <= c, never a percentage and never a
  // division. Reading it as "the observation plus the margin still does not
  // reach the reference" is the same statement without a subtraction that
  // could go negative.
  const fires =
    observation.amountMinorUnits + rule.improvementMinorUnits <=
    reference.amountMinorUnits;

  if (!fires) {
    return {
      fired: false,
      ruleId: rule.ruleId,
      reason: "not-lower",
      detail:
        `${observation.amountMinorUnits} minor units does not beat the window ` +
        `low of ${reference.amountMinorUnits} by the configured margin of ` +
        `${rule.improvementMinorUnits}.`,
      windowCount: window.length,
    };
  }

  return {
    fired: true,
    ruleId: rule.ruleId,
    observed: observation,
    reference,
    windowCount: window.length,
  };
}

/**
 * The lowest point in a window, ties broken by the EARLIER instant.
 *
 * The tie-break is not cosmetic. Without one, two observations at the same
 * price make the reference depend on the order rows came back in, and the
 * determinism assertion would hold for the verdict but not for the reference
 * price the notification prints.
 */
function lowest(window: readonly PricePoint[]): PricePoint {
  let best = window[0];
  for (const point of window.slice(1)) {
    if (point.amountMinorUnits < best.amountMinorUnits) {
      best = point;
      continue;
    }
    if (
      point.amountMinorUnits === best.amountMinorUnits &&
      point.observedAt.getTime() < best.observedAt.getTime()
    ) {
      best = point;
    }
  }
  return best;
}
