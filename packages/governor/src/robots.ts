/**
 * The robots gate: retrieval, the failure asymmetry, the cache bound.
 *
 * The asymmetry is the whole point, and it is specified. RFC 9309 2.3.1.3,
 * "Unavailable": "If a server status code indicates that the robots.txt file is
 * unavailable to the crawler, then the crawler MAY access any resources on the
 * server." RFC 9309 2.3.1.4, "Unreachable": "If the robots.txt file is
 * unreachable due to server or network errors, this means the robots.txt file
 * is undefined and the crawler MUST assume complete disallow."
 *
 * A 404 OPENS a host. A 500, a timeout or a DNS failure CLOSES it. The natural
 * implementation - treat any non-200 as "no rules, proceed" - is one line, is
 * what a careless HTTP wrapper does by default, inverts a MUST, and does so at
 * exactly the moment a site is under load and least wants traffic.
 *
 * 2.4 bounds the cache: "Crawlers SHOULD NOT use the cached version for more
 * than 24 hours", which `config.robots.cacheBoundMs` may not exceed.
 */

import type { GovernorConfig } from "./config.ts";
import type { RefusalReason } from "./errors.ts";
import type { Clock } from "./ports.ts";
import { decidePath, parseRobotsTxt, selectGroup } from "./robots-parse.ts";
import type { RobotsFile, RobotsRule } from "./robots-parse.ts";

/**
 * What a retrieval of `/robots.txt` produced, already classified.
 *
 * `refused` is not a fourth flavour of the other three: the first three are
 * things we learned about the HOST, and `refused` is the governor declining to
 * go and ask - its own breaker, its own allowance. Nothing about the host was
 * learned, so `refused` is never cached and never decides anything.
 */
export type RobotsRetrieval =
  | { kind: "rules"; body: string; truncated: boolean }
  | { kind: "unavailable"; detail: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "refused"; reason: RefusalReason; detail: string };

export type RobotsDecision =
  | { state: "allowed"; rule: RobotsRule | null; detail: string }
  | { state: "disallowed"; rule: RobotsRule; detail: string }
  | { state: "unreachable"; detail: string }
  | { state: "refused"; reason: RefusalReason; detail: string };

type CacheEntry = {
  fetchedAt: number;
  value:
    | { kind: "rules"; file: RobotsFile; truncated: boolean }
    | { kind: "unavailable"; detail: string }
    | { kind: "unreachable"; detail: string }
    | { kind: "refused"; reason: RefusalReason; detail: string };
};

/** Classify an HTTP status for the robots file. The two sides are not symmetric. */
export function classifyRobotsStatus(status: number): "rules" | "unavailable" | "unreachable" {
  if (status >= 200 && status < 300) return "rules";
  // 3xx surfacing here means the redirect chain was not followed to a resource
  // (2.3.1.2 asks for at least five). Undefined content, so: unreachable.
  if (status >= 400 && status < 500) return "unavailable";
  return "unreachable";
}

export class RobotsGate {
  readonly #config: GovernorConfig;
  readonly #clock: Clock;
  readonly #retrieve: (origin: string, sourceId: string) => Promise<RobotsRetrieval>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<CacheEntry>>();

  constructor(dependencies: {
    config: GovernorConfig;
    clock: Clock;
    retrieve: (origin: string, sourceId: string) => Promise<RobotsRetrieval>;
  }) {
    this.#config = dependencies.config;
    this.#clock = dependencies.clock;
    this.#retrieve = dependencies.retrieve;
  }

  /** How many times this gate has actually gone to the network, for the cache test. */
  retrievals = 0;

  async decide(url: URL, sourceId: string): Promise<RobotsDecision> {
    const origin = url.origin;
    const entry = await this.#entryFor(origin, sourceId);

    if (entry.value.kind === "refused") {
      // The retrieval never happened, so there is no verdict here to report and
      // none was stored. The caller surfaces the refusal that actually
      // happened; asking again later asks the host again.
      return { state: "refused", reason: entry.value.reason, detail: entry.value.detail };
    }

    if (entry.value.kind === "unreachable") {
      return {
        state: "unreachable",
        detail:
          `${origin}/robots.txt is unreachable (${entry.value.detail}), so RFC ` +
          "9309 2.3.1.4 makes this host completely disallowed and the fetch is " +
          "skipped.",
      };
    }

    if (entry.value.kind === "unavailable") {
      return {
        state: "allowed",
        rule: null,
        detail:
          `${origin}/robots.txt is unavailable (${entry.value.detail}), so RFC ` +
          "9309 2.3.1.3 says this host carries no rules. This system's own " +
          "per-host ceiling and delay still apply: the standard sets no rate.",
      };
    }

    const rules = selectGroup(entry.value.file, this.#config.robots.productToken);
    const verdict = decidePath(rules, `${url.pathname}${url.search}`);
    if (verdict.allowed) {
      return {
        state: "allowed",
        rule: verdict.rule,
        detail:
          verdict.rule === null
            ? `no rule in the group applying to ${this.#config.robots.productToken} matches ${url.pathname}`
            : `allow: ${verdict.rule.pattern} is the most specific match for ${url.pathname}`,
      };
    }

    return {
      state: "disallowed",
      // decidePath only reports `allowed: false` with the rule that decided it.
      rule: verdict.rule as RobotsRule,
      detail:
        `disallow: ${verdict.rule?.pattern ?? ""} is the most specific match ` +
        `for ${url.pathname} in the group applying to ` +
        `${this.#config.robots.productToken}`,
    };
  }

  /** Drop the cached decision for one origin. Exposed for operators, not tests. */
  forget(origin: string): void {
    this.#cache.delete(origin);
  }

  async #entryFor(origin: string, sourceId: string): Promise<CacheEntry> {
    const cached = this.#cache.get(origin);
    if (
      cached !== undefined &&
      this.#clock.now() - cached.fetchedAt < this.#config.robots.cacheBoundMs
    ) {
      return cached;
    }

    // One retrieval per origin at a time, however many callers are waiting.
    // A waiter that joins a retrieval which is then REFUSED inherits that
    // refusal for this attempt only: nothing is cached, so its next attempt
    // asks the host again, and the direction of the error is fewer requests.
    const existing = this.#inFlight.get(origin);
    if (existing !== undefined) return existing;

    const pending = this.#retrieveAndCache(origin, sourceId);
    this.#inFlight.set(origin, pending);
    try {
      return await pending;
    } finally {
      this.#inFlight.delete(origin);
    }
  }

  async #retrieveAndCache(origin: string, sourceId: string): Promise<CacheEntry> {
    this.retrievals += 1;
    const retrieval = await this.#retrieve(origin, sourceId);
    const fetchedAt = this.#clock.now();

    const entry: CacheEntry =
      retrieval.kind === "rules"
        ? {
            fetchedAt,
            value: {
              kind: "rules",
              file: parseRobotsTxt(retrieval.body, retrieval.truncated),
              truncated: retrieval.truncated,
            },
          }
        : { fetchedAt, value: retrieval };

    // A refusal is not a verdict about this host, so it does not become one.
    // Caching it would hold a host completely disallowed - for EVERY source,
    // because this cache is keyed by origin - for the whole cache bound, long
    // after the pause or the allowance period that caused it had cleared.
    if (entry.value.kind !== "refused") this.#cache.set(origin, entry);
    return entry;
  }
}
