/**
 * The evaluation run: the watchlist, once, per source, against stored history.
 *
 * IT WRITES NO PRICE OBSERVATION AND MODIFIES NONE, and that is a property of
 * its dependency list rather than of care inside the loop: there is no
 * `HistoryWriter` here, no database handle, and no way to reach one. The only
 * thing this run stores is its own cooldown bookkeeping. Price history cannot
 * be backfilled - the page a row came from is gone a week later - so the code
 * that reads it for a comparison is deliberately given no way to touch it.
 *
 * WHAT IT DOES, per enabled watchlist entry:
 *
 *   1. finds the LATEST stored observation inside the widest configured window.
 *      A listing with none is SKIPPED and reported, not failed: a listing added
 *      this morning is the ordinary case;
 *   2. evaluates each configured rule as a pure decision over that observation,
 *      that rule's own window of history, and the rule's configuration;
 *   3. for a rule that fired, asks the DURABLE cooldown whether this listing
 *      and rule are still quiet. This is the step that survives a restart, and
 *      it is why the cooldown is a table;
 *   4. composes the notification, which refuses when the entry carries no link
 *      the owner can open;
 *   5. delivers it through the governed channel, and records the cooldown ONLY
 *      where delivery succeeded.
 *
 * ONE LISTING'S ANSWER IS NOT ANOTHER'S. A skip, a currency mismatch, a
 * refused link or a failed delivery ends that listing's rule and nothing else:
 * the loop carries on. The single exception is a channel that refused the
 * CREDENTIAL, which stops delivery for the whole run because every further
 * attempt would fail identically - and even then the run keeps evaluating and
 * reporting, so the owner learns what they missed.
 */

import type {
  AlertCooldownStore,
  AlertListing,
  AlertListingStore,
  ObservationHistoryStore,
} from "@deal-sentinel/db";
import type { Clock } from "@deal-sentinel/governor";

import type { AlertChannel } from "./channel.ts";
import type { AlertConfig } from "./config.ts";
import { composeNotification } from "./notification.ts";
import { evaluateWindowLow } from "./rules.ts";
import type { PricePoint, RuleRefusal, WindowLowRule } from "./rules.ts";

export type SkippedListing = {
  listingId: string;
  /** Null when the listing was skipped before any rule was reached. */
  ruleId: string | null;
  reason: RuleRefusal | "no-observation";
  detail: string;
};

export type SuppressedAlert = {
  listingId: string;
  ruleId: string;
  /** When this listing and rule may alert again. */
  quietUntil: Date;
};

export type DeliveredAlert = {
  listingId: string;
  ruleId: string;
  status: number;
  observedMinorUnits: bigint;
  referenceMinorUnits: bigint;
  currency: string;
  /** The corroborating ending, where one matched. Never why it fired. */
  clearanceEnding: string | null;
};

export type ReportedFailure = { listingId: string; ruleId: string; detail: string };

export type AlertSourceReport = {
  sourceId: string;
  /** Every enabled listing this run looked at, in order. */
  considered: string[];
  skipped: SkippedListing[];
  /** Listings whose window holds a currency the observation cannot be compared to. */
  mismatches: ReportedFailure[];
  suppressed: SuppressedAlert[];
  /** Fired, and not sent because the entry carries no link the owner can open. */
  undeliverable: ReportedFailure[];
  delivered: DeliveredAlert[];
  /** Fired, attempted or refused, and not delivered. No cooldown was recorded. */
  failures: ReportedFailure[];
};

export type AlertRunReport = {
  startedAt: Date;
  /** How the channel is named in a report: an origin, never a whole endpoint. */
  channel: string;
  /** True when a credential refusal stopped delivery for the rest of the run. */
  channelStopped: boolean;
  sources: AlertSourceReport[];
};

export type AlertRunDependencies = {
  config: AlertConfig;
  /** The enabled watchlist, with the owner's link. */
  listings: AlertListingStore;
  /** The windowed read over stored observations. Read-only, by its own shape. */
  history: ObservationHistoryStore;
  cooldowns: AlertCooldownStore;
  channel: AlertChannel;
  clock: Clock;
  /** Which sources to evaluate, in order. */
  sourceIds: readonly string[];
};

export async function runAlertEvaluation(
  dependencies: AlertRunDependencies,
): Promise<AlertRunReport> {
  const startedAt = new Date(dependencies.clock.now());
  const report: AlertRunReport = {
    startedAt,
    channel: dependencies.channel.describedAs,
    channelStopped: false,
    sources: [],
  };

  for (const sourceId of dependencies.sourceIds) {
    report.sources.push(await runSource(sourceId, report, dependencies));
  }

  return report;
}

async function runSource(
  sourceId: string,
  report: AlertRunReport,
  dependencies: AlertRunDependencies,
): Promise<AlertSourceReport> {
  const { config, listings, history, cooldowns, channel, clock } = dependencies;
  const rules = Object.values(config.rules);
  const widestWindowMs = rules.reduce((widest, rule) => Math.max(widest, rule.windowMs), 0);
  const endings = config.clearanceEndings[sourceId] ?? [];

  const source: AlertSourceReport = {
    sourceId,
    considered: [],
    skipped: [],
    mismatches: [],
    suppressed: [],
    undeliverable: [],
    delivered: [],
    failures: [],
  };

  for (const listing of await listings.enabledFor(sourceId)) {
    source.considered.push(listing.listingId);

    const now = clock.now();
    const recent = await history.windowFor(
      listing.listingId,
      new Date(now - widestWindowMs),
      new Date(now),
    );
    const observation = recent[recent.length - 1];

    if (observation === undefined) {
      // A6: nothing stored inside the window at all. Reported, not failed.
      source.skipped.push({
        listingId: listing.listingId,
        ruleId: null,
        reason: "no-observation",
        detail:
          `no observation is stored for ${listing.listingId} inside the widest ` +
          `configured window of ${widestWindowMs}ms, so there is nothing to ` +
          "evaluate and no notification is sent for it.",
      });
      continue;
    }

    for (const rule of rules) {
      await evaluateRule(rule, observation, listing, source, report, {
        endings,
        history,
        cooldowns,
        channel,
        clock,
      });
    }
  }

  return source;
}

async function evaluateRule(
  rule: WindowLowRule,
  observation: PricePoint,
  listing: AlertListing,
  source: AlertSourceReport,
  report: AlertRunReport,
  parts: {
    endings: readonly string[];
    history: ObservationHistoryStore;
    cooldowns: AlertCooldownStore;
    channel: AlertChannel;
    clock: Clock;
  },
): Promise<void> {
  // The rule's window, anchored on the OBSERVATION's own instant rather than on
  // now, so the query asks exactly what the pure decision is about.
  const window = await parts.history.windowFor(
    listing.listingId,
    new Date(observation.observedAt.getTime() - rule.windowMs),
    observation.observedAt,
  );

  const verdict = evaluateWindowLow(observation, window, rule);

  if (!verdict.fired) {
    if (verdict.reason === "currency-mismatch") {
      source.mismatches.push({
        listingId: listing.listingId,
        ruleId: rule.ruleId,
        detail: verdict.detail,
      });
      return;
    }
    if (verdict.reason === "not-lower") return;
    source.skipped.push({
      listingId: listing.listingId,
      ruleId: rule.ruleId,
      reason: verdict.reason,
      detail: verdict.detail,
    });
    return;
  }

  // The durable half of the promise. Read before anything is composed, so a
  // listing inside its cooldown costs one query and no delivery at all.
  const now = parts.clock.now();
  const cooldown = await parts.cooldowns.read(
    listing.sourceId,
    listing.listingId,
    rule.ruleId,
  );
  if (cooldown !== null && cooldown.firedAt.getTime() + rule.cooldownMs > now) {
    source.suppressed.push({
      listingId: listing.listingId,
      ruleId: rule.ruleId,
      quietUntil: new Date(cooldown.firedAt.getTime() + rule.cooldownMs),
    });
    return;
  }

  const composed = composeNotification(verdict, listing, {
    clearanceEndings: parts.endings,
  });
  if (!composed.composed) {
    source.undeliverable.push({
      listingId: listing.listingId,
      ruleId: rule.ruleId,
      detail: composed.detail,
    });
    return;
  }

  if (report.channelStopped) {
    // The channel refused a credential earlier in this run. Nothing further is
    // attempted, and nothing is suppressed either: no cooldown is written, so
    // the next run offers this alert again.
    source.failures.push({
      listingId: listing.listingId,
      ruleId: rule.ruleId,
      detail:
        `${rule.ruleId} fired for ${listing.sourceId}/${listing.listingId} and ` +
        `was not delivered: ${report.channel} refused this run's credential ` +
        "earlier, so no further delivery was attempted. No cooldown was " +
        "recorded, so the next run will offer it again.",
    });
    return;
  }

  const outcome = await parts.channel.deliver(composed.notification);

  if (!outcome.delivered) {
    if (outcome.stopChannel) report.channelStopped = true;
    source.failures.push({
      listingId: listing.listingId,
      ruleId: rule.ruleId,
      detail: outcome.detail,
    });
    return;
  }

  // DELIVERED, and only now. The cooldown records a notification the owner
  // actually has.
  await parts.cooldowns.record({
    sourceId: listing.sourceId,
    listingId: listing.listingId,
    ruleId: rule.ruleId,
    firedAt: new Date(now),
    amountMinorUnits: observation.amountMinorUnits,
    currency: observation.currency,
  });

  source.delivered.push({
    listingId: listing.listingId,
    ruleId: rule.ruleId,
    status: outcome.status,
    observedMinorUnits: composed.notification.observedMinorUnits,
    referenceMinorUnits: composed.notification.referenceMinorUnits,
    currency: composed.notification.currency,
    clearanceEnding: composed.notification.clearance?.ending ?? null,
  });
}
