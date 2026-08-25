/**
 * THE CHOKEPOINT. Every outbound HTTP request this system will ever make goes
 * through `Governor.fetch`, and there is no second way out of the process.
 *
 * Why this exists before the second source does, in the words of the repository
 * card: this system "acts on third parties from the household's residential IP,
 * and keeping that IP in good standing is part of the point, so a runaway
 * scraper burns something the whole house depends on and no re-run undoes it".
 * A block earned against a residential address is shared by everyone in the
 * house. So is a burned free allowance. Neither is undone by a re-run.
 *
 * The order of the gates below is not arbitrary. Each one is cheaper than the
 * next and each one can only ever reduce the traffic that leaves:
 *
 *   1. the host has a configured ceiling, or the request is refused. There is
 *      no default-permissive rate anywhere in this package;
 *   2. the source is one this governor has been configured for;
 *   3. the source is not paused by its breaker;
 *   4. the source has allowance left for this period;
 *   5. this host's robots.txt allows this path - and an UNREACHABLE robots.txt
 *      disallows everything (RFC 9309 2.3.1.4), which is the gate that has to
 *      be wrong in the safe direction;
 *   6. the host's ceiling, its randomised delay and any back-pressure hold have
 *      all been satisfied.
 *
 * Only then does a request leave, and the moment it leaves it is counted
 * against the source's allowance - whatever comes back.
 */

import { hostKey } from "./config.ts";
import type { BreakerSettings, GovernorConfig } from "./config.ts";
import { AllowanceLedger } from "./allowance.ts";
import type { AllowanceStore } from "./allowance.ts";
import { Breaker } from "./breaker.ts";
import type { OutcomeClass } from "./breaker.ts";
import { InvalidRequestError } from "./errors.ts";
import { HostScheduler } from "./host-scheduler.ts";
import type { Release } from "./host-scheduler.ts";
import type {
  Clock,
  HttpTransport,
  Notifier,
  RandomSource,
  TransportResponse,
} from "./ports.ts";
import { holdForResponse } from "./retry-after.ts";
import { RobotsGate, classifyRobotsStatus } from "./robots.ts";
import type { RobotsRetrieval } from "./robots.ts";

export type GovernedRequest = {
  url: string;
  /** Which adapter is asking. The breaker and the allowance key on this. */
  sourceId: string;
  method?: string;
  headers?: Record<string, string>;
  /** Overrides `config.http.maxResponseBytes` downwards for one request. */
  maxBytes?: number;
};

export type RefusalReason =
  | "unconfigured-host"
  | "unknown-source"
  | "source-paused"
  | "allowance-exhausted"
  | "robots-unreachable"
  | "robots-disallowed"
  | "transport-error";

export type GovernedResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

export type GovernorOutcome =
  | { ok: true; response: GovernedResponse; release: Release }
  | { ok: false; reason: RefusalReason; detail: string };

export type GovernorDependencies = {
  config: GovernorConfig;
  clock: Clock;
  random: RandomSource;
  transport: HttpTransport;
  notifier: Notifier;
  allowanceStore: AllowanceStore;
};

export class Governor {
  readonly #config: GovernorConfig;
  readonly #clock: Clock;
  readonly #transport: HttpTransport;
  readonly #notifier: Notifier;
  readonly #scheduler: HostScheduler;
  readonly #breaker: Breaker;
  readonly #allowance: AllowanceLedger;
  readonly #robots: RobotsGate;

  constructor(dependencies: GovernorDependencies) {
    this.#config = dependencies.config;
    this.#clock = dependencies.clock;
    this.#transport = dependencies.transport;
    this.#notifier = dependencies.notifier;

    this.#scheduler = new HostScheduler({
      clock: dependencies.clock,
      random: dependencies.random,
    });

    this.#breaker = new Breaker({
      clock: dependencies.clock,
      settingsFor: (sourceId) => this.#breakerSettingsFor(sourceId),
    });

    this.#allowance = new AllowanceLedger({
      store: dependencies.allowanceStore,
      clock: dependencies.clock,
      notifier: dependencies.notifier,
      settingsFor: (sourceId) => this.#config.sources[sourceId]?.allowance,
    });

    this.#robots = new RobotsGate({
      config: dependencies.config,
      clock: dependencies.clock,
      retrieve: (origin, sourceId) => this.#retrieveRobots(origin, sourceId),
    });
  }

  /**
   * The one entry point. Nothing in this repository may reach a client itself.
   *
   * Named `request` and not `fetch` on purpose: `test/unit/no-direct-http.test.ts`
   * treats a bare `fetch(` anywhere outside `transport.ts` as a bypass, and a
   * check with an exception carved out for the shape of our own method name is
   * a check with a hole in it.
   */
  async request(request: GovernedRequest): Promise<GovernorOutcome> {
    const url = parseUrl(request.url);
    const host = hostKey(url);

    const ceiling = this.#config.hosts[host];
    if (ceiling === undefined) {
      // No fallback, no default-permissive rate, no "unknown hosts get the
      // slowest ceiling". A host nobody has thought about is a host nobody has
      // decided a polite rate for.
      return {
        ok: false,
        reason: "unconfigured-host",
        detail:
          `${host} carries no configured request ceiling, so the request to ` +
          `${url.href} is refused. Add an entry under "hosts" deliberately; ` +
          "there is no default rate to fall back to.",
      };
    }

    if (this.#config.sources[request.sourceId] === undefined) {
      return {
        ok: false,
        reason: "unknown-source",
        detail:
          `${request.sourceId} is not a configured source, so its breaker ` +
          "settings and its allowance are unknown and the request is refused.",
      };
    }

    const paused = this.#breaker.status(request.sourceId);
    if (paused.paused) {
      return {
        ok: false,
        reason: "source-paused",
        detail: `${request.sourceId} is paused by its breaker: ${paused.detail}`,
      };
    }

    const allowance = await this.#allowance.check(request.sourceId);
    if (allowance.stopped) {
      return {
        ok: false,
        reason: "allowance-exhausted",
        detail: `${request.sourceId} is stopped for this period: ${allowance.detail}`,
      };
    }

    const robots = await this.#robots.decide(url, request.sourceId);
    if (robots.state === "unreachable") {
      return { ok: false, reason: "robots-unreachable", detail: robots.detail };
    }
    if (robots.state === "disallowed") {
      return { ok: false, reason: "robots-disallowed", detail: robots.detail };
    }

    return await this.#send(url, request);
  }

  /** Whether a host is currently held by back-pressure, for operator surfaces. */
  heldUntil(host: string): number {
    return this.#scheduler.heldUntil(host);
  }

  async #send(
    url: URL,
    request: GovernedRequest,
    classify: (status: number) => OutcomeClass = defaultOutcomeClass,
  ): Promise<GovernorOutcome> {
    const host = hostKey(url);
    const ceiling = this.#config.hosts[host];
    if (ceiling === undefined) {
      throw new InvalidRequestError(
        `${host} lost its ceiling between the gate and the release; refusing.`,
      );
    }

    const release = await this.#scheduler.release(host, ceiling);

    // Asked again on the far side of the wait: a request that queued behind the
    // ceiling for an hour must not spend an allowance the period has meanwhile
    // used up.
    const allowance = await this.#allowance.check(request.sourceId);
    if (allowance.stopped) {
      return {
        ok: false,
        reason: "allowance-exhausted",
        detail: `${request.sourceId} is stopped for this period: ${allowance.detail}`,
      };
    }

    // Counted HERE, one line before the request leaves the process, so an
    // error, a 403 and a block are all counted exactly like a success.
    await this.#allowance.count(request.sourceId);

    let response: TransportResponse;
    try {
      response = await this.#transport.send({
        url: url.href,
        method: request.method ?? "GET",
        headers: {
          "user-agent": this.#config.userAgent,
          ...(request.headers ?? {}),
        },
        timeoutMs: this.#config.http.requestTimeoutMs,
        maxBytes: request.maxBytes ?? this.#config.http.maxResponseBytes,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#recordOutcome(request.sourceId, "failure");
      return {
        ok: false,
        reason: "transport-error",
        detail: `${url.href} could not be reached: ${detail}`,
      };
    }

    this.#applyBackPressure(host, response);
    await this.#recordOutcome(request.sourceId, classify(response.status));

    return {
      ok: true,
      release,
      response: {
        url: url.href,
        status: response.status,
        headers: response.headers,
        body: response.body,
        truncated: response.truncated,
      },
    };
  }

  /**
   * Retrieve `/robots.txt` for an origin - itself through the chokepoint, so
   * the file that says how polite to be is fetched politely.
   */
  async #retrieveRobots(origin: string, sourceId: string): Promise<RobotsRetrieval> {
    const url = parseUrl(new URL("/robots.txt", origin).href);
    const outcome = await this.#send(
      url,
      {
        url: url.href,
        sourceId,
        method: "GET",
        // The parsing limit bounds what enters the process, at the socket.
        maxBytes: this.#config.robots.parsingLimitBytes,
      },
      // A 4xx on robots.txt is the host ANSWERING - "this host carries no
      // rules" - so it is not an error against the breaker. A 5xx, a timeout
      // and a connection failure are.
      robotsOutcomeClass,
    );

    if (!outcome.ok) {
      // Every refusal below this line leaves robots.txt undefined, and RFC 9309
      // 2.3.1.4 says undefined means complete disallow. Nothing is fetched.
      return { kind: "unreachable", detail: outcome.detail };
    }

    const status = outcome.response.status;
    const classification = classifyRobotsStatus(status);
    if (classification === "rules") {
      return {
        kind: "rules",
        body: outcome.response.body,
        truncated: outcome.response.truncated,
      };
    }
    if (classification === "unavailable") {
      return { kind: "unavailable", detail: `status ${status}` };
    }
    return { kind: "unreachable", detail: `status ${status}` };
  }

  #applyBackPressure(host: string, response: TransportResponse): void {
    const receivedAt = this.#clock.now();
    const hold = holdForResponse(
      response.status,
      response.headers["retry-after"],
      receivedAt,
      this.#config.backPressure.defaultBackoffMs,
    );
    if (hold === null) return;
    this.#scheduler.hold(host, receivedAt + hold.holdMs);
  }

  async #recordOutcome(sourceId: string, outcome: OutcomeClass): Promise<void> {
    const paused = this.#breaker.record(sourceId, outcome);
    if (paused === null) return;
    await this.#notifier.notify({
      kind: "breaker-paused",
      sourceId,
      at: new Date(this.#clock.now()),
      detail: paused.detail,
    });
  }

  #breakerSettingsFor(sourceId: string): BreakerSettings {
    return this.#config.sources[sourceId]?.breaker ?? this.#config.breaker;
  }
}

/** A product fetch: any 4xx or 5xx is an error or a block against the breaker. */
function defaultOutcomeClass(status: number): OutcomeClass {
  return status >= 400 ? "failure" : "success";
}

/** A robots fetch: only the unreachable half of the asymmetry is a failure. */
function robotsOutcomeClass(status: number): OutcomeClass {
  return classifyRobotsStatus(status) === "unreachable" ? "failure" : "success";
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidRequestError(`${JSON.stringify(raw)} is not an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidRequestError(
      `${url.protocol} is not a scheme this governor fetches; only http and https are.`,
    );
  }
  return url;
}
