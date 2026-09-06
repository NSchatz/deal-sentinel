/**
 * The alerts.
 *
 * `@deal-sentinel/alerts` owns everything between the stored price history and
 * the owner's phone: the rules that decide a price is worth interrupting
 * somebody for, the notification each firing composes, the cooldown that keeps
 * them rare, and the one operator-configured channel they leave through.
 *
 * It depends on the db package for the history read and its own bookkeeping, on
 * the governor for the way out of the process, and on the extractor for the one
 * exponent table that decides how a minor-unit integer is printed. NOTHING
 * depends on it, and it does not depend on `@deal-sentinel/sources`: a rule is
 * about a stored number and knows nothing about which retailer produced it.
 *
 * The package exports no transport and constructs no client. The channel takes
 * a `Governor` and calls `request`, and `test/unit/no-direct-http.test.ts`
 * fails the suite if any file under this package names an HTTP client at all.
 */

export { AlertConfigError, MissingChannelCredentialError } from "./errors.ts";

export { evaluateWindowLow } from "./rules.ts";
export type { PricePoint, RuleRefusal, RuleVerdict, WindowLowRule } from "./rules.ts";

export { clearanceTagFor } from "./clearance.ts";
export type { ClearanceTag } from "./clearance.ts";

export {
  DEFAULT_ALERTS_CONFIG_PATH,
  loadAlertConfig,
  parseAlertConfig,
  validateAlertConfig,
} from "./config.ts";
export type {
  AlertChannelConfig,
  AlertChannelCredential,
  AlertConfig,
} from "./config.ts";

export {
  CREDENTIAL_PLACEHOLDER,
  channelOrigin,
  channelRedactor,
  redactCredentialParameters,
  redactUrlCredentials,
  redactUrlUserinfo,
} from "./redaction.ts";
export type { Redactor } from "./redaction.ts";

export { composeNotification } from "./notification.ts";
export type { AlertNotification, AlertSubject, Composition } from "./notification.ts";

export { createGovernedChannel, governedChannel } from "./channel.ts";
export type {
  AlertChannel,
  DeliveryOutcome,
  GovernedChannelDependencies,
  GovernedChannelParts,
} from "./channel.ts";

export { runAlertEvaluation } from "./run.ts";
export type {
  AlertRunDependencies,
  AlertRunReport,
  AlertSourceReport,
  DeliveredAlert,
  ReportedFailure,
  SkippedListing,
  SuppressedAlert,
} from "./run.ts";

export { alertsStartCheck } from "./start-check.ts";
export type { AlertStartCheckReport, RuleReport } from "./start-check.ts";
