/**
 * Acceptance criteria AC-26 and AC-27 of spec S0066-deal-sentinel-ops-5: the
 * operator surface adds no way out of the governor, and its delivery opens no
 * listening socket.
 *
 * THE DELIVERY THIS WORK CHOSE is a produced FILE. The command writes a page to
 * a configured path and exits; the owner opens that file; nothing listens on
 * any path the page is produced or read by. That choice is what makes the
 * second half of AC-27 the half with a claim in it, and this suite asserts that
 * claim at run time rather than by reading the code: it watches the process's
 * own open handles while the page is produced and read, and proves that probe
 * can see a server by starting one.
 *
 * The first half is held from the other direction: nothing in
 * `@deal-sentinel/ops` names a client or a server module, no allowlist entry
 * was added for it, and the tree-wide scan that would report one is run here
 * over the whole repository as it now stands.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HTTP_CLIENT_ALLOWLIST,
  collectSourceFiles,
  describeFindings,
  findDirectHttpCallSites,
  stripComments,
} from "@deal-sentinel/governor";
import { renderDashboard, writeDashboard } from "@deal-sentinel/ops";

import { startLoopbackServer } from "../support/loopback-server.ts";
import { sampleDashboardModel } from "../support/ops-5-harness.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * What Node calls a handle that is listening for connections. Matched
 * case-insensitively: the exact spelling is a runtime detail, and a probe that
 * silently matched nothing would report a clean process forever.
 */
const SERVER_HANDLES = ["tcpserverwrap", "pipeserverwrap"];

function listeningHandles(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => SERVER_HANDLES.includes(resource.toLowerCase()));
}

describe("AC-26: the operator surface adds no way around the chokepoint", () => {
  const files = collectSourceFiles(REPO_ROOT);

  it("reports no direct HTTP call site anywhere in the tree as it now stands", () => {
    const findings = findDirectHttpCallSites(files);
    assert.deepEqual(findings, [], describeFindings(findings));
  });

  it("reached the new package and the render grader with that scan", () => {
    for (const expected of [
      "packages/ops/src/dashboard.ts",
      "packages/ops/src/health.ts",
      "packages/ops/src/write.ts",
      "packages/ops/src/cli/dashboard.ts",
      "test/support/ops-5-render.ts",
    ]) {
      assert.ok(
        files.some((file) => file.path === expected),
        `the scan did not reach ${expected}`,
      );
    }
  });

  it("leaves the allowlist exactly as it found it", () => {
    assert.deepEqual(
      HTTP_CLIENT_ALLOWLIST.map((entry) => entry.path),
      [
        "packages/governor/src/transport.ts",
        "packages/governor/src/governor.ts",
        "test/support/loopback-server.ts",
      ],
      "an entry was added to the HTTP client allowlist for the operator surface",
    );
  });

  it("keeps every sending rule on the one transport, and adds none", () => {
    const senders = HTTP_CLIENT_ALLOWLIST.filter(
      (entry) =>
        entry.rules.includes("fetch-call") || entry.rules.includes("client-request-call"),
    );
    assert.deepEqual(senders.map((entry) => entry.path), [
      "packages/governor/src/transport.ts",
    ]);
    for (const entry of HTTP_CLIENT_ALLOWLIST) {
      assert.equal(
        entry.path.startsWith("packages/ops/"),
        false,
        `${entry.path} is allowlisted, so the operator surface may name a client`,
      );
    }
  });

  it("would report a bypass parked inside the operator surface", () => {
    // The pass above only means something if the scan is reading these paths
    // as ordinary source. A committed sample under the surface's own path is
    // reported exactly as it would be anywhere else.
    const sample = readFileSync(
      path.join(REPO_ROOT, "test/fixtures/no-direct-http/bypassing-adapter.ts.fixture"),
      "utf8",
    );
    const findings = findDirectHttpCallSites([
      { path: "packages/ops/src/dashboard.ts", text: sample },
    ]);
    assert.ok(
      findings.some((found) => found.rule === "fetch-call"),
      "a client call inside the operator surface was not reported",
    );
  });

  it("names no server module in the package or in its command", () => {
    const surface = files.filter(
      (file) => file.path.startsWith("packages/ops/") || file.path === "test/support/ops-5-render.ts",
    );
    assert.ok(surface.length >= 8, `only ${surface.length} file(s) make up the surface`);
    const findings = findDirectHttpCallSites(surface, []);
    assert.deepEqual(
      findings,
      [],
      "the operator surface names a client or a server module even with the " +
        `allowlist emptied: ${describeFindings(findings)}`,
    );
  });
});

describe("AC-27: the page is a file, and nothing listens to produce or read it", () => {
  it("opens no listening socket while the page is produced and read", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ops-5-delivery-"));
    try {
      assert.deepEqual(listeningHandles(), [], "something was already listening");

      const target = path.join(directory, "index.html");
      const written = writeDashboard(renderDashboard(sampleDashboardModel()), target);
      const read = readFileSync(written, "utf8");

      assert.ok(read.includes("deal-sentinel"), "the page was not produced at all");
      assert.deepEqual(
        listeningHandles(),
        [],
        "producing or reading the dashboard opened a listening socket",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("can see a listening socket, which is what makes the assertion above mean anything", async () => {
    const server = await startLoopbackServer((_request, response) => {
      response.end();
    });
    try {
      assert.equal(
        listeningHandles().length,
        1,
        `the probe cannot see a server that is listening right now: ` +
          `${process.getActiveResourcesInfo().join(", ")}`,
      );
      // And it is bound to loopback, which is the other half of AC-27: a
      // delivery that listened would have to be, and this suite's own server is.
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:/);
    } finally {
      await server.close();
    }
  });

  it("delivers a file: the command writes one and returns, with no port anywhere", () => {
    const command = stripComments(
      readFileSync(path.join(REPO_ROOT, "packages/ops/src/cli/dashboard.ts"), "utf8"),
    );
    assert.match(command, /writeDashboard/);
    // The CODE, with its prose blanked: the header talks about there being no
    // port, and a check that fires on a sentence about a port is a check
    // somebody deletes.
    assert.doesNotMatch(command, /\blisten\b|\bport\b|createServer/);
    // And the configured delivery is a path rather than an address.
    const config = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/ops.json"), "utf8"),
    ) as { dashboard: { outputPath: string } };
    assert.match(config.dashboard.outputPath, /\.html$/);
  });
});
