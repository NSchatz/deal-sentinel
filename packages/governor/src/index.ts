/**
 * The governor.
 *
 * `@deal-sentinel/governor` owns every outbound HTTP request this system makes:
 * the per-host ceiling and its randomised delay, the robots.txt gate with the
 * standard's unreachable-means-disallow fail-safe, `Retry-After` in both legal
 * forms, the per-source circuit breaker, and central allowance accounting that
 * survives a restart.
 *
 * An adapter takes a `Governor` and calls `request`. It does not take a
 * transport, it does not import an HTTP client, and there is a test that fails
 * the suite if it tries.
 */

export { Governor } from "./governor.ts";
export type {
  GovernedRequest,
  GovernedResponse,
  GovernorDependencies,
  GovernorOutcome,
  RefusalReason,
} from "./governor.ts";

export {
  ROBOTS_CACHE_BOUND_CEILING_MS,
  ROBOTS_PARSING_LIMIT_FLOOR_BYTES,
  hostKey,
  loadGovernorConfig,
  parseGovernorConfig,
  validateGovernorConfig,
} from "./config.ts";
export type {
  AllowanceSettings,
  BreakerSettings,
  GovernorConfig,
  HostCeiling,
  SourceSettings,
} from "./config.ts";

export { GovernorConfigError, InvalidRequestError } from "./errors.ts";

export { AllowanceLedger, periodStartFor } from "./allowance.ts";
export type { AllowanceRecord, AllowanceStore, AllowanceVerdict } from "./allowance.ts";
export { createMemoryAllowanceStore } from "./allowance-store-memory.ts";
export { createPostgresAllowanceStore } from "./allowance-store-postgres.ts";

export { Breaker } from "./breaker.ts";
export type { BreakerStatus, OutcomeClass } from "./breaker.ts";

export { HostScheduler } from "./host-scheduler.ts";
export type { Release } from "./host-scheduler.ts";

export { RobotsGate, classifyRobotsStatus } from "./robots.ts";
export type { RobotsDecision, RobotsRetrieval } from "./robots.ts";
export {
  decidePath,
  matchesPattern,
  normalisePath,
  parseRobotsTxt,
  selectGroup,
} from "./robots-parse.ts";
export type { RobotsFile, RobotsGroup, RobotsRule, RobotsVerdict } from "./robots-parse.ts";

export { holdForResponse, readRetryAfter } from "./retry-after.ts";
export type { RetryAfterReading } from "./retry-after.ts";

export { nullNotifier, systemClock, systemRandom } from "./ports.ts";
export type {
  Clock,
  HttpTransport,
  Notification,
  NotificationKind,
  Notifier,
  RandomSource,
  TransportRequest,
  TransportResponse,
} from "./ports.ts";

export { createFetchTransport } from "./transport.ts";

export {
  DEFAULT_CONFIG_PATH,
  createSystemGovernor,
  governorStartCheck,
} from "./system.ts";
export type { StartCheckReport } from "./system.ts";

export {
  HTTP_CLIENT_ALLOWLIST,
  collectSourceFiles,
  describeFindings,
  findDirectHttpCallSites,
  stripComments,
} from "./no-direct-http.ts";
export type { AllowlistEntry, DirectHttpFinding, SourceFile } from "./no-direct-http.ts";
