/**
 * Acceptance criterion A10 of spec S0036-deal-sentinel-alert-4:
 *
 *   IF the alert configuration is absent, unparseable, or missing any setting a
 *   configured rule requires THEN THE SYSTEM SHALL refuse to start, naming the
 *   file and the missing setting, and SHALL evaluate no rule and deliver
 *   nothing.
 *
 * "Refuse to start" is graded the way the criterion means it, and not only as a
 * thrown error: the last block below RUNS the start-check binary against a
 * broken file in a temporary directory and asserts a non-zero exit and a
 * message naming the file. A refusal that only exists inside a test process
 * would say nothing about the container that is about to come up.
 *
 * The committed file is asserted on too. `config/alerts.json` is what the
 * homelab actually loads, and a suite that only ever validated documents it
 * built itself would pass on a repository that ships a file which refuses.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AlertConfigError,
  DEFAULT_ALERTS_CONFIG_PATH,
  alertsStartCheck,
  loadAlertConfig,
  parseAlertConfig,
  validateAlertConfig,
} from "@deal-sentinel/alerts";

import { alertDocument } from "../support/alert-harness.ts";

const execFile = promisify(execFileCallback);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const START_CHECK = path.join(REPO_ROOT, "packages/alerts/src/cli/start-check.ts");
const COMMITTED_GOVERNOR = path.join(REPO_ROOT, "config/governor.json");

const scratch = mkdtempSync(path.join(tmpdir(), "deal-sentinel-alerts-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run something that must refuse, and hand back the refusal it made. */
function caught(run: () => unknown): AlertConfigError {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof AlertConfigError,
      `expected an AlertConfigError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected a refusal, and nothing was thrown");
}

function refusal(mutate: (document: Record<string, unknown>) => void): AlertConfigError {
  const document = alertDocument();
  mutate(document);
  return caught(() => validateAlertConfig(document, "the test alert configuration"));
}

/** The one rule the fixture document declares, as a mutable object. */
function theRule(document: Record<string, unknown>): Record<string, unknown> {
  const rules = document.rules as Record<string, Record<string, unknown>>;
  return rules["window-low-test"];
}

function theChannel(document: Record<string, unknown>): Record<string, unknown> {
  return document.channel as Record<string, unknown>;
}

describe("A10: an absent or unparseable configuration refuses, naming the file", () => {
  it("refuses a file that is not there", () => {
    const missing = path.join(scratch, "not-here.json");
    const error = caught(() => loadAlertConfig(missing));
    assert.match(error.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(error.message, /no rule has a window, a minimum or a cooldown/);
    assert.match(error.message, /nothing is delivered/i);
  });

  it("refuses a document that is not JSON", () => {
    const error = caught(() => parseAlertConfig("{ this is not json", "config/alerts.json"));
    assert.match(error.message, /config\/alerts\.json/);
    assert.match(error.message, /not parseable as JSON/);
  });

  it("refuses a document that is not an object", () => {
    const error = caught(() => parseAlertConfig("[]", "config/alerts.json"));
    assert.match(error.message, /must be a JSON object/);
  });
});

describe("A10: a setting a configured rule requires, missing", () => {
  const required = [
    "windowMs",
    "minimumObservations",
    "improvementMinorUnits",
    "cooldownMs",
    "kind",
  ];

  for (const setting of required) {
    it(`refuses a rule with no ${setting}, naming it`, () => {
      const error = refusal((document) => {
        delete theRule(document)[setting];
      });
      assert.equal(error.setting, `rules["window-low-test"].${setting}`);
      assert.match(error.message, new RegExp(setting));
      assert.match(error.message, /the test alert configuration/);
    });
  }

  it("refuses a window that is not a whole number", () => {
    const error = refusal((document) => {
      theRule(document).windowMs = 1.5;
    });
    assert.match(error.message, /must be a whole number/);
  });

  it("refuses a minimum of one, which is not a claim about history", () => {
    const error = refusal((document) => {
      theRule(document).minimumObservations = 1;
    });
    assert.match(error.message, /at least 2/);
  });

  it("refuses a rule kind nothing in this build evaluates", () => {
    const error = refusal((document) => {
      theRule(document).kind = "percentage-drop";
    });
    assert.match(error.message, /only rule kind this build implements/);
    assert.match(error.message, /believes is running and is not/);
  });

  it("refuses an unrecognised key rather than ignoring it", () => {
    const error = refusal((document) => {
      theRule(document).thresholdPercent = 20;
    });
    assert.match(error.message, /unrecognised key/);
    assert.match(error.message, /silently did not/);
  });

  it("refuses a document with no rules at all", () => {
    const error = refusal((document) => {
      document.rules = {};
    });
    assert.match(error.message, /declares no entries under "rules"/);
  });

  it("refuses a document with no rules key at all", () => {
    const error = refusal((document) => {
      delete document.rules;
    });
    assert.equal(error.setting, "rules");
  });
});

describe("A10: the channel's own required settings", () => {
  it("refuses a channel with no endpoint KEY, which a truncated file has", () => {
    const error = refusal((document) => {
      delete theChannel(document).endpoint;
    });
    assert.equal(error.setting, "channel.endpoint");
    assert.match(error.message, /Write null there/);
  });

  it("accepts an explicit null endpoint, which is what this repository ships", () => {
    const config = validateAlertConfig(alertDocument(), "the test alert configuration");
    assert.equal(config.channel.endpoint, null);
    assert.equal(config.channel.host, null);
  });

  it("refuses an endpoint that is not http or https", () => {
    const error = refusal((document) => {
      theChannel(document).endpoint = "file:///etc/passwd";
    });
    assert.match(error.message, /scheme/);
  });

  it("refuses a method that carries no body", () => {
    const error = refusal((document) => {
      theChannel(document).method = "GET";
    });
    assert.match(error.message, /no alert in it/);
  });

  it("refuses a header value carrying a line break", () => {
    const error = refusal((document) => {
      theChannel(document).headers = { "X-Topic": "deals\r\nX-Priority: 5" };
    });
    assert.match(error.message, /second header nobody wrote/);
  });

  it("refuses a credential with no variable, header or prefix", () => {
    for (const key of ["variable", "header", "prefix"]) {
      const error = refusal((document) => {
        const credential: Record<string, unknown> = {
          variable: "DEAL_SENTINEL_ALERT_TOKEN",
          header: "Authorization",
          prefix: "Bearer ",
        };
        delete credential[key];
        theChannel(document).credential = credential;
      });
      assert.match(error.message, new RegExp(`channel\\.credential\\.${key}`));
    }
  });

  it("refuses a credential KEY that is simply absent", () => {
    const error = refusal((document) => {
      delete theChannel(document).credential;
    });
    assert.equal(error.setting, "channel.credential");
    assert.match(error.message, /needs none/);
  });

  it("refuses a clearance ending that is not digits", () => {
    const error = refusal((document) => {
      document.clearanceEndings = { "bestbuy-api": [".97"] };
    });
    assert.match(error.message, /decimal digits/);
  });
});

describe("A10: the start check refuses to start, and says so with an exit code", () => {
  it("exits non-zero on a broken configuration, naming the file", async () => {
    const broken = path.join(scratch, "broken-alerts.json");
    const document = alertDocument();
    delete theRule(document).cooldownMs;
    writeFileSync(broken, JSON.stringify(document, null, 2));

    const failure = await execFile("node", [START_CHECK, broken, COMMITTED_GOVERNOR]).then(
      () => null,
      (error: unknown) => error as { code: number; stderr: string },
    );

    assert.ok(failure !== null, "a configuration missing a cooldown started anyway");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /refusing to start/);
    assert.match(failure.stderr, /cooldownMs/);
    assert.match(failure.stderr, /broken-alerts\.json/);
  });

  it("refuses a channel whose host carries no ceiling in the governor's file", () => {
    const configured = path.join(scratch, "unceilinged-alerts.json");
    const document = alertDocument();
    theChannel(document).endpoint = "https://ntfy.example.invalid/deals";
    writeFileSync(configured, JSON.stringify(document, null, 2));

    const error = caught(() =>
      alertsStartCheck({ alertsPath: configured, governorPath: COMMITTED_GOVERNOR }),
    );
    assert.match(error.message, /carries no request ceiling for that host/);
    assert.match(error.message, /ntfy\.example\.invalid/);
  });

  it("refuses a channel whose source id the governor has never heard of", () => {
    const configured = path.join(scratch, "unknown-source-alerts.json");
    const document = alertDocument({ sourceId: "not-in-the-governor" });
    theChannel(document).endpoint = "http://127.0.0.1:8080/deals";
    writeFileSync(configured, JSON.stringify(document, null, 2));

    const error = caught(() =>
      alertsStartCheck({ alertsPath: configured, governorPath: COMMITTED_GOVERNOR }),
    );
    assert.match(error.message, /no entry under sources/);
  });
});

describe("the committed alert configuration", () => {
  it("loads, so the file this repository ships is not the one that refuses", () => {
    const config = loadAlertConfig(DEFAULT_ALERTS_CONFIG_PATH);
    assert.ok(Object.keys(config.rules).length >= 1);
    for (const rule of Object.values(config.rules)) {
      assert.ok(rule.windowMs >= 1);
      assert.ok(rule.minimumObservations >= 2);
      assert.ok(rule.cooldownMs >= 1);
    }
  });

  it("says in the file that its numbers are unvalidated (CLAUDE.md rule 8)", () => {
    const text = readFileSync(DEFAULT_ALERTS_CONFIG_PATH, "utf8");
    assert.match(text, /CONSERVATIVE AND UNVALIDATED/);
    assert.match(text, /BRIEF\.md deliberately fixes no threshold/);
  });

  it("ships no channel, so nothing is delivered until the owner chooses one", () => {
    const config = loadAlertConfig(DEFAULT_ALERTS_CONFIG_PATH);
    assert.equal(config.channel.endpoint, null);
    assert.equal(config.channel.credential, null);
  });

  it("asserts no clearance ending for any retailer", () => {
    const config = loadAlertConfig(DEFAULT_ALERTS_CONFIG_PATH);
    for (const [sourceId, endings] of Object.entries(config.clearanceEndings)) {
      assert.deepEqual(
        endings,
        [],
        `${sourceId} ships a price-ending pattern this project has no evidence for`,
      );
    }
  });

  it("names a source id the committed governor configuration knows", () => {
    // A11's other half: the start check succeeds against the committed pair,
    // with no database, no credential and no network reachable.
    const report = alertsStartCheck({
      alertsPath: DEFAULT_ALERTS_CONFIG_PATH,
      governorPath: COMMITTED_GOVERNOR,
      env: {},
    });
    assert.equal(report.channel.configured, false);
    assert.equal(report.rules.length >= 1, true);
    for (const rule of report.rules) {
      assert.ok(rule.windowMs >= 1);
      assert.ok(rule.minimumObservations >= 2);
      assert.ok(rule.cooldownMs >= 1);
    }
  });
});
