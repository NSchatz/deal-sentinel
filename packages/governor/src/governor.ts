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
 * spec uses everywhere - "before that request LEAVES THE PROCESS".
 *
 * Gate 5 and gate 6 can each invalidate the OTHER, which is why `#send` does
 * not ask them in a fixed order a fixed number of times. Waiting ages a robots
 * decision (it carries an explicit expiry); re-asking robots can put a
 * `/robots.txt` on the wire for this very host, which spends a ceiling slot,
 * resets the minimum delay and can earn a hold that the wait already returned
 * from. Asking either one once leaves the other one stale, and that is a defect
 * this file has now had three times over. So the boundary in `#send` is a LOOP
 * that runs until ONE INSTANT satisfies every gate at once, and where no such
 * instant can be reached the request is REFUSED rather than sent under an
 * answer this governor has itself declared expired.
 *
 * Every gate accounted for at that boundary, and this is the whole list:
 *
 *   gate 1, the host ceiling: CONFIG. `#config` is `readonly`, is assigned
 *     exactly once in the constructor, and every other mention of it in this
 *     class is a read, so its answer cannot change while a request waits. (The
 *     object itself is the caller's and is not deep-frozen; the guarantee here
 *     is that this class never writes it, which is the guarantee this gate
 *     needs.) Re-read in `#send` anyway, where its disappearance is a thrown
 *     invariant rather than a refusal.
 *   gate 2, the source is configured: CONFIG, by the same argument, and it is
 *     read out of the same object in the same statement style as gate 1. Not
 *     re-asked; this class cannot have changed it.
 *   gate 3, the breaker: RE-ASKED INSIDE THE LOOP, after every wait (a source
 *     can be paused by another request's failure while this one waits), AND
 *     AGAIN after the allowance reservation, because a concurrent request's
 *     response can pause the source while that reservation is in flight. Its
 *     state is in memory, so the second ask costs no `await`.
 *   gate 4, the allowance: NOT ASKED AT ALL, at the boundary. It is SPENT. A
 *     read of a shared counter is a statement about a moment even when it is
 *     taken at the last possible instant, and this is the one gate whose subject
 *     - the count of what has left - is moved by OTHER requests rather than by
 *     the passage of time. Requests for one metered source on different hosts
 *     are serialised by nothing, because AC4 forbids one host at its ceiling
 *     from holding up another, so any number of them can read one total, all
 *     find room, and all leave: the overspend would be bounded by how many hosts
 *     an adapter offers at once and not by the configured allowance. So the
 *     boundary does not read and then decide. It asks the STORE to take one unit
 *     if and only if the resulting total is still inside the limit, in one
 *     statement, and refuses on THAT answer. Nothing can happen between the
 *     addition and the test, because they are the same step. `check` is still
 *     asked earlier, but only to refuse cheaply: it never authorises a send.
 *   gate 5, robots: RE-ASKED INSIDE THE LOOP, and its answer's AGE is checked
 *     again at the end of each round, after gates 3 and 4 have run. A cached
 *     robots decision carries an explicit expiry - `robots.cacheBoundMs`, which
 *     RFC 9309 2.4 caps at 24 hours - so it is precisely a statement about a
 *     moment, and a request released after that bound has elapsed must not
 *     leave under it. There is exactly ONE exception and it is checked, not
 *     assumed: where this host's configured `minDelayMs` is already at least
 *     `robots.cacheBoundMs`, the retrieval and the fetch behind it are spaced
 *     further apart than the answer may live, so NO round can end fresh and
 *     asking again would only add traffic. `canRefreshRobots` in `#send` is
 *     that test, and where it is false the boundary re-asks gate 5 exactly once
 *     and then stops asking. Its age is checked ONCE MORE after the allowance
 *     reservation, which is a store round trip a robots answer can expire
 *     inside.
 *   gate 6, the wait itself: its answer is `HostScheduler.release`, and that
 *     answer is a statement about a moment too - the moment the host had
 *     received no traffic for `minDelayMs`, was inside its ceiling and was
 *     under no hold. `release` is the only reader of that hold, so anything
 *     that reaches the wire between it and `#transport.send` invalidates it.
 *     TAKEN AGAIN at the top of every round, so it is never older than the last
 *     thing that happened, and re-certified after the allowance reservation for
 *     the same reason gate 5 is: a hold from another request's 429, or a
 *     `/robots.txt` landing for this origin, can arrive inside that round trip.
 *     A round ends only when nothing landed on the wire for this origin since
 *     that take and the host is under no hold.
 *
 * BETWEEN THE LAST GATE AND `#transport.send` THERE IS NO `await` AT ALL, and
 * that is the property to preserve rather than any particular ordering above.
 * The allowance reservation is the last thing that waits; every other gate is
 * then RE-ASKED after it, synchronously, in one job that ends with the send. A
 * reservation whose request is stopped there did not leave the process, so its
 * unit goes back (`AllowanceLedger.release`) - AC20 counts what left, and an
 * unreleased reservation would be an allowance quietly smaller than the
 * configured one.
 *
 * Why this ordering and not the reverse: exactly one gate has to be innermost,
 * because the allowance lives in a store and reaching a store is a wait. Making
 * the ALLOWANCE innermost is what makes it exact, and it is the only gate that
 * can be made exact no other way - the other three are read from memory, so
 * re-asking them costs nothing and can be done with no `await` in hand.
 *
 * The URL's shape (absolute, http or https) is validated once in `request` and
 * is not re-asked: it is a property of the caller's own argument, which no
 * amount of waiting alters.
 *
 * Only then does a request leave, and the unit it spent to leave is settled -
 * the warning or the stop notification the resulting total owes - whatever came
 * back.
 */

import { hostKey } from "./config.ts";
import type { BreakerSettings, GovernorConfig } from "./config.ts";
import { AllowanceLedger } from "./allowance.ts";
import type { AllowanceReservation, AllowanceStore } from "./allowance.ts";
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
import { classifyFetchOutcome } from "./telemetry.ts";
import type { ClassifiableOutcome, FetchTelemetry } from "./telemetry.ts";
import { createFetchTransport } from "./transport.ts";

export type GovernedRequest = {
  url: string;
  /** Which adapter is asking. The breaker and the allowance key on this. */
  sourceId: string;
  method?: string;
  headers?: Record<string, string>;
  /** Overrides `config.http.maxResponseBytes` downwards for one request. */
  maxBytes?: number;
  /**
   * The request body, for a caller that carries one. Nothing that READS a price
   * sets it; a notification channel does, and it reaches the wire through this
   * same method so that a body is not a reason to hold a client of one's own.
   */
  body?: string;
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
 * How many times ONE send may take gate 6 - the per-host wait - before it stops
 * trying and refuses.
 *
 * Three, and the three are named. Round 1 is the request's own wait. Round 2 is
 * the wait that round 1's `/robots.txt` retrieval earned - a ceiling slot, a
 * minimum delay, or a hold the host answered that retrieval with. Round 3 is
 * the wait the retrieval THAT wait forced in turn. A fourth would mean the host
 * is putting holds on this governor faster than its own robots decision is
 * allowed to live, and every further round has the same shape: one more
 * `/robots.txt` to a host that has just asked, in the plainest terms HTTP has,
 * for less traffic. So the loop stops, and stopping means REFUSING - which
 * discharges "re-retrieve robots.txt before the next fetch" the one way that is
 * always available, by making sure there is no next fetch.
 *
 * A bound is not optional here. Without one this loop is the unbounded
 * alternation the previous fix declined to write, and a caller's promise never
 * settles.
 */
export const MAX_BOUNDARY_WAITS = 3;

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
  /**
   * Where each offered fetch's outcome and each breaker pause are written down.
   *
   * OPTIONAL, and a governor built without one behaves exactly as it did before
   * the observability phase. A governor built WITH one behaves exactly the same
   * way too: nothing this port returns is read, every call it makes is wrapped
   * so that a failure cannot reach the fetch path, and there is no code path on
   * which a recording decides whether a request leaves. That is not politeness
   * about a nice-to-have - a recording failure that propagated into a caller
   * which then retried the fetch would be the runaway scraper this whole package
   * exists to prevent, built out of a telemetry feature.
   */
  telemetry?: FetchTelemetry;
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
  readonly #telemetry: FetchTelemetry | null;

  constructor(dependencies: GovernorDependencies) {
    this.#config = dependencies.config;
    this.#clock = dependencies.clock;
    this.#telemetry = dependencies.telemetry ?? null;
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
    // OFFERED. The latency this system records is measured from here, because
    // this is the instant a caller asked for something, and the interesting
    // number for an operator is how long the answer took to arrive - a refusal
    // reached after a whole ceiling interval of waiting is a fact about this
    // system's behaviour just as much as a slow vendor is.
    const offeredAt = this.#clock.now();
    const outcome = await this.#offer(request);
    // KNOWN. After the outcome and after everything the send itself owed, so
    // that not one statement between the last gate and `#transport.send` is
    // this method's.
    await this.#recordFetchOutcome(request.sourceId, offeredAt, outcome);
    return outcome;
  }

  /**
   * The six gates and the send, unchanged.
   *
   * Split out from `request` only so that the recording above wraps it without
   * being interleaved with it. Nothing in here knows telemetry exists.
   */
  async #offer(request: GovernedRequest): Promise<GovernorOutcome> {
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

  /**
   * The refusal the boundary gives up with, naming the answer it could not
   * bring back to the present.
   *
   * The hold is named first when one is in force, because that is the fact an
   * operator acts on: the host is asking for silence, and this governor has
   * spent `MAX_BOUNDARY_WAITS` waits trying to find a moment inside its own
   * rules to send anyway. Neither refusal is a verdict about the host, so
   * neither is cached; the next attempt asks again from the top.
   */
  #boundaryRefusal(
    host: string,
    origin: string,
    now: number,
    heldUntil: number,
  ): GovernorOutcome {
    if (heldUntil > now) {
      return {
        ok: false,
        reason: "host-held",
        detail:
          `${host} was still held by back-pressure until ${new Date(heldUntil).toISOString()} ` +
          `after ${MAX_BOUNDARY_WAITS} waits at the process boundary, so this ` +
          "request is refused rather than released into a hold the host asked " +
          "for. Nothing is cached: the next attempt asks again.",
      };
    }

    const decidedAt = this.#robots.decidedAt(origin);
    const age = decidedAt === null ? null : now - decidedAt;
    return {
      ok: false,
      reason: "robots-stale",
      detail:
        `${origin}/robots.txt was last retrieved ${age === null ? "never" : `${age}ms ago`}, ` +
        `past the configured robots.cacheBoundMs of ${this.#config.robots.cacheBoundMs}, ` +
        `and ${MAX_BOUNDARY_WAITS} waits at the process boundary did not reach ` +
        "an instant at which a fresh decision and this host's back-pressure " +
        "were both satisfied. The request is refused rather than fetched under " +
        "rules this governor has itself declared expired.",
    };
  }

  /** `#boundaryRefusal` asked about right now, for the two places that give up. */
  #boundaryRefusalNow(host: string, origin: string): GovernorOutcome {
    return this.#boundaryRefusal(
      host,
      origin,
      this.#clock.now(),
      this.#scheduler.heldUntil(host),
    );
  }

  /**
   * Do gate 5's and gate 6's answers both hold AT THIS INSTANT?
   *
   * Spelled once and asked twice - before the allowance reservation, to avoid
   * paying for one that another round would only give back, and again after it,
   * where the answer is the one the request actually leaves under. Reads nothing
   * but memory and takes no `await`, which is what lets the second ask sit
   * between the reservation and the wire with nothing able to run in between.
   *
   * `landedRetrievals` is compared against where this origin stood when gate 6
   * granted the release, so a `/robots.txt` that reached the wire since - this
   * request's own re-ask, or another request that joined the same retrieval -
   * makes the answer false however it got there.
   */
  #boundaryHolds(
    host: string,
    origin: string,
    landedBefore: number,
    recheckRobots: boolean,
    canRefreshRobots: boolean,
  ): boolean {
    const now = this.#clock.now();

    // Gate 6's answer still stands: nothing landed on the wire for this origin
    // since the release was granted, and no hold has arrived from anywhere else.
    // (`release` is the only reader of `holdUntil`, and it returned before
    // either could happen.)
    const gate6Current =
      this.#robots.landedRetrievals(origin) === landedBefore &&
      this.#scheduler.heldUntil(host) <= now;
    if (!gate6Current) return false;

    // Gate 5's answer is still inside the bound it carries.
    if (!recheckRobots || this.#robots.decidedWithinBoundAt(origin, now)) return true;

    // Gate 5 is not fresh, but no round could make it so: this configuration
    // spaces two requests to this host further apart than a robots decision may
    // live. The boundary has re-asked gate 5 once, which is the freshest answer
    // that exists here; asking again would fetch `/robots.txt` once more and
    // land in exactly the same place, one request to the host worse off.
    return !canRefreshRobots;
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

    const origin = url.origin;
    const recheckRobots = options.recheckRobots ?? true;

    // CAN A FURTHER ROUND EVER PRODUCE A FRESHER ANSWER? Gate 5's re-ask
    // retrieves through this same method, so the fetch behind a retrieval is
    // spaced from it by at least this host's configured `minDelayMs`. Where
    // that spacing is already as long as `robots.cacheBoundMs`, no round can
    // end with a decision inside its bound - the configuration itself has put
    // the two numbers the wrong way round - and asking again would do nothing
    // but add a `/robots.txt` to the host and age the answer once more. Both
    // numbers are configuration, which this class never writes, so this is
    // decided once, before anything is asked.
    const canRefreshRobots =
      recheckRobots && ceiling.minDelayMs < this.#config.robots.cacheBoundMs;

    let release: Release;
    let reservation: AllowanceReservation;
    let round = 0;

    for (;;) {
      round += 1;

      // GATE 6: the wait. Taken again at the top of every round, so that its
      // answer is never older than the last thing that happened to this host.
      release = await this.#scheduler.release(host, ceiling);

      // Where this origin's retrievals stand at the moment the release was
      // granted. Everything from here to the wire is measured against it: gate
      // 5's own re-ask can put a `/robots.txt` on the wire for this host, and so
      // can another request that joined the same retrieval while this one waits
      // for its allowance reservation.
      const landedBefore = this.#robots.landedRetrievals(origin);

      // ----------------------------------------------------------------------
      // THE PROCESS BOUNDARY. Everything before this round happened at some
      // earlier moment; this is the moment the request would leave. The wait
      // above is unbounded - a whole ceiling interval, or a `Retry-After` hold
      // measured in hours - and the per-host queue serialises every concurrent
      // offer behind it, so every gate whose answer can have changed is asked
      // AGAIN here. The module header names all six and says which those are.
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
      if (recheckRobots && (round === 1 || canRefreshRobots)) {
        const robots = await this.#robotsGate(url, request.sourceId);
        if (robots !== null) return robots;
      }

      // Gate 3. Leaving this one out is what makes a paused source keep
      // receiving one request every `minDelayMs` for as long as its queue holds
      // them - precisely the "runaway scraper" this package exists to prevent.
      const breaker = this.#breakerGate(request.sourceId);
      if (breaker !== null) return breaker;

      // Gate 4, ADVISORY. A source already finished for the period is turned
      // away here, before this round spends anything - and, on round 1, before
      // the robots retrieval above would have been paid for on its behalf. It
      // can only refuse. What AUTHORISES the send is the reservation below.
      const allowance = await this.#allowanceGate(request.sourceId);
      if (allowance !== null) return allowance;

      // IS EVERY ANSWER ABOVE TRUE AT ONE INSTANT - THIS ONE? Read after gates
      // 3 and 4 rather than before them, because those two read a store and
      // reading a store takes time, and the question here is about NOW.
      if (!this.#boundaryHolds(host, origin, landedBefore, recheckRobots, canRefreshRobots)) {
        if (round >= MAX_BOUNDARY_WAITS) return this.#boundaryRefusalNow(host, origin);
        continue;
      }

      // GATE 4, BINDING, and the last thing in this method that waits. One
      // statement in the store takes a unit if and only if the resulting total
      // is still inside the configured allowance, and answers with that total.
      // A concurrent request for this source on another host cannot have taken
      // the same unit, because it cannot get between the addition and the test.
      reservation = await this.#allowance.reserve(request.sourceId);
      if (reservation.refused) {
        return {
          ok: false,
          reason: "allowance-exhausted",
          detail: `${request.sourceId} is stopped for this period: ${reservation.detail}`,
        };
      }

      // ----------------------------------------------------------------------
      // NO `await` FROM HERE TO `#transport.send`. The reservation was a store
      // round trip and the other gates read memory, so they are re-asked now,
      // in this same job, and the answers cannot go stale before the request
      // leaves: nothing else can run in between.
      const paused = this.#breakerGate(request.sourceId);
      if (paused !== null) {
        // A concurrent request's response paused this source while the
        // reservation was in flight. Nothing leaves, so the unit goes back, and
        // no further round is taken: a pause is not something waiting fixes.
        await this.#allowance.release(reservation);
        return paused;
      }

      if (this.#boundaryHolds(host, origin, landedBefore, recheckRobots, canRefreshRobots)) {
        break;
      }

      // A hold arrived, a `/robots.txt` landed for this origin, or the robots
      // decision expired, all inside the reservation's round trip. Nothing
      // leaves under any of those, so the unit goes back before another round.
      await this.#allowance.release(reservation);
      if (round >= MAX_BOUNDARY_WAITS) return this.#boundaryRefusalNow(host, origin);
    }

    // Null until the transport answers, so that the settlement below runs on
    // both paths without being written twice.
    let response: TransportResponse | null = null;
    let failure: unknown = null;
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
        body: request.body,
      });
    } catch (error) {
      failure = error;
    }

    // The request LEFT THE PROCESS, so the unit it spent is settled - the
    // warning or the stop notification the resulting total owes, each at most
    // once for the period. Settled after the send rather than before it because
    // AC20 counts a request that left whatever came back, and because emitting
    // from the reservation would have put two more store round trips between
    // that reservation and the wire.
    await this.#allowance.settle(reservation);

    if (response === null) {
      const detail = failure instanceof Error ? failure.message : String(failure);
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

    // The breaker's return value is the ONLY place a pause is announced, which
    // is what makes "exactly once per pause" a property of that method rather
    // than of its callers. The durable record is written from here for the same
    // reason: anything that polled `status()` instead would write a row for
    // every request that arrived behind the pause.
    await this.#recordBreakerPause({
      sourceId,
      pausedAt: new Date(paused.pausedAt),
      expiresAt: new Date(paused.expiresAt),
      failingCount: paused.failingCount,
      windowOutcomes: paused.windowOutcomes,
      windowMs: paused.windowMs,
      failureRateThreshold: String(paused.failureRateThreshold),
      condition: paused.detail,
    });

    await this.#notifier.notify({
      kind: "breaker-paused",
      sourceId,
      at: new Date(this.#clock.now()),
      detail: paused.detail,
    });
  }

  /**
   * Write down what happened to one offered fetch.
   *
   * EVERY FAILURE IS SWALLOWED, and that is the criterion rather than a
   * convenience. A recording that threw would reach whichever caller offered the
   * fetch, and the honest thing for that caller to do with an exception is
   * usually to try again - which would re-offer a request to a third party, from
   * the household's own address, on account of a database being briefly busy.
   * This system does not get to make that trade. A lost telemetry row is a gap
   * in a chart; a retry earned by a lost telemetry row is traffic that no re-run
   * undoes.
   *
   * `onRecordFailure` is how a caller who wants to know is told, and it is
   * wrapped by the same `try` so that an observer cannot become the thing that
   * throws either.
   */
  async #recordFetchOutcome(
    sourceId: string,
    offeredAt: number,
    outcome: GovernorOutcome,
  ): Promise<void> {
    const telemetry = this.#telemetry;
    if (telemetry === null) return;

    try {
      const knownAt = this.#clock.now();
      const classification = classifyFetchOutcome(
        classifiableOutcome(outcome),
        telemetry.limitExceededStatusesFor?.(sourceId) ?? [],
      );
      await telemetry.record({
        sourceId,
        outcomeClass: classification.outcomeClass,
        latencyMs: Math.max(0, Math.round(knownAt - offeredAt)),
        occurredAt: new Date(knownAt),
        condition: classification.condition,
      });
    } catch (error) {
      this.#reportRecordFailure(error);
    }
  }

  /** The same protection, for the pause record. Same reason, to the letter. */
  async #recordBreakerPause(pause: {
    sourceId: string;
    pausedAt: Date;
    expiresAt: Date;
    failingCount: number;
    windowOutcomes: number;
    windowMs: number;
    failureRateThreshold: string;
    condition: string;
  }): Promise<void> {
    const telemetry = this.#telemetry;
    if (telemetry === null || telemetry.recordPause === undefined) return;
    try {
      await telemetry.recordPause(pause);
    } catch (error) {
      this.#reportRecordFailure(error);
    }
  }

  #reportRecordFailure(error: unknown): void {
    try {
      this.#telemetry?.onRecordFailure?.(error);
    } catch {
      // An observer that throws is not permitted to become the failure the
      // observer exists to report. There is nowhere left to report it to, and
      // reaching the fetch path is the one outcome that is not allowed.
    }
  }

  #breakerSettingsFor(sourceId: string): BreakerSettings {
    return this.#config.sources[sourceId]?.breaker ?? this.#config.breaker;
  }
}

/**
 * The chokepoint's own outcome, reduced to the three shapes the classification
 * can tell apart: this system declined, the request left and nothing usable came
 * back, or the far side answered with a status.
 */
function classifiableOutcome(outcome: GovernorOutcome): ClassifiableOutcome {
  if (outcome.ok) return { kind: "response", status: outcome.response.status };
  if (outcome.reason === "transport-error") {
    return { kind: "transport-error", detail: outcome.detail };
  }
  return { kind: "refused", reason: outcome.reason, detail: outcome.detail };
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
