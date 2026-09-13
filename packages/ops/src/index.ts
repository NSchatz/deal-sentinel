/**
 * The operator surface.
 *
 * `@deal-sentinel/ops` reads what the rest of this system already decided and
 * changes none of it: per-source health over the request record, the pause and
 * allowance state the governor keeps, and the one page an owner opens. It holds
 * no transport, adds no outbound request and opens no listening socket. Every
 * input is a port, so the whole surface is graded without a database.
 */

export {
  loadOpsConfig,
  parseOpsConfig,
  stalenessCeilingSetting,
  validateOpsConfig,
} from "./config.ts";
export type {
  DashboardSettings,
  OpsConfig,
  OpsSourceSettings,
} from "./config.ts";

export {
  MissingStalenessCeilingError,
  OpsConfigError,
  StoreUnreadableError,
  readOrRefuse,
} from "./errors.ts";

export { CHART, plotSeries } from "./chart.ts";
export type { PlottedMark } from "./chart.ts";

export {
  NOT_RECORDED_TEXT,
  UNAVAILABLE_TEXT,
  buildDashboardModel,
  dashboardStylesheet,
  known,
  renderDashboard,
  unavailable,
} from "./dashboard.ts";
export type {
  AllowanceFigure,
  DashboardDependencies,
  DashboardModel,
  Figure,
  ListingSeries,
  SourceCard,
} from "./dashboard.ts";

export { showDuration, showInstant } from "./instants.ts";

export {
  DashboardOutputError,
  OUTPUT_UNWRITABLE_EXIT_CODE,
  assertOutputWritable,
  writeDashboard,
} from "./write.ts";
export { literalAttribute, literalText } from "./text.ts";

export {
  breakerPauses,
  combinePauseReaders,
  periodStopPauses,
  readHealthReport,
  readSourceHealth,
  stopPeriodsFrom,
} from "./health.ts";
export type {
  AllowanceState,
  BreakerReader,
  HealthDependencies,
  HealthReport,
  PauseReader,
  PeriodStopReader,
  SourceHealth,
  SourcePause,
  SourceState,
} from "./health.ts";
