/**
 * The operator view.
 *
 * `@deal-sentinel/dashboard` owns the read-only local view over what the
 * governor already decided: per-source health from the recorded fetch outcomes,
 * the allowance consumed and remaining for the current period, breaker pauses
 * and vendor stops with the conditions that caused them, and any tracked
 * listing's observed price history as a time series.
 *
 * It depends on `db` for the reads, on `governor` for the configuration that
 * says which sources exist and what each one's allowance is, on `sources` for
 * the attribution obligation and the redactor, and on `extractor` for money.
 * NOTHING depends on it.
 *
 * IT CANNOT SEND. There is no governor here, no adapter and no transport, and
 * `test/unit/no-direct-http.test.ts` fails the suite if any file under this
 * package names an HTTP client. The one thing it takes from `node:http` is
 * `createServer`, which accepts connections and does nothing else.
 *
 * IT CANNOT WRITE. Every read it makes is a SELECT, and the allowance in
 * particular is read as rows rather than through the ledger, whose read
 * announces a stop and claims the period's once-only mark.
 */

export {
  DEFAULT_DASHBOARD_CONFIG_PATH,
  isLoopbackAddress,
  loadDashboardConfig,
  parseDashboardConfig,
  validateDashboardConfig,
} from "./config.ts";
export type { DashboardConfig } from "./config.ts";

export { DashboardConfigError } from "./errors.ts";

export { buildListingView, buildOverview, decideVerdict, ratesFrom } from "./view.ts";
export type {
  AllowanceView,
  HealthVerdict,
  ListingRange,
  ListingView,
  ListingViewDependencies,
  OutcomeCounts,
  OutcomeRates,
  Overview,
  OverviewDependencies,
  SourceHealth,
} from "./view.ts";

export {
  escape,
  renderDatabaseUnreachable,
  renderListing,
  renderMethodNotAllowed,
  renderNotFound,
  renderOverview,
  renderSchemaBehind,
} from "./render.ts";
export type { RenderContext } from "./render.ts";

export { READ_METHODS, answer, startDashboard } from "./server.ts";
export type {
  DashboardAnswer,
  DashboardDependencies,
  DashboardServer,
} from "./server.ts";

export { dashboardStartCheck } from "./start-check.ts";
export type { DashboardStartCheckReport } from "./start-check.ts";
