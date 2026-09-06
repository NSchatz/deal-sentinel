/**
 * Acceptance criteria A12, A13, A14 and A15 of spec
 * S0036-deal-sentinel-alert-4:
 *
 *   A12. IF the delivery channel answers with an error status, times out, or
 *        cannot be reached THEN THE SYSTEM SHALL record no cooldown for that
 *        listing and rule, SHALL attempt no redelivery inside the same run,
 *        SHALL go on delivering the remaining notifications, and SHALL report
 *        the failure.
 *   A13. IF the delivery channel refuses with an authentication or
 *        authorization failure THEN THE SYSTEM SHALL attempt no further
 *        delivery to that channel for the remainder of the run, SHALL record no
 *        cooldown for any notification it did not deliver, and SHALL report the
 *        refusal naming the channel.
 *   A14. WHEN a notification is delivered, stored or reported THE SYSTEM SHALL
 *        include no credential and no credential-bearing URL in its body, in
 *        any stored alert record, or in any reported failure detail.
 *   A15. WHEN the alert channel sends anything over the network THE SYSTEM
 *        SHALL send it through the governed outbound path, so that a
 *        notification host with no configured ceiling is refused and nothing
 *        leaves outside the governor's gates.
 *
 * Every case here runs against a STUB SERVER ON 127.0.0.1 and a real governor
 * holding the real transport, for the reason the loopback harness gives: this
 * phase exists to protect the household's residential IP, so a suite that
 * reached a real notification server to prove it would be the defect it is
 * testing for. What the server received is read off the server.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  channelRedactor,
  governedChannel,
  runAlertEvaluation,
} from "@deal-sentinel/alerts";
import type { AlertConfig, AlertNotification } from "@deal-sentinel/alerts";
import {
  memoryAlertCooldowns,
  memoryAlertListings,
  memoryObservationHistory,
} from "@deal-sentinel/db";
import {
  LIVE_TRANSPORT,
  collectSourceFiles,
  describeFindings,
  findDirectHttpCallSites,
} from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { DAY_MS, point, testAlertConfig } from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";
import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";
import { closedLoopbackOrigin, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NOW = new Date("2026-09-01T12:00:00.000Z");
const SECRET = "tk-not-a-real-token-0123456789";
const CHANNEL_SOURCE = "alert-channel";

/** What the stub server was asked for, beyond what the harness records. */
type Publish = { path: string; headers: Record<string, string>; body: string };

let server: LoopbackServer;
const published: Publish[] = [];
/** The status the stub answers a publish with. A test sets it, and resets it. */
let answerWith = 200;

before(async () => {
  server = await startLoopbackServer((request, response) => {
    const requested = request.url ?? "/";
    if (requested.split("?")[0] === "/robots.txt") {
      // 404 is "no rules, this host may be accessed" (RFC 9309 2.3.1.3).
      response.writeHead(404);
      response.end("no rules");
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      published.push({
        path: requested,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ]),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(answerWith, { "content-type": "text/plain" });
      response.end(answerWith === 200 ? "ok" : "not ok");
    });
  });
});

after(async () => {
  if (server) await server.close();
});

function governorConfig(overrides: { hosts?: GovernorConfig["hosts"] } = {}): GovernorConfig {
  return testConfig({
    hosts: overrides.hosts ?? {
      "127.0.0.1": { maxRequests: 5_000, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
    },
    // A 5xx is a failure against the breaker, and this suite sends several on
    // purpose. The breaker is graded in its own suite; here it must not fire.
    breaker: { minimumOutcomes: 10_000 },
    sources: { [CHANNEL_SOURCE]: {} },
  });
}

/** The alert configuration pointed at the stub, with whatever the case needs. */
function channelConfig(
  channel: Record<string, unknown> = {},
  endpointPath = "/deals",
): AlertConfig {
  return testAlertConfig({
    channel: { endpoint: `${server.origin}${endpointPath}`, ...channel },
  });
}

function notification(overrides: Partial<AlertNotification> = {}): AlertNotification {
  return {
    ruleId: "window-low-test",
    sourceId: "bestbuy-api",
    listingId: "8880044",
    title: "USD 89.99 on 8880044 (window-low-test)",
    body:
      "window-low-test fired for bestbuy-api/8880044.\nObserved USD 89.99.\n" +
      "It beats USD 109.99.\nhttps://www.example.invalid/site/drill/8880044.p",
    listingUrl: "https://www.example.invalid/site/drill/8880044.p",
    observedMinorUnits: 8_999n,
    referenceMinorUnits: 10_999n,
    currency: "USD",
    clearance: null,
    ...overrides,
  };
}

/** The channel under test, wired to a real governor over the stub server. */
function channelUnderTest(options: {
  config?: AlertConfig;
  governorConfig?: GovernorConfig;
  credential?: string | null;
}) {
  const clock = new FakeClock(NOW.getTime());
  const { governor } = buildGovernor({
    transport: LIVE_TRANSPORT,
    clock,
    config: options.governorConfig ?? governorConfig(),
  });
  const config = options.config ?? channelConfig();
  return {
    clock,
    channel: governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: options.credential ?? null,
    }),
    config,
  };
}

describe("the channel delivers through the governor and says what happened", () => {
  it("publishes the alert body, and answers with the status it got", async () => {
    answerWith = 200;
    published.length = 0;

    const { channel } = channelUnderTest({
      config: channelConfig({
        titleHeader: "X-Title",
        linkHeader: "X-Click",
        credential: {
          variable: "DEAL_SENTINEL_ALERT_TOKEN",
          header: "Authorization",
          prefix: "Bearer ",
        },
      }),
      credential: SECRET,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, true);
    if (!outcome.delivered) return;
    assert.equal(outcome.status, 200);
    assert.equal(published.length, 1);
    assert.equal(published[0].body.includes("window-low-test"), true);
    assert.equal(published[0].headers["x-title"], "USD 89.99 on 8880044 (window-low-test)");
    assert.equal(
      published[0].headers["x-click"],
      "https://www.example.invalid/site/drill/8880044.p",
    );
    assert.equal(published[0].headers.authorization, `Bearer ${SECRET}`);
  });
});

describe("A15: nothing leaves outside the governor's gates", () => {
  it("is refused for a notification host that carries no ceiling", async () => {
    const clock = new FakeClock(NOW.getTime());
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      // A ceiling for a DIFFERENT loopback address, so the configuration is
      // valid and this host is simply one nobody has decided a rate for.
      config: governorConfig({
        hosts: {
          "127.0.0.9": { maxRequests: 10, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        },
      }),
    });
    const config = channelConfig();
    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.detail, /unconfigured-host/);
    assert.deepEqual(
      transport.sent,
      [],
      "a notification left the process for a host with no configured ceiling",
    );
  });

  it("is refused for a source the governor has never heard of", async () => {
    const clock = new FakeClock(NOW.getTime());
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({ transport, clock, config: governorConfig() });
    const config = testAlertConfig({
      sourceId: "not-a-configured-source",
      channel: { endpoint: `${server.origin}/deals` },
    });
    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.match(outcome.detail, /unknown-source/);
    assert.deepEqual(transport.sent, []);
  });

  it("names no HTTP client anywhere in the alerts package", () => {
    // A16 as it applies to the code this phase adds. The tree-wide pass lives
    // in `no-direct-http.test.ts`; this is the same check narrowed to the one
    // package with a reason to want a client of its own.
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("packages/alerts/"),
    );
    assert.ok(files.length >= 8, `only ${files.length} alert files were scanned`);
    assert.deepEqual(
      findDirectHttpCallSites(files),
      [],
      describeFindings(findDirectHttpCallSites(files)),
    );
  });
});

describe("A12: an error status, a timeout or an unreachable channel", () => {
  it("reports an error status as a failure, and does not stop the channel", async () => {
    answerWith = 503;
    published.length = 0;
    const { channel } = channelUnderTest({});

    const outcome = await channel.deliver(notification());

    answerWith = 200;
    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.stopChannel, false);
    assert.match(outcome.detail, /answered 503/);
    assert.equal(published.length, 1, "the channel retried inside the run");
  });

  it("reports a channel that cannot be reached at all", async () => {
    const origin = await closedLoopbackOrigin();
    const { channel } = channelUnderTest({
      config: testAlertConfig({ channel: { endpoint: `${origin}/deals` } }),
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.stopChannel, false);
  });

  it("records no cooldown, attempts no redelivery, and delivers the rest", async () => {
    published.length = 0;
    const cooldowns = memoryAlertCooldowns();
    const clock = new FakeClock(NOW.getTime());
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock,
      config: governorConfig(),
    });

    // The first listing's publish is answered 503 and the second's 200. The
    // stub decides by path, so the two are independent.
    let publishes = 0;
    const failingThenFine = await startLoopbackServer((request, response) => {
      if ((request.url ?? "/").split("?")[0] === "/robots.txt") {
        response.writeHead(404);
        response.end("no rules");
        return;
      }
      publishes += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(publishes === 1 ? 503 : 200, { "content-type": "text/plain" });
        response.end("");
      });
    });

    try {
      const config = testAlertConfig({
        channel: { endpoint: `${failingThenFine.origin}/deals` },
      });
      const report = await runAlertEvaluation({
        config,
        listings: memoryAlertListings([
          {
            sourceId: "bestbuy-api",
            listingId: "first",
            listingUrl: "https://example.invalid/a",
          },
          {
            sourceId: "bestbuy-api",
            listingId: "second",
            listingUrl: "https://example.invalid/b",
          },
        ]),
        history: memoryObservationHistory({
          first: series(),
          second: series(),
        }),
        cooldowns,
        channel: governedChannel({
          governor,
          config: config.channel,
          sourceId: config.sourceId,
          credential: null,
        }),
        clock,
        sourceIds: ["bestbuy-api"],
      });

      const source = report.sources[0];
      assert.equal(source.failures.length, 1);
      assert.equal(source.failures[0].listingId, "first");
      assert.equal(source.delivered.length, 1);
      assert.equal(source.delivered[0].listingId, "second");
      assert.equal(publishes, 2, "the run retried the failed delivery inside the run");

      assert.equal(
        await cooldowns.read("bestbuy-api", "first", "window-low-test"),
        null,
        "a failed delivery recorded a cooldown, so the owner never gets that alert",
      );
      assert.notEqual(
        await cooldowns.read("bestbuy-api", "second", "window-low-test"),
        null,
        "a delivered alert recorded no cooldown, so it will be sent again",
      );
    } finally {
      await failingThenFine.close();
    }
  });
});

describe("A13: a credential refusal stops the channel for the run", () => {
  for (const status of [401, 403]) {
    it(`treats ${status} as a refusal of the credential, naming the channel`, async () => {
      answerWith = status;
      published.length = 0;
      const { channel } = channelUnderTest({});

      const outcome = await channel.deliver(notification());

      answerWith = 200;
      assert.equal(outcome.delivered, false);
      if (outcome.delivered) return;
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.stopChannel, true);
      assert.match(outcome.detail, new RegExp(`answered ${status}`));
      // Named by ORIGIN: the path is a topic, which the cited channel's own
      // documentation calls "essentially a password".
      assert.match(outcome.detail, new RegExp(server.origin.replace(/\./g, "\\.")));
      assert.doesNotMatch(outcome.detail, /\/deals/);
    });
  }

  it("attempts nothing further in the run and records no cooldown for any of it", async () => {
    const cooldowns = memoryAlertCooldowns();
    const clock = new FakeClock(NOW.getTime());
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock,
      config: governorConfig(),
    });

    let publishes = 0;
    const refusing = await startLoopbackServer((request, response) => {
      if ((request.url ?? "/").split("?")[0] === "/robots.txt") {
        response.writeHead(404);
        response.end("no rules");
        return;
      }
      publishes += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("");
      });
    });

    try {
      const config = testAlertConfig({ channel: { endpoint: `${refusing.origin}/deals` } });
      const report = await runAlertEvaluation({
        config,
        listings: memoryAlertListings([
          { sourceId: "bestbuy-api", listingId: "first", listingUrl: "https://example.invalid/a" },
          { sourceId: "bestbuy-api", listingId: "second", listingUrl: "https://example.invalid/b" },
          { sourceId: "bestbuy-api", listingId: "third", listingUrl: "https://example.invalid/c" },
        ]),
        history: memoryObservationHistory({
          first: series(),
          second: series(),
          third: series(),
        }),
        cooldowns,
        channel: governedChannel({
          governor,
          config: config.channel,
          sourceId: config.sourceId,
          credential: null,
        }),
        clock,
        sourceIds: ["bestbuy-api"],
      });

      assert.equal(publishes, 1, "delivery carried on after a credential refusal");
      assert.equal(report.channelStopped, true);
      assert.equal(report.sources[0].failures.length, 3);
      assert.equal(report.sources[0].delivered.length, 0);
      for (const listingId of ["first", "second", "third"]) {
        assert.equal(
          await cooldowns.read("bestbuy-api", listingId, "window-low-test"),
          null,
          `${listingId} recorded a cooldown for a notification nobody received`,
        );
      }
      // The rest of the run still REPORTS, so the owner learns what they missed.
      assert.match(report.sources[0].failures[1].detail, /refused this run's credential/);
    } finally {
      await refusing.close();
    }
  });
});

describe("A14: no credential reaches a body, a stored record or a report", () => {
  it("puts the credential in its header and nowhere else", async () => {
    answerWith = 200;
    published.length = 0;

    const { channel } = channelUnderTest({
      config: channelConfig({
        credential: {
          variable: "DEAL_SENTINEL_ALERT_TOKEN",
          header: "Authorization",
          prefix: "Bearer ",
        },
      }),
      credential: SECRET,
    });

    await channel.deliver(notification());

    assert.equal(published.length, 1);
    assert.equal(published[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(
      published[0].body.includes(SECRET),
      false,
      "the credential travelled in the notification body",
    );
    assert.equal(published[0].path.includes(SECRET), false);
  });

  it("scrubs the credential out of a reported failure", async () => {
    answerWith = 500;
    published.length = 0;

    const { channel } = channelUnderTest({
      config: channelConfig({
        credential: {
          variable: "DEAL_SENTINEL_ALERT_TOKEN",
          header: "Authorization",
          prefix: "Bearer ",
        },
      }),
      credential: SECRET,
    });

    const outcome = await channel.deliver(
      // A notification whose own text somehow carries the secret: the scrub is
      // total, so a caller cannot forget a case.
      notification({ body: `an alert mentioning ${SECRET}` }),
    );

    answerWith = 200;
    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.detail.includes(SECRET), false);
  });

  it("scrubs a credential-bearing endpoint out of a governor refusal", async () => {
    // The governor quotes the URL it was handed inside its refusal detail, and
    // a notification endpoint can carry the credential in its query string.
    const clock = new FakeClock(NOW.getTime());
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: governorConfig({
        hosts: {
          "127.0.0.9": { maxRequests: 10, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        },
      }),
    });
    const config = channelConfig({}, `/deals?auth=${SECRET}`);
    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(
      outcome.detail.includes(SECRET),
      false,
      "the governor's refusal carried the endpoint's credential into a report",
    );
    assert.match(outcome.detail, /auth=\[redacted\]/);
  });

  it("refuses to send to an endpoint carrying a credential in its userinfo", async () => {
    // The third place a URL keeps a credential, and the one that is not merely
    // scrubbed: a credential inside the URL is quoted back by the governor, by
    // the transport and by every error either of them raises, so it is not sent
    // at all. The host HAS a ceiling here, so nothing but the userinfo can be
    // what refuses this.
    answerWith = 200;
    published.length = 0;

    const endpoint = new URL(`${server.origin}/deals`);
    endpoint.username = "alerts";
    endpoint.password = SECRET;
    const config = testAlertConfig({ channel: { endpoint: endpoint.href } });
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(NOW.getTime()),
      config: governorConfig(),
    });
    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.kind, "unconfigured");
    assert.equal(outcome.stopChannel, false);
    assert.equal(published.length, 0, "a credential-bearing URL was sent");
    assert.equal(
      outcome.detail.includes(SECRET),
      false,
      "the endpoint's userinfo credential reached a reported failure detail",
    );
    assert.doesNotMatch(outcome.detail, /alerts:/);
    assert.equal(channel.describedAs, server.origin);
  });

  it("scrubs a userinfo credential out of any URL it is asked to report", () => {
    // The backstop for text this package did not compose: a governor refusal or
    // a transport error quotes the whole href, and userinfo is a credential
    // whether or not it is the one this redactor was handed.
    const scrubbed = channelRedactor(null).scrub(
      `the request to https://alerts:${SECRET}@notify.example.invalid/deals is refused`,
    );

    assert.equal(scrubbed.includes(SECRET), false);
    assert.match(scrubbed, /https:\/\/\[redacted\]@notify\.example\.invalid\/deals/);
  });

  it("leaves an @ that is not userinfo alone", () => {
    const text = "https://retailer.example.invalid/p/8880044?notify=owner@example.invalid";

    assert.equal(channelRedactor(null).scrub(text), text);
  });

  it("stores no credential and no URL in the cooldown record", async () => {
    answerWith = 200;
    published.length = 0;
    const cooldowns = memoryAlertCooldowns();
    const clock = new FakeClock(NOW.getTime());
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock,
      config: governorConfig(),
    });

    const config = channelConfig(
      {
        credential: {
          variable: "DEAL_SENTINEL_ALERT_TOKEN",
          header: "Authorization",
          prefix: "Bearer ",
        },
      },
      `/deals?auth=${SECRET}`,
    );

    await runAlertEvaluation({
      config,
      listings: memoryAlertListings([
        {
          sourceId: "bestbuy-api",
          listingId: "8880044",
          listingUrl: "https://example.invalid/a",
        },
      ]),
      history: memoryObservationHistory({ "8880044": series() }),
      cooldowns,
      channel: governedChannel({
        governor,
        config: config.channel,
        sourceId: config.sourceId,
        credential: SECRET,
      }),
      clock,
      sourceIds: ["bestbuy-api"],
    });

    const stored = await cooldowns.read("bestbuy-api", "8880044", "window-low-test");
    assert.notEqual(stored, null);
    const serialised = JSON.stringify(stored, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    assert.equal(serialised.includes(SECRET), false);
    assert.equal(serialised.includes("http"), false, "a URL reached a stored alert record");
  });
});

/** A synthetic series that fires the harness's rule on its last observation. */
function series() {
  return [
    point(12_999n, new Date(NOW.getTime() - 5 * DAY_MS)),
    point(10_999n, new Date(NOW.getTime() - 4 * DAY_MS)),
    point(11_999n, new Date(NOW.getTime() - 3 * DAY_MS)),
    point(8_999n, NOW),
  ];
}
