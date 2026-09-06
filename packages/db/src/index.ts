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
  OpsSchemaBehindError,
} from "./errors.ts";

export {
  MIGRATIONS_FOLDER,
  SCHEMA_VERSION,
  applyMigrations,
  initializeHistory,
  readMarker,
} from "./initialize.ts";
export type { InitializationResult } from "./initialize.ts";

export { assertHistoryInitialized } from "./start-check.ts";
export type { InitializationMarker } from "./start-check.ts";

export {
  FETCH_OUTCOME_CLASSES,
  RAW_CONTEXT_MAX_CHARS,
  alertCooldowns,
  breakerPauses,
  fetchOutcomes,
  governorAllowanceUsage,
  historyInitialization,
  priceObservations,
  sourcePeriodStops,
  watchlistEntries,
} from "./schema.ts";
export type {
  AlertCooldownRow,
  BreakerPauseRow,
  FetchOutcomeClass,
  FetchOutcomeRow,
  GovernorAllowanceUsageRow,
  InitializationMarkerRow,
  NewBreakerPauseRow,
  NewFetchOutcomeRow,
  NewPriceObservationRow,
  NewWatchlistEntryRow,
  PriceObservationRow,
  SourcePeriodStopRow,
  WatchlistEntryRow,
} from "./schema.ts";

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

export {
  OPS_TABLES,
  assertOpsSchema,
  drizzleBreakerPauses,
  drizzleFetchOutcomes,
  memoryBreakerPauses,
  memoryFetchOutcomes,
} from "./telemetry.ts";
export type {
  BreakerPauseEntry,
  BreakerPauseStore,
  FetchOutcomeEntry,
  FetchOutcomeStore,
} from "./telemetry.ts";

export {
  allowanceUsageFor,
  breakerPauseHistory,
  countFetchOutcomes,
  currentBreakerPause,
  currentSourceStop,
  lastSuccessInstants,
  observedPrices,
  recentConditions,
  sourceStopHistory,
  trackedListing,
  trackedListings,
} from "./ops-read.ts";
export type {
  AllowanceUsageReading,
  BreakerPauseReading,
  FetchOutcomeCount,
  ObservedPrice,
  RecentFetchOutcome,
  SourceStopReading,
  TrackedListing,
} from "./ops-read.ts";
