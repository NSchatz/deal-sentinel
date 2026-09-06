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
  validateDashboardConfig,
} from "@deal-sentinel/dashboard";

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

describe("criterion 24: the address is one address, and the committed one is loopback", () => {
  it("REFUSES a wildcard, which is not an address but every address", () => {
    for (const bindAddress of ["0.0.0.0", "::", "*"]) {
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

  it("knows loopback from everything else", () => {
    for (const address of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1"]) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of ["192.168.1.10", "10.0.0.1", "0.0.0.0", "128.0.0.1", "example.invalid"]) {
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
