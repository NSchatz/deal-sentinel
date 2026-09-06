/**
 * The telemetry sink, wearing the redactor, and the terms the classification
 * needs.
 *
 * THE CREDENTIAL TRAVELS IN THE QUERY STRING and this vendor echoes the whole
 * URL back inside its own response body as `canonicalUrl`. A recorded condition
 * is derived from exactly those two things - a governor refusal quoting the URL
 * it would not fetch, a transport error quoting the URL it could not reach - so
 * a telemetry table is a place a key comes to rest permanently unless something
 * stops it. This module is that something, and it is HERE rather than in the
 * governor for the same reason the terms are: the governor holds no opinion
 * about any particular retailer and knows nothing about any credential.
 *
 * TWO RULES, exactly as `credential.ts` states them, and neither alone is
 * enough: the query PARAMETER (whatever its value, so a rotated key or a key
 * this process never held is still caught) and the SECRET ITSELF (wherever it
 * appears, so a value echoed back under a key nobody predicted is caught too).
 *
 * The same redactor is what a DISPLAY path takes. A row written before a fix,
 * a row written by an older build, or a row somebody put there by hand is still
 * a row a screen would otherwise show, so redaction is applied at the write and
 * again at the screen. Redacting twice costs a string scan; redacting once costs
 * a published credential, and no re-run undoes that one.
 */

import type {
  BreakerPauseStore,
  FetchOutcomeStore,
} from "@deal-sentinel/db";
import type { FetchTelemetry } from "@deal-sentinel/governor";

import { PARAMETER_REDACTOR, credentialRedactor } from "./credential.ts";
import type { Redactor } from "./credential.ts";
import type { SourceRegistry } from "./registry.ts";

/**
 * A redactor for every credential this process can see, plus the parameter rule
 * that works without seeing any.
 *
 * WHAT IT NEVER DOES is expose a credential: it reads each configured source's
 * declared variable, holds the value inside a closure that only replaces it, and
 * returns an object with no way to read one back. A process that has no
 * credential in its environment - which a read-only display process usually does
 * not - still gets the parameter rule, which is what makes a URL safe to print
 * before anybody has proved which key built it.
 */
export function displayRedactor(
  registry: SourceRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Redactor {
  const redactors: Redactor[] = [];
  for (const sourceId of registry.ids()) {
    const variable = registry.sources[sourceId].credentialVariable;
    const secret = env[variable];
    if (secret === undefined || secret.trim().length === 0) continue;
    redactors.push(credentialRedactor(secret));
  }

  return {
    scrub(text) {
      // The parameter rule first, then every secret rule. `credentialRedactor`
      // applies the parameter rule too, so the first pass is redundant when any
      // credential is present and is the ONLY pass when none is - which is the
      // case this ordering exists for.
      let scrubbed = PARAMETER_REDACTOR.scrub(text);
      for (const redactor of redactors) scrubbed = redactor.scrub(scrubbed);
      return scrubbed;
    },
  };
}

export type TelemetryWiring = {
  /** Where an outcome is written. */
  outcomes: FetchOutcomeStore;
  /** Where a pause is written. Omitted only by a caller that records neither. */
  pauses?: BreakerPauseStore;
  /** The terms each source published, and the credentials to redact. */
  registry: SourceRegistry;
  /** Overrides the redactor built from the registry. For tests. */
  redactor?: Redactor;
  /** Told when a write failed. Cannot affect the fetch; the governor sees to that. */
  onRecordFailure?(error: unknown): void;
};

/**
 * The sink the chokepoint writes through: redacted, and carrying each source's
 * published limit-exceeded statuses.
 *
 * `limitExceededStatusesFor` is what makes `blocked` mean the far side refused
 * on rate rather than "any 4xx". The sanctioned API answers an exceeded limit
 * with 403 and 403 means something else entirely at another vendor, so the
 * answer comes from `terms.ts` - the document the vendor published - and never
 * from a list in the governor.
 */
export function redactedTelemetry(wiring: TelemetryWiring): FetchTelemetry {
  const redactor = wiring.redactor ?? displayRedactor(wiring.registry);

  return {
    async record(record) {
      await wiring.outcomes.record({
        sourceId: record.sourceId,
        outcomeClass: record.outcomeClass,
        latencyMs: record.latencyMs,
        occurredAt: record.occurredAt,
        condition:
          record.condition === null ? null : redactor.scrub(record.condition),
      });
    },

    async recordPause(pause) {
      if (wiring.pauses === undefined) return;
      await wiring.pauses.record({
        sourceId: pause.sourceId,
        pausedAt: pause.pausedAt,
        expiresAt: pause.expiresAt,
        failingCount: pause.failingCount,
        windowOutcomes: pause.windowOutcomes,
        windowMs: pause.windowMs,
        failureRateThreshold: pause.failureRateThreshold,
        condition: redactor.scrub(pause.condition),
      });
    },

    limitExceededStatusesFor(sourceId) {
      return wiring.registry.sources[sourceId]?.terms?.limitExceededStatuses ?? [];
    },

    onRecordFailure(error) {
      wiring.onRecordFailure?.(error);
    },
  };
}
