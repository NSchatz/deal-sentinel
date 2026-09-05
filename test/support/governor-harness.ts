/**
 * The fixtures every governor test is built from: a complete configuration a
 * test can bend one value of, a notifier that counts, and a transport that
 * records what it was asked to send and when.
 *
 * The configuration here is a TEST configuration. It is not the committed
 * default at `config/governor.json` and it is not a recommendation: the numbers
 * are small so that assertions about elapsed virtual time are readable.
 */

import { Governor, createMemoryAllowanceStore } from "@deal-sentinel/governor";
import type {
  AllowanceStore,
  Clock,
  GovernorConfig,
  HttpTransport,
  Notification,
  Notifier,
  TransportChoice,
  TransportRequest,
  TransportResponse,
} from "@deal-sentinel/governor";

import { FakeClock, sequenceRandom } from "./fake-clock.ts";

export type ConfigOverrides = {
  hosts?: GovernorConfig["hosts"];
  robots?: Partial<GovernorConfig["robots"]>;
  http?: Partial<GovernorConfig["http"]>;
  backPressure?: Partial<GovernorConfig["backPressure"]>;
  breaker?: Partial<GovernorConfig["breaker"]>;
  sources?: GovernorConfig["sources"];
  userAgent?: string;
};

export function testConfig(overrides: ConfigOverrides = {}): GovernorConfig {
  return {
    userAgent: overrides.userAgent ?? "deal-sentinel-test/0.0 (+loopback only)",
    http: {
      requestTimeoutMs: 2000,
      maxResponseBytes: 1_048_576,
      ...overrides.http,
    },
    hosts: overrides.hosts ?? {
      "127.0.0.1": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: 1_000,
        jitterMs: 500,
      },
    },
    robots: {
      productToken: "deal-sentinel",
      cacheBoundMs: 3_600_000,
      parsingLimitBytes: 512_000,
      ...overrides.robots,
    },
    backPressure: {
      defaultBackoffMs: 300_000,
      ...overrides.backPressure,
    },
    breaker: {
      windowMs: 600_000,
      minimumOutcomes: 4,
      failureRateThreshold: 0.5,
      pauseMs: 1_800_000,
      ...overrides.breaker,
    },
    sources: overrides.sources ?? { "test-source": {} },
  };
}

export type RecordingNotifier = Notifier & {
  readonly sent: Notification[];
  of(kind: Notification["kind"]): Notification[];
};

export function recordingNotifier(): RecordingNotifier {
  const sent: Notification[] = [];
  return {
    sent,
    notify(notification) {
      sent.push(notification);
    },
    of(kind) {
      return sent.filter((notification) => notification.kind === kind);
    },
  };
}

export type SentRequest = TransportRequest & { at: number };

export type RecordingTransport = HttpTransport & {
  /** Every request that actually left, with the instant it left on the clock. */
  readonly sent: SentRequest[];
};

/**
 * A transport that reaches nothing at all: it answers from a responder the test
 * supplies. Used where the criterion under test is about WHEN a request leaves
 * rather than about what a server said; the robots, back-pressure and breaker
 * criteria are graded against a real server on 127.0.0.1 instead.
 */
export function recordingTransport(
  clock: Clock,
  responder: (
    request: TransportRequest,
    index: number,
  ) => Partial<TransportResponse> | Error = () => ({}),
): RecordingTransport {
  const sent: SentRequest[] = [];
  return {
    sent,
    async send(request) {
      const index = sent.length;
      sent.push({ ...request, at: clock.now() });
      const answer = responder(request, index);
      if (answer instanceof Error) throw answer;
      return {
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
        body: answer.body ?? "",
        truncated: answer.truncated ?? false,
      };
    },
  };
}

export type Harness = {
  governor: Governor;
  clock: FakeClock;
  notifier: RecordingNotifier;
  allowanceStore: AllowanceStore;
  config: GovernorConfig;
};

/**
 * A governor wired to a virtual clock, a reproducible randomness source, a
 * counting notifier and an in-memory allowance store. The transport is the
 * caller's: a recording stub where the criterion is about timing, or
 * `LIVE_TRANSPORT` where it is about what a server said, which asks the
 * governor for the real client and gets it pointed at 127.0.0.1 like every
 * other request - through the ceiling, the delay and all six gates. There is no
 * way for a test to hold a real client of its own, which is the point.
 */
export function buildGovernor(options: {
  transport: TransportChoice;
  config?: GovernorConfig;
  clock?: FakeClock;
  random?: () => number;
  notifier?: RecordingNotifier;
  allowanceStore?: AllowanceStore;
}): Harness {
  const config = options.config ?? testConfig();
  const clock = options.clock ?? new FakeClock();
  const notifier = options.notifier ?? recordingNotifier();
  const allowanceStore = options.allowanceStore ?? createMemoryAllowanceStore();

  const governor = new Governor({
    config,
    clock,
    random: options.random ?? sequenceRandom([0.5]),
    transport: options.transport,
    notifier,
    allowanceStore,
  });

  return { governor, clock, notifier, allowanceStore, config };
}

/** The requests that were not the governor fetching a host's robots.txt. */
export function productRequests(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter((request) => new URL(request.url).pathname !== "/robots.txt");
}

/**
 * The robots.txt answer a transport-level stub gives when a test does not care
 * about robots: 404, which RFC 9309 2.3.1.3 makes "no rules, this host may be
 * accessed". Everything else the responder decides.
 */
export function robotsAbsent(
  responder: (
    request: TransportRequest,
    index: number,
  ) => Partial<TransportResponse> | Error = () => ({}),
): (request: TransportRequest, index: number) => Partial<TransportResponse> | Error {
  return (request, index) => {
    if (new URL(request.url).pathname === "/robots.txt") return { status: 404 };
    return responder(request, index);
  };
}
