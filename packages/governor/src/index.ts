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

export { LIVE_TRANSPORT, nullNotifier, systemClock, systemRandom } from "./ports.ts";
export type {
  Clock,
  HttpTransport,
  Notification,
  NotificationKind,
  Notifier,
  RandomSource,
  TransportChoice,
  TransportRequest,
  TransportResponse,
} from "./ports.ts";

// The factory that builds a live HTTP transport is DELIBERATELY not here.
// Exporting it published an ungoverned way out of the process: one import, one
// call, and a real request left the household's IP with no ceiling, no delay,
// no robots decision, no back-pressure, no breaker and no allowance. A caller
// that wants the real client asks for `LIVE_TRANSPORT` and hands it to a
// `Governor`, which is the only thing that can redeem it, and only behind all
// six gates. `no-direct-http.ts` reports any file that reaches around this.

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
  describeRules,
  findDirectHttpCallSites,
  maskStringLiterals,
  normaliseComputedAccess,
  stripComments,
} from "./no-direct-http.ts";
export type {
  AllowlistEntry,
  DirectHttpFinding,
  ScanTarget,
  SourceFile,
} from "./no-direct-http.ts";
