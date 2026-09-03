/**
 * regress_0023_F12 - impl-gate ordinal 4, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F12 (advisory): the repository-wide scan never reads a directory
 * named `dist`, `build` or `coverage`, at ANY depth, so a call site under one
 * of those names is not "anywhere in the tree" as far as the check is
 * concerned. `packages/adapters/src/build/client.ts` is an ordinary path and it
 * is invisible.
 *
 * Acceptance criterion 2 (spec.md):
 *
 *   WHEN a call site that issues an outbound HTTP request outside the governor
 *   is introduced ANYWHERE IN THE TREE THE SYSTEM SHALL fail a check that runs
 *   as part of `pnpm run test`.
 *
 * Root cause, `packages/governor/src/no-direct-http.ts`:
 *
 *   const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist",
 *     "build", "coverage"]);
 *   ...
 *   for (const entry of readdirSync(directory).sort()) {
 *     if (SKIPPED_DIRECTORIES.has(entry)) continue;
 *
 * The name is matched on the basename, not on a repository-relative path, so
 * the exclusion is not "the generated output at the root" but "any directory
 * anywhere with one of these three names". This repository has a `tsc
 * --noEmit` build and produces none of them today, which is exactly why the
 * hole is silent: nothing in the suite would notice it opening.
 *
 * Filed ADVISORY rather than blocking: it takes a source directory with a
 * generated-output name before it bites, which is a naming accident rather
 * than a bypass anybody reaches for. It is recorded because unlike the
 * masking limitation the module header states, this one is not written down
 * anywhere, and because the fix is one line - skip those names only at the
 * repository root, or skip nothing that git tracks.
 *
 * This file documents the behaviour. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { collectSourceFiles, findDirectHttpCallSites } from "@deal-sentinel/governor";

const CLIENT = "fet" + "ch";
const BYPASS = `export async function listing(url: string) {\n  return await ${CLIENT}(url);\n}\n`;

describe("F12: a directory with a generated-output name is not scanned", () => {
  it("scans a call site under packages/adapters/src/build", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "regress-0023-f12-"));
    try {
      const plain = path.join(root, "packages", "adapters", "src");
      const named = path.join(plain, "build");
      mkdirSync(named, { recursive: true });
      writeFileSync(path.join(plain, "visible.ts"), BYPASS, "utf8");
      writeFileSync(path.join(named, "client.ts"), BYPASS, "utf8");

      const files = collectSourceFiles(root);
      const findings = findDirectHttpCallSites(files);

      console.log("files the scan read:", files.map((file) => file.path));
      console.log("call sites reported:", findings.map((finding) => finding.path));

      // The control: the identical file one directory up IS reported, so the
      // sample itself is a call site the check knows how to find.
      assert.equal(
        findings.some((finding) => finding.path === "packages/adapters/src/visible.ts"),
        true,
        "the probe is not set up: the control call site was not reported",
      );

      assert.equal(
        findings.some(
          (finding) => finding.path === "packages/adapters/src/build/client.ts",
        ),
        true,
        "a bare call on the global HTTP client under a directory named build " +
          "was never read, so no rule could report it",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
