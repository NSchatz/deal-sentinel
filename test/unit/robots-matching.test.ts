/**
 * Acceptance criteria 9 and 11 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC9  WHEN a retrieved `robots.txt` carries rules for a group that applies to
 *        this fetcher THE SYSTEM SHALL fetch a URL only if those rules allow it,
 *        resolving competing rules by the longest matching path, preferring
 *        `allow` when an `allow` and a `disallow` are equivalent, matching paths
 *        case sensitively, and selecting the group case insensitively with a
 *        fallback to the `*` group.
 *   AC11 IF a retrieved `robots.txt` is larger than the configured parsing
 *        limit, which SHALL NOT be configurable below 500 kibibytes, THEN THE
 *        SYSTEM SHALL parse the leading portion up to that limit and SHALL NOT
 *        reject the file outright.
 *
 * RFC 9309 2.2.1 and 2.2.2 are the two case rules in one file: group selection
 * is case-INSENSITIVE ("Crawlers MUST use case-insensitive matching to find the
 * group that matches the product token"), path matching is case-SENSITIVE ("The
 * matching SHOULD be case sensitive"), the most specific match is "the match
 * that has the most octets", and "If an 'allow' rule and a 'disallow' rule are
 * equivalent, then the 'allow' rule SHOULD be used."
 *
 * The end-to-end cases run against a stub server on 127.0.0.1 (AC23).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  LIVE_TRANSPORT,
  decidePath,
  matchesPattern,
  normalisePath,
  parseRobotsTxt,
  selectGroup,
} from "@deal-sentinel/governor";

import { reply, routes, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const ROBOTS = [
  "# a comment on its own line",
  "User-agent: OtherBot",
  "Disallow: /",
  "",
  "User-agent: Deal-Sentinel   # the group that applies, matched case-insensitively",
  "Disallow: /private/",
  "Allow: /private/public-corner/",
  "Disallow: /Case/",
  "Allow: /tie",
  "Disallow: /tie",
  "Disallow: /*.pdf$",
  "Sitemap: http://127.0.0.1/sitemap.xml",
  "",
  "User-agent: *",
  "Disallow: /everything",
].join("\n");

function config(parsingLimitBytes = 512_000) {
  return testConfig({
    http: { requestTimeoutMs: 5_000, maxResponseBytes: 4_194_304 },
    robots: { productToken: "deal-sentinel", parsingLimitBytes },
    hosts: {
      "127.0.0.1": {
        maxRequests: 500,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
  });
}

describe("the rules of the group that applies decide every fetch", () => {
  let server: LoopbackServer;

  before(async () => {
    server = await startLoopbackServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(ROBOTS);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`served ${path}`);
    });
  });

  after(async () => {
    await server.close();
  });

  const cases: Array<[string, boolean, string]> = [
    ["/open/page", true, "no rule in the group matches it"],
    ["/private/secret", false, "disallow: /private/ matches"],
    [
      "/private/public-corner/item",
      true,
      "the longer allow beats the shorter disallow",
    ],
    ["/Case/page", false, "disallow: /Case/ matches exactly"],
    ["/case/page", true, "path matching is case sensitive, so /case/ is not /Case/"],
    ["/tie", true, "an equivalent allow and disallow resolve to allow"],
    ["/report.pdf", false, "the anchored wildcard rule matches"],
    ["/report.pdf.html", true, "the anchor means the match must end there"],
    ["/everything", true, "the star group does not apply once a named group does"],
  ];

  for (const [path, allowed, why] of cases) {
    it(`${allowed ? "fetches" : "refuses"} ${path}: ${why}`, async () => {
      const { governor } = buildGovernor({
        transport: LIVE_TRANSPORT,
        clock: new FakeClock(),
        config: config(),
      });

      const outcome = await governor.request({
        url: `${server.origin}${path}`,
        sourceId: "test-source",
      });

      assert.equal(outcome.ok, allowed, JSON.stringify(outcome));
      if (!allowed) {
        if (outcome.ok) return;
        assert.equal(outcome.reason, "robots-disallowed");
        assert.equal(
          server.servedFor(path).length,
          0,
          "a disallowed path was fetched anyway",
        );
      }
    });
  }
});

describe("the star group applies when no group names this fetcher", () => {
  let server: LoopbackServer;

  before(async () => {
    server = await startLoopbackServer(
      routes({
        "/robots.txt": reply(
          200,
          ["User-agent: BazBot", "Disallow: /baz", "", "User-agent: *", "Disallow: /foo"].join(
            "\n",
          ),
        ),
        "/foo/page": reply(200, "foo"),
        "/baz/page": reply(200, "baz"),
      }),
    );
  });

  after(async () => {
    await server.close();
  });

  it("obeys the star group's disallow", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(),
    });
    const outcome = await governor.request({
      url: `${server.origin}/foo/page`,
      sourceId: "test-source",
    });
    assert.equal(outcome.ok, false);
    assert.equal(server.servedFor("/foo/page").length, 0);
  });

  it("does not obey a group that names somebody else", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(),
    });
    const outcome = await governor.request({
      url: `${server.origin}/baz/page`,
      sourceId: "test-source",
    });
    assert.equal(outcome.ok, true);
  });
});

describe("a robots.txt larger than the parsing limit is truncated, not rejected", () => {
  let server: LoopbackServer;
  const limit = 512_000;

  before(async () => {
    const head = [
      "User-agent: *",
      "Disallow: /blocked-early",
      "",
    ].join("\n");
    // Padding that is all comments, so the only thing past the limit is the
    // late rule. `limit` bytes of it guarantees the late rule is beyond it.
    const padding = `${"# padding\n".repeat(Math.ceil(limit / 10))}`;
    const tail = "Disallow: /blocked-late\n";

    server = await startLoopbackServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${head}\n${padding}${tail}`);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`served ${path}`);
    });
  });

  after(async () => {
    await server.close();
  });

  it("obeys a rule inside the limit and does not treat the host as unreachable", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(limit),
    });

    const blocked = await governor.request({
      url: `${server.origin}/blocked-early`,
      sourceId: "test-source",
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(
      blocked.reason,
      "robots-disallowed",
      "an oversized robots.txt was rejected outright instead of parsed",
    );

    const allowed = await governor.request({
      url: `${server.origin}/other-page`,
      sourceId: "test-source",
    });
    assert.equal(allowed.ok, true, "the oversized file closed the whole host");
  });

  it("does not obey a rule that fell beyond the limit", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(limit),
    });

    const outcome = await governor.request({
      url: `${server.origin}/blocked-late`,
      sourceId: "test-source",
    });
    // Not a promise that the rule is ignored - a demonstration that the limit
    // is real. RFC 9309 2.5 requires the limit; the file's author is the one
    // who put a rule past 500 KiB.
    assert.equal(outcome.ok, true);
  });
});

describe("the matcher, on its own", () => {
  it("merges two groups that name the same product token", () => {
    const file = parseRobotsTxt(
      [
        "user-agent: ExampleBot",
        "disallow: /foo",
        "disallow: /bar",
        "",
        "user-agent: ExampleBot",
        "disallow: /baz",
      ].join("\n"),
    );
    const rules = selectGroup(file, "examplebot");
    assert.deepEqual(
      rules.map((rule) => rule.pattern),
      ["/foo", "/bar", "/baz"],
    );
  });

  it("keeps two user-agent lines in a row in one group", () => {
    const file = parseRobotsTxt(
      ["user-agent: A", "user-agent: B", "disallow: /shared"].join("\n"),
    );
    assert.equal(selectGroup(file, "A").length, 1);
    assert.equal(selectGroup(file, "B").length, 1);
  });

  it("ignores rules that precede the first user-agent line", () => {
    const file = parseRobotsTxt(["disallow: /orphan", "user-agent: *", "allow: /"].join("\n"));
    const rules = selectGroup(file, "anyone");
    assert.deepEqual(
      rules.map((rule) => rule.pattern),
      ["/"],
    );
  });

  it("keeps other records without terminating a group", () => {
    const file = parseRobotsTxt(
      [
        "user-agent: *",
        "disallow: /a",
        "sitemap: https://example.invalid/sitemap.xml",
        "disallow: /b",
      ].join("\n"),
    );
    assert.equal(selectGroup(file, "anyone").length, 2);
    assert.deepEqual(file.otherRecords, [
      { field: "sitemap", value: "https://example.invalid/sitemap.xml" },
    ]);
  });

  it("treats an empty disallow as a rule that matches nothing", () => {
    const rules = selectGroup(
      parseRobotsTxt(["user-agent: *", "disallow:"].join("\n")),
      "anyone",
    );
    assert.equal(decidePath(rules, "/anything").allowed, true);
  });

  it("allows /robots.txt implicitly, whatever the rules say", () => {
    const rules = selectGroup(
      parseRobotsTxt(["user-agent: *", "disallow: /"].join("\n")),
      "anyone",
    );
    assert.equal(decidePath(rules, "/robots.txt").allowed, true);
    assert.equal(decidePath(rules, "/anything-else").allowed, false);
  });

  it("matches the query string as part of the path", () => {
    const rules = selectGroup(
      parseRobotsTxt(["user-agent: *", "disallow: /search?q="].join("\n")),
      "anyone",
    );
    assert.equal(decidePath(rules, "/search?q=drill").allowed, false);
    assert.equal(decidePath(rules, "/search").allowed, true);
  });

  it("supports the two special characters the standard requires", () => {
    assert.equal(matchesPattern("/this/*/exactly", "/this/or/that/exactly"), true);
    assert.equal(matchesPattern("/this/path/exactly$", "/this/path/exactly"), true);
    assert.equal(matchesPattern("/this/path/exactly$", "/this/path/exactly/more"), false);
    assert.equal(matchesPattern("/fish", "/fishheads"), true);
    assert.equal(matchesPattern("/fish/", "/fishheads"), false);
  });

  it("unencodes an unreserved percent-encoded octet before comparing", () => {
    // RFC 9309 2.2.2, figure 4: /foo/bar/%62%61%7A compares as /foo/bar/baz,
    // while %E3%83%84 and %3A stay encoded.
    assert.equal(normalisePath("/foo/bar/%62%61%7A"), "/foo/bar/baz");
    assert.equal(normalisePath("/foo/bar/%E3%83%84"), "/foo/bar/%E3%83%84");
    assert.equal(normalisePath("/foo/bar?baz=https%3A%2F%2Ffoo.bar"), "/foo/bar?baz=https%3A%2F%2Ffoo.bar");
  });

  it("prefers the rule with the most octets, and allow on a tie", () => {
    const rules = selectGroup(
      parseRobotsTxt(
        [
          "user-agent: *",
          "disallow: /a/b/c/d",
          "allow: /a/b",
          "allow: /x",
          "disallow: /x",
        ].join("\n"),
      ),
      "anyone",
    );
    assert.equal(decidePath(rules, "/a/b/c/d/e").allowed, false);
    assert.equal(decidePath(rules, "/a/b/c").allowed, true);
    assert.equal(decidePath(rules, "/x").allowed, true);
  });

  it("drops the last line of a truncated file rather than acting on half a rule", () => {
    const truncated = parseRobotsTxt(
      ["user-agent: *", "disallow: /keep", "allow: /par"].join("\n"),
      true,
    );
    assert.deepEqual(
      selectGroup(truncated, "anyone").map((rule) => rule.pattern),
      ["/keep"],
    );
  });
});
