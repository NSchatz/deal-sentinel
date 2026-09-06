/**
 * Acceptance criteria 24 and 25 of spec S0042-deal-sentinel-ops-5:
 *
 *   24. WHEN the dashboard process starts THE SYSTEM SHALL bind only the address
 *       and port its configuration names, and the configuration committed to
 *       this repository SHALL name a loopback address.
 *   25. IF the dashboard's configuration is absent, unparseable, or missing any
 *       required value THEN THE SYSTEM SHALL refuse to start, SHALL name the
 *       missing or unreadable key, and SHALL NOT fall back to any built-in
 *       default.
 *
 * Criterion 25 is graded here in full. Criterion 24's second half is graded here
 * - against the COMMITTED file, read off disk, because "the configuration
 * committed to this repository" is a claim about that file and not about a
 * fixture - and its first half is graded in `dashboard-read-only.test.ts`, where
 * a socket actually exists to ask.
 *
 * THE ASSERTION THAT MATTERS IS THE ABSENCE OF A DEFAULT. A refusal that names
 * the key is a nicety; a process that started anyway on a staleness horizon
 * nobody chose is a page that says a dead source is fine.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEFAULT_DASHBOARD_CONFIG_PATH,
  DashboardConfigError,
  dashboardStartCheck,
  isLoopbackAddress,
  loadDashboardConfig,
  parseDashboardConfig,
  unspecifiedFamily,
  validateDashboardConfig,
} from "@deal-sentinel/dashboard";
import { stripComments } from "@deal-sentinel/governor";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every required key, so a test can remove exactly one. */
function completeDocument(): Record<string, unknown> {
  return {
    bindAddress: "127.0.0.1",
    port: 8787,
    stalenessHorizonMs: 172_800_000,
    ratePeriodMs: 86_400_000,
    defaultChartRangeMs: 7_776_000_000,
    conditionHistoryLimit: 20,
  };
}

const REQUIRED_KEYS = Object.keys(completeDocument());

describe("criterion 25: a configuration short of a value refuses to start", () => {
  it("refuses when the file is absent, and says so", () => {
    assert.throws(
      () => loadDashboardConfig(`${REPO_ROOT}config/there-is-no-such-file.json`),
      (error: unknown) => {
        assert.ok(error instanceof DashboardConfigError);
        assert.match(error.message, /could not be read/);
        assert.match(error.message, /built-in default/);
        return true;
      },
    );
  });

  it("refuses when the file is not parseable as JSON", () => {
    assert.throws(
      () => parseDashboardConfig("{ this is not json", "the test document"),
      (error: unknown) => {
        assert.ok(error instanceof DashboardConfigError);
        assert.match(error.message, /not parseable as JSON/);
        return true;
      },
    );
  });

  for (const key of REQUIRED_KEYS) {
    it(`refuses when ${key} is missing, and NAMES it`, () => {
      const document = completeDocument();
      delete document[key];
      assert.throws(
        () => validateDashboardConfig(document, "the test document"),
        (error: unknown) => {
          assert.ok(error instanceof DashboardConfigError);
          assert.equal(
            error.setting,
            key,
            `the refusal named ${String(error.setting)} rather than ${key}`,
          );
          assert.match(error.message, new RegExp(key));
          return true;
        },
      );
    });

    it(`refuses when ${key} is null, which is not "use the default"`, () => {
      const document = completeDocument();
      document[key] = null;
      assert.throws(
        () => validateDashboardConfig(document, "the test document"),
        DashboardConfigError,
      );
    });
  }

  it("falls back to NO default for any of them", () => {
    // The property behind every case above, stated once: an EMPTY document
    // produces no configuration at all. If any value had a built-in default,
    // this would either succeed or fail on a different key each time one was
    // removed - and the first thing anybody would notice is a dashboard that
    // started.
    assert.throws(
      () => validateDashboardConfig({}, "the test document"),
      DashboardConfigError,
    );
  });

  it("refuses an unrecognised key rather than ignoring it", () => {
    const document = { ...completeDocument(), stalenessHorizonSeconds: 3600 };
    assert.throws(
      () => validateDashboardConfig(document, "the test document"),
      (error: unknown) => {
        assert.ok(error instanceof DashboardConfigError);
        assert.equal(error.setting, "stalenessHorizonSeconds");
        return true;
      },
    );
  });

  it("refuses a horizon, period, range or limit that is not a whole number", () => {
    for (const key of [
      "stalenessHorizonMs",
      "ratePeriodMs",
      "defaultChartRangeMs",
      "conditionHistoryLimit",
      "port",
    ]) {
      const document = completeDocument();
      document[key] = "3600";
      assert.throws(
        () => validateDashboardConfig(document, "the test document"),
        DashboardConfigError,
        `${key} accepted a string`,
      );
    }
  });

  it("refuses a port outside the range a port can be", () => {
    for (const port of [0, -1, 65_536]) {
      const document = { ...completeDocument(), port };
      assert.throws(
        () => validateDashboardConfig(document, "the test document"),
        DashboardConfigError,
        `port ${port} was accepted`,
      );
    }
  });

  it("accepts a complete document, so the refusals above are not refusing everything", () => {
    const config = validateDashboardConfig(completeDocument(), "the test document");
    assert.equal(config.bindAddress, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.equal(config.stalenessHorizonMs, 172_800_000);
  });
});

/**
 * Every spelling of "every interface" that THIS RUNTIME BINDS to the
 * unspecified address, measured with `tests/regress_0042_probe_bind2.mjs`
 * rather than reasoned about. Each one answers `OK bound={"address":"0.0.0.0"}`
 * or `OK bound={"address":"::"}` from a real `server.listen`, so each one is a
 * configuration that says one address and gets all of them.
 *
 * The list is EVIDENCE, not the mechanism. `config.ts` compares no text: it
 * parses the value and asks its bytes. The test below proves that by asserting
 * none of these strings appears in `config.ts` or `address.ts` at all, which is
 * what makes the refusal a property rather than a list somebody extended once.
 */
const WILDCARD_SPELLINGS = [
  "0.0.0.0",
  "::",
  "::0",
  "0",
  "00",
  "0.0",
  "0.0.0",
  "0x0",
  "0x00000000",
  "0000000000",
  "000.000.000.000",
  "0:0:0:0:0:0:0:0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "::0.0.0.0",
  "::ffff:0.0.0.0",
  "::ffff:0:0",
  "[::]",
];

describe("criterion 24: the address is one address, and the committed one is loopback", () => {
  it("REFUSES a wildcard, which is not an address but every address", () => {
    for (const bindAddress of [...WILDCARD_SPELLINGS, "*"]) {
      assert.throws(
        () =>
          validateDashboardConfig(
            { ...completeDocument(), bindAddress },
            "the test document",
          ),
        (error: unknown) => {
          assert.ok(error instanceof DashboardConfigError);
          assert.equal(error.setting, "bindAddress");
          assert.match(error.message, /every address this machine has/);
          return true;
        },
        `${bindAddress} was accepted as a bind address`,
      );
    }
  });

  it("refuses them SEMANTICALLY: not one of those spellings is written down", () => {
    // The assertion that separates a fix from a longer denylist. If any
    // spelling above appears in the loader's own source, the refusal of THAT
    // spelling proves nothing about the next one - which is exactly how the
    // four-entry list this replaced passed its own test while binding every
    // interface. The bytes decide, so the text is absent.
    const code = [
      `${REPO_ROOT}packages/dashboard/src/config.ts`,
      `${REPO_ROOT}packages/dashboard/src/address.ts`,
    ]
      // The header of each file NAMES these spellings on purpose, so that a
      // reader can see what the rule is about. A comment decides nothing.
      .map((path) => stripComments(readFileSync(path, "utf8")))
      .join("\n");
    // `::` is the IPv6 compression token and `0` is the digit, and a PARSER has
    // to write both down - `body.split("::")` is not a denylist entry. Every
    // other spelling means nothing except as an address, so its presence in the
    // code could only be a comparison against it.
    const tokens = new Set(["::", "0"]);
    for (const spelling of WILDCARD_SPELLINGS.filter((one) => !tokens.has(one))) {
      assert.equal(
        code.includes(JSON.stringify(spelling)),
        false,
        `${spelling} is written into the loader's code, so its refusal is a ` +
          "spelling match and the next spelling walks past it",
      );
    }
  });

  it("refuses the unspecified address in a spelling nobody has seen yet", () => {
    // Invented here and measured against no probe. If the rule is really about
    // the bytes, a spelling written for the first time in this line is refused
    // on its own merits - either as the unspecified address it evaluates to, or
    // as text that names no single address at all.
    const invented = [
      "0000:0:0000:0:0000:0:0000:0",
      "0:0:0:0:0:0:0.0.0.0",
      "0000:0000::0000",
      "::ffff:000.000.000.000",
      "0x0.0x0.0x0.0x0",
      "0.0x0",
      "000000",
    ];
    for (const bindAddress of invented) {
      assert.throws(
        () =>
          validateDashboardConfig(
            { ...completeDocument(), bindAddress },
            "the test document",
          ),
        DashboardConfigError,
        `${bindAddress} was accepted as a bind address`,
      );
    }
  });

  it("still ACCEPTS the single addresses an owner may legitimately name", () => {
    // The other half of a refusal that means something: a rule that refused
    // everything would pass every assertion above and ship a dashboard that
    // cannot start.
    for (const bindAddress of [
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "[::1]",
      "192.168.1.10",
      "10.0.0.1",
      "::ffff:127.0.0.1",
      "fe80::1%eth0",
    ]) {
      const config = validateDashboardConfig(
        { ...completeDocument(), bindAddress },
        "the test document",
      );
      // Brackets are a URL authority's punctuation. What is stored is what is
      // handed to `listen`, and `listen` wants the address without them.
      assert.equal(config.bindAddress, bindAddress.replace(/^\[|\]$/g, ""));
    }
  });

  it("refuses a NAME, because a resolver answers at listen time and the file does not", () => {
    // `localhost` binds `::1` here and something else on a machine whose hosts
    // file says so, and `2130706433` binds 127.0.0.1 while reading as a port
    // number. Neither is an address a reader of the committed file can check.
    for (const bindAddress of [
      "localhost",
      "dashboard.local",
      "example.invalid",
      "2130706433",
      "0x7f000001",
      "127.0.0.1:8787",
      "010.0.0.1",
    ]) {
      assert.throws(
        () =>
          validateDashboardConfig(
            { ...completeDocument(), bindAddress },
            "the test document",
          ),
        (error: unknown) => {
          assert.ok(error instanceof DashboardConfigError);
          assert.equal(error.setting, "bindAddress");
          return true;
        },
        `${bindAddress} was accepted as a bind address`,
      );
    }
  });

  it("names which family's unspecified address it found", () => {
    // The classifier the refusal is built on, asked directly, so that a
    // refusal message saying "IPv6" is not the only evidence it knows which.
    assert.equal(unspecifiedFamily("0.0.0.0"), "ipv4");
    assert.equal(unspecifiedFamily("0"), "ipv4");
    assert.equal(unspecifiedFamily("::"), "ipv6");
    assert.equal(unspecifiedFamily("::0"), "ipv6");
    assert.equal(unspecifiedFamily("::ffff:0.0.0.0"), "ipv6");
    assert.equal(unspecifiedFamily("127.0.0.1"), null);
    assert.equal(unspecifiedFamily("::1"), null);
    assert.equal(unspecifiedFamily("::ffff:127.0.0.1"), null);
  });

  it("knows loopback from everything else", () => {
    for (const address of [
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "::1",
      // The same interface reached through the other family, and the
      // bracketed spelling a URL authority carries.
      "::ffff:127.0.0.1",
      "[::1]",
    ]) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of [
      "192.168.1.10",
      "10.0.0.1",
      "0.0.0.0",
      "128.0.0.1",
      "example.invalid",
      "::",
      "::ffff:0.0.0.0",
      "126.0.0.1",
      "128.0.0.1",
    ]) {
      assert.equal(isLoopbackAddress(address), false, address);
    }
  });

  it("the COMMITTED configuration names a loopback address", () => {
    // Read off disk, not from a fixture: the criterion is about the file this
    // repository ships.
    const committed = loadDashboardConfig();
    assert.equal(
      isLoopbackAddress(committed.bindAddress),
      true,
      `config/dashboard.json names ${committed.bindAddress}, which is not a ` +
        "loopback address. This process serves a display path that renders " +
        "vendor refusal details, and there is no authentication in front of it.",
    );
  });

  it("the committed file is the one the loader reads by default", () => {
    // A test that read a different file would prove nothing about the shipped
    // one, so the path is asserted rather than assumed.
    assert.match(DEFAULT_DASHBOARD_CONFIG_PATH, /config\/dashboard\.json$/);
    const onDisk = JSON.parse(
      readFileSync(DEFAULT_DASHBOARD_CONFIG_PATH, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(onDisk.bindAddress, "127.0.0.1");
  });

  it("the start check says out loud when an address is not loopback", () => {
    const loopback = dashboardStartCheck();
    assert.equal(loopback.loopback, true);
    assert.match(loopback.exposure, /reachable\s+only from this machine/);
  });
});
