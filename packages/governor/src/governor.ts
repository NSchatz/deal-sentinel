/**
 * THE CHOKEPOINT. Every outbound HTTP request this system will ever make goes
 * through `Governor.request`, and there is no second way out of the process.
 *
 * That claim is load-bearing, so it is held up by three things and not by this
 * comment. The package exports no object that can send: a caller asks for the
 * real client with the `LIVE_TRANSPORT` marker, which has no `send` and is
 * redeemed only in the constructor below. The factory that builds a real client
 * lives in `transport.ts` and is not part of the public surface. And
 * `no-direct-http.ts` fails the suite if any file outside the allowlist names
 * an HTTP client, names that factory, or imports that module.
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
 * GATE 6 IS A WAIT, and it is unbounded: a whole ceiling interval, or a
 * `Retry-After` hold of hours, with every concurrent offer for that host
 * serialised behind it. So a decision taken before that wait is a decision
 * about a moment that has passed, and the boundary that matters is the one the
 * spec uses everywhere - "before that request LEAVES THE PROCESS". Every gate
 * above is therefore accounted for at that boundary, and this is the whole
 * list, so that a gate cannot quietly be left at the call boundary again:
 *
 *   gate 1, the host ceiling: CONFIG. `#config` is assigned once in the
 *     constructor from a frozen load and this class never writes it, so its
 *     answer cannot change while a request waits. Re-read in `#send` anyway,
 *     where its disappearance is a thrown invariant rather than a refusal.
 *   gate 2, the source is configured: CONFIG, by the same argument, and it is
 *     read out of the same object in the same statement style as gate 1. Not
 *     re-asked; nothing can have changed it.
 *   gate 3, the breaker: RE-ASKED in `#send` (a source can be paused by
 *     another request's failure while this one waits).
 *   gate 4, the allowance: RE-ASKED in `#send` (the period's units can be
 *     spent by another request, or the period can roll, while this one waits).
 *   gate 5, robots: RE-ASKED in `#send`. A cached robots decision carries an
 *     explicit expiry - `robots.cacheBoundMs`, which RFC 9309 2.4 caps at 24
 *     hours - so it is precisely a statement about a moment, and a request
 *     released after that bound has elapsed must not leave under it.
 *
 * The URL's shape (absolute, http or https) is validated once in `request` and
 * is not re-asked: it is a property of the caller's own argument, which no
 * amount of waiting alters.
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
import type { RefusalReason } from "./errors.ts";
import { HostScheduler } from "./host-scheduler.ts";
import type { Release } from "./host-scheduler.ts";
import { LIVE_TRANSPORT } from "./ports.ts";
import type {
  Clock,
  HttpTransport,
  Notifier,
  RandomSource,
  TransportChoice,
  TransportResponse,
} from "./ports.ts";
import { holdForResponse } from "./retry-after.ts";
import { RobotsGate, classifyRobotsStatus } from "./robots.ts";
import type { RobotsRetrieval } from "./robots.ts";
import { createFetchTransport } from "./transport.ts";

export type GovernedRequest = {
  url: string;
  /** Which adapter is asking. The breaker and the allowance key on this. */
  sourceId: string;
  method?: string;
  headers?: Record<string, string>;
  /** Overrides `config.http.maxResponseBytes` downwards for one request. */
  maxBytes?: number;
};

// Declared in `errors.ts`, which is where the robots gate can also reach it,
// and re-exported here so callers keep importing it from the same place.
export type { RefusalReason };

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

/**
 * How one send differs from the default. Both fields exist for the same single
 * caller - the governor's own `/robots.txt` retrieval - and both are named
 * rather than positional so that adding a third cannot silently change a
 * second.
 */
type SendOptions = {
  /** How this send's status maps to an outcome the breaker counts. */
  classify?: (status: number) => OutcomeClass;
  /** Ask gate 5 again at the process boundary. False only for gate 5's own fetch. */
  recheckRobots?: boolean;
};

export type GovernorDependencies = {
  config: GovernorConfig;
  clock: Clock;
  random: RandomSource;
  /**
   * A transport the caller supplies, or `LIVE_TRANSPORT` to ask for the real
   * HTTP client. The marker is the ONLY way to a real client from outside this
   * package, and it is redeemed here, on the far side of every gate.
   */
  transport: TransportChoice;
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
    // The marker becomes a client HERE and nowhere else. Nothing outside this
    // package can hold the result: it is private to this instance and every
    // send through it has already passed the six gates below.
    this.#transport =
      dependencies.transport === LIVE_TRANSPORT
        ? createFetchTransport()
        : dependencies.transport;
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

    // Gates 3, 4 and 5, cheapest first, so that a source the breaker has
    // already paused is never the reason a robots.txt gets fetched.
    const breaker = this.#breakerGate(request.sourceId);
    if (breaker !== null) return breaker;

    const allowance = await this.#allowanceGate(request.sourceId);
    if (allowance !== null) return allowance;

    const robots = await this.#robotsGate(url, request.sourceId);
    if (robots !== null) return robots;

    return await this.#send(url, request);
  }

  /** Gate 3, in one place, so both boundaries ask exactly the same question. */
  #breakerGate(sourceId: string): GovernorOutcome | null {
    const paused = this.#breaker.status(sourceId);
    if (!paused.paused) return null;
    return {
      ok: false,
      reason: "source-paused",
      detail: `${sourceId} is paused by its breaker: ${paused.detail}`,
    };
  }

  /** Gate 4, likewise. */
  async #allowanceGate(sourceId: string): Promise<GovernorOutcome | null> {
    const allowance = await this.#allowance.check(sourceId);
    if (!allowance.stopped) return null;
    return {
      ok: false,
      reason: "allowance-exhausted",
      detail: `${sourceId} is stopped for this period: ${allowance.detail}`,
    };
  }

  /** Gate 5, likewise. Null means this path is allowed for this host, now. */
  async #robotsGate(url: URL, sourceId: string): Promise<GovernorOutcome | null> {
    const robots = await this.#robots.decide(url, sourceId);
    if (robots.state === "refused") {
      // Not a verdict about the host: one of THIS governor's gates refused the
      // robots retrieval on the far side of its own wait, so the request it was
      // for is refused for that same live reason - never disguised as, or
      // cached as, an unreachable robots.txt.
      return { ok: false, reason: robots.reason, detail: robots.detail };
    }
    if (robots.state === "unreachable") {
      return { ok: false, reason: "robots-unreachable", detail: robots.detail };
    }
    if (robots.state === "disallowed") {
      return { ok: false, reason: "robots-disallowed", detail: robots.detail };
    }
    return null;
  }

  /** Whether a host is currently held by back-pressure, for operator surfaces. */
  heldUntil(host: string): number {
    return this.#scheduler.heldUntil(host);
  }

  async #send(
    url: URL,
    request: GovernedRequest,
    options: SendOptions = {},
  ): Promise<GovernorOutcome> {
    const classify = options.classify ?? defaultOutcomeClass;
    const host = hostKey(url);
    const ceiling = this.#config.hosts[host];
    if (ceiling === undefined) {
      throw new InvalidRequestError(
        `${host} lost its ceiling between the gate and the release; refusing.`,
      );
    }

    const release = await this.#scheduler.release(host, ceiling);

    // ------------------------------------------------------------------------
    // THE PROCESS BOUNDARY. Everything above happened at some earlier moment;
    // this is the moment the request would leave. The wait is unbounded - a
    // whole ceiling interval, or a `Retry-After` hold measured in hours - and
    // the per-host queue serialises every concurrent offer behind it, so each
    // gate whose answer can have changed is asked AGAIN here, and the module
    // header names all five and says which those are.
    //
    // Gate 5 is asked FIRST, and the order is load-bearing rather than a
    // matter of taste: re-asking robots can RETRIEVE `/robots.txt`, and that
    // retrieval goes out through this same method, so it can spend the last
    // unit of the period's allowance or hand the breaker the failure that
    // pauses the source. Asked last, it would change the very state gates 3
    // and 4 had just approved, and this request would leave anyway - the
    // allowance overspent by one, or a paused source served once more. Asked
    // first, its consequences are inside what gates 3 and 4 then read.
    //
    // Nothing is lost by asking the expensive gate first: the retrieval is
    // itself a `#send`, so a paused source or a spent allowance refuses it
    // before anything reaches the wire, and that refusal surfaces as the
    // reason it actually is (`RobotsGate` caches no refusal).
    if (options.recheckRobots ?? true) {
      const robots = await this.#robotsGate(url, request.sourceId);
      if (robots !== null) return robots;
    }

    // Gate 3. Leaving this one out is what makes a paused source keep
    // receiving one request every `minDelayMs` for as long as its queue holds
    // them - precisely the "runaway scraper" this package exists to prevent.
    const breaker = this.#breakerGate(request.sourceId);
    if (breaker !== null) return breaker;

    // Gate 4.
    const allowance = await this.#allowanceGate(request.sourceId);
    if (allowance !== null) return allowance;

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
      {
        // A 4xx on robots.txt is the host ANSWERING - "this host carries no
        // rules" - so it is not an error against the breaker. A 5xx, a timeout
        // and a connection failure are.
        classify: robotsOutcomeClass,
        // The ONE send that does not re-ask gate 5, for two reasons that agree:
        // RFC 9309 puts no robots rule over `/robots.txt` itself, and a gate
        // asked from inside its own retrieval would not terminate.
        recheckRobots: false,
      },
    );

    if (!outcome.ok) {
      if (outcome.reason === "transport-error") {
        // A server or a network error: robots.txt is UNDEFINED, and RFC 9309
        // 2.3.1.4 says undefined means complete disallow. Nothing is fetched,
        // and this is a fact about the host, so it caches like any verdict.
        return { kind: "unreachable", detail: outcome.detail };
      }

      // Anything else is one of this governor's OWN gates declining to go: the
      // source is paused, or its allowance for the period is spent. That is a
      // fact about us, not about the host, and AC7 scopes the fail-safe to "a
      // server error or a network error", so it is neither of those. Recording
      // it as unreachable would be wrong twice over: the cache is keyed by
      // ORIGIN, so one source's spent allowance would disallow the host for
      // every other source, and the entry would outlive the pause or the
      // period that caused it by up to `robots.cacheBoundMs`.
      //
      // Nothing was learned, so nothing is decided and nothing is cached. The
      // request is refused, with the reason that actually refused it - which
      // is the same reason it would have met at the send itself.
      return { kind: "refused", reason: outcome.reason, detail: outcome.detail };
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
