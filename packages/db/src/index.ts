/**
 * The history store.
 *
 * `@deal-sentinel/db` owns the schema, the migrations, the guarded write path,
 * the one-time initialization action, the ordinary start path's refusal, and
 * the backup and restore scripts beside them. It depends on
 * `@deal-sentinel/shared` and nothing else in this repo: a later adapter
 * depends on this package and on the extractor, never the reverse.
 */

export {
  DATABASE_URL_VARIABLE,
  createDatabase,
  createPool,
  historyDatabaseUrl,
  redactUrl,
} from "./connection.ts";
export type { HistoryDatabase } from "./connection.ts";

export {
  HistoryAlreadyInitializedError,
  HistoryNotInitializedError,
  InvalidObservationError,
  MissingDatabaseUrlError,
} from "./errors.ts";

export {
  MIGRATIONS_FOLDER,
  SCHEMA_VERSION,
  initializeHistory,
  readMarker,
} from "./initialize.ts";
export type { InitializationResult } from "./initialize.ts";

export { assertHistoryInitialized } from "./start-check.ts";
export type { InitializationMarker } from "./start-check.ts";

export {
  RAW_CONTEXT_MAX_CHARS,
  alertCooldowns,
  governorAllowanceUsage,
  historyInitialization,
  priceObservations,
  requestOutcomes,
  sourcePeriodStops,
  watchlistEntries,
} from "./schema.ts";
export type {
  AlertCooldownRow,
  GovernorAllowanceUsageRow,
  InitializationMarkerRow,
  NewPriceObservationRow,
  NewRequestOutcomeRow,
  NewWatchlistEntryRow,
  PriceObservationRow,
  RequestOutcomeRow,
  SourcePeriodStopRow,
  WatchlistEntryRow,
} from "./schema.ts";

export {
  drizzleRequestOutcomes,
  emptyCounts,
  memoryRequestOutcomes,
} from "./request-outcomes.ts";
export type {
  OutcomeCountsReport,
  OutcomeWindow,
  RequestOutcome,
  RequestOutcomeStore,
  SourceOutcomeCounts,
} from "./request-outcomes.ts";

export { boundRawContext, drizzleWriter, recordObservation } from "./write-path.ts";
export type {
  HistoryWriter,
  WriteAccepted,
  WriteOutcome,
  WriteRefused,
} from "./write-path.ts";

export {
  addWatchlistEntry,
  drizzleAlertListings,
  drizzleWatchlist,
  memoryAlertListings,
  memoryWatchlist,
  setWatchlistEntryEnabled,
} from "./watchlist.ts";
export type {
  AlertListing,
  AlertListingStore,
  WatchlistEntry,
  WatchlistStore,
} from "./watchlist.ts";

export {
  drizzleObservationHistory,
  memoryObservationHistory,
} from "./observations.ts";
export type { ObservationHistoryStore, ObservationPoint } from "./observations.ts";

export { drizzleAlertCooldowns, memoryAlertCooldowns } from "./alert-state.ts";
export type { AlertCooldown, AlertCooldownStore } from "./alert-state.ts";

export { sweepExpiredRawContent } from "./retention.ts";
export type { RetentionSweep } from "./retention.ts";

export { drizzleSourceStops, memorySourceStops } from "./source-stops.ts";
export type { SourceStop, SourceStopStore } from "./source-stops.ts";
