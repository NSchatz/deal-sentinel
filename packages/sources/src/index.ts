/**
 * The sources.
 *
 * `@deal-sentinel/sources` owns everything between the governor and the write
 * path: what each source's terms require, what the owner configured for it, the
 * adapters behind one common interface, the run over the watchlist, the
 * retention job over stored raw content, and the attribution a display or an
 * export path must carry.
 *
 * It depends on the governor, the extractor, the db package and the shared
 * types. NOTHING depends on it, which is what keeps a retailer's quirks out of
 * the four packages that were written before any retailer existed.
 *
 * The package exports no transport and constructs no client. Every adapter here
 * takes a `Governor` and calls `request`, and
 * `test/unit/no-direct-http.test.ts` fails the suite if any file under this
 * package names an HTTP client at all.
 */

export type { ObservationDraft, SourceAdapter, SourceOutcome } from "./adapter.ts";

export {
  MissingCredentialError,
  SourceConfigError,
  UnattributedEmissionError,
} from "./errors.ts";

export { BESTBUY_API_SOURCE_ID, SOURCE_TERMS, termsFor } from "./terms.ts";
export type { SourceTerms } from "./terms.ts";

export {
  DEFAULT_SOURCES_CONFIG_PATH,
  assertGovernorWithinDocumentedLimits,
  loadSourceRegistry,
  parseSourceRegistry,
  validateSourceRegistry,
} from "./registry.ts";
export type {
  AttributionRequirement,
  DocumentedLimitCheck,
  SourceEntry,
  SourceRegistry,
} from "./registry.ts";

export {
  CREDENTIAL_PLACEHOLDER,
  PARAMETER_REDACTOR,
  credentialPresent,
  credentialRedactor,
  readCredential,
  redactCredentialParameters,
} from "./credential.ts";
export type { Redactor } from "./credential.ts";

export { isValidTimeZone, readVendorTimestamp, zonedNaiveToInstant } from "./time-zone.ts";

export { mapVendorPayload } from "./bestbuy/mapping.ts";
export type { MappingSettings, VendorMapping } from "./bestbuy/mapping.ts";

export {
  REQUESTED_ATTRIBUTES,
  bestBuyAdapter,
  buildProductUrl,
  createBestBuyAdapter,
} from "./bestbuy/adapter.ts";
export type { BestBuyAdapterDependencies } from "./bestbuy/adapter.ts";

export {
  assertAttributed,
  attributedItem,
  formatMinorUnits,
  renderListingSummary,
  renderObservationExport,
} from "./attribution.ts";
export type { ExportItem } from "./attribution.ts";

export { declaredRetention, retentionHoursFor, sweepRetention } from "./retention.ts";
export type { RetentionSweep } from "./retention.ts";

export { runCollection, stopPeriodsFromGovernorConfig } from "./run.ts";
export type {
  CollectionRunDependencies,
  CollectionRunReport,
  ErroredEntry,
  FailedEntry,
  ObservedEntry,
  RefusedEntry,
  SourceRunReport,
  SourceStopReport,
} from "./run.ts";

export { resolveAdapters } from "./wiring.ts";
export type { RefusedSource, ResolvedSources } from "./wiring.ts";

export { sourcesStartCheck } from "./start-check.ts";
export type { SourceStartCheckReport } from "./start-check.ts";
