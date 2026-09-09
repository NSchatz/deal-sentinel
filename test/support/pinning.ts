/**
 * The check that makes "everything this repository resolves is pinned" a
 * property of the tree rather than a habit.
 *
 * The umbrella's `documentation/pinning-conventions.md` (operator, 2026-09-07)
 * is the normative text. The clauses this module enforces, by name:
 *
 *   P1  A container image is pinned by tag AND digest. The tag stays readable
 *       to a human; the digest is what actually resolves.
 *   P2  A base image follows the same rule. A `FROM` line is an image
 *       reference like any other.
 *   P3  An action is pinned to a 40-character commit SHA, with the
 *       human-readable version in a trailing comment.
 *   P4  Dependency manifests are locked: the lockfile is committed, no
 *       manifest carries a floating specifier, and node installs run with
 *       lifecycle scripts disabled unless the repo opts back in with a
 *       committed reason.
 *   P7  A pin failure names itself - the file, the line, the reference and the
 *       clause - and a check that has quietly stopped looking is worse than no
 *       check, so an empty category is itself a failure.
 *
 * This module is built the way `packages/governor/src/no-direct-http.ts` is
 * built, because that pair already solved the two problems a repository-wide
 * check has: a PURE function over `{ path, text }` records, so that an
 * offending sample is graded by exactly the same code as the repository is,
 * and offending samples parked under a `.fixture` extension, so the real scan
 * cannot read them as tree content. `test/unit/pinning.test.ts` proves this
 * check can FAIL against six committed shapes before it believes that it
 * passes.
 *
 * WHAT IT READS, and what it therefore cannot see, said here rather than left
 * to be discovered:
 *
 *   - It reads committed text. It opens no connection, spawns no daemon and
 *     asks no registry whether a digest still exists, so it reaches the same
 *     verdict on a machine with no network as on one with. Rot is discovered
 *     when a build fails, which is P8's deliberate choice.
 *   - An image reference is recognised in four positions: a compose `image:`
 *     key, a `FROM` line, a binding whose NAME says it holds an image, and a
 *     literal argument on a line that runs `docker run`. A fifth rule reads
 *     the names in `KNOWN_IMAGE_NAMES` wherever they are written, comments
 *     included, which is what catches an unpinned reference sitting in a
 *     script's own documentation block.
 *   - It is a text scan, so a reference ASSEMBLED at run time - concatenated
 *     from fragments, read out of a file - is outside its reach. What it does
 *     prove is that no ordinary spelling of an unpinned reference survives
 *     review, and that a category it used to examine cannot silently become
 *     empty.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** A file handed to the scan: repository-relative path, forward slashes. */
export type ScannedFile = {
  path: string;
  text: string;
};

/**
 * The kinds of thing this check examines. A category is the unit AC-10 talks
 * about: if one of them stops producing references, the check has stopped
 * looking and says so.
 */
export type PinningCategory =
  | "compose-image"
  | "dockerfile-from"
  | "workflow-uses"
  | "script-image"
  | "source-image"
  | "node-manifest"
  | "lockfile"
  | "lifecycle-scripts";

export const PINNING_CATEGORIES: readonly PinningCategory[] = [
  "compose-image",
  "dockerfile-from",
  "workflow-uses",
  "script-image",
  "source-image",
  "node-manifest",
  "lockfile",
  "lifecycle-scripts",
];

/**
 * The two categories with no referent in this repository at the pin this check
 * was written against. They are ASSERTED ABSENT by name rather than counted as
 * scanned: "there is no Dockerfile here" is a fact the check re-establishes
 * every run, and the rule that would apply to one is proved against a
 * committed sample instead. A repository that grows either is scanned like any
 * other, and the assertion in the test is the reviewable diff that says so.
 */
export const EXPECTED_ABSENT_CATEGORIES: readonly PinningCategory[] = [
  "dockerfile-from",
  "workflow-uses",
];

/**
 * The image names this repository actually resolves, read wherever they are
 * written - in a compose key, in a shell assignment, in a source constant, and
 * in a comment. A documentation block that still promises a floating tag is a
 * promise somebody will keep, so it is a finding here.
 *
 * A name that appears nowhere is ALSO a finding: either it is no longer used
 * and belongs off this list, or the scan stopped reaching the file it lives in.
 */
export const KNOWN_IMAGE_NAMES: readonly string[] = ["postgres"];

export type PinningFinding = {
  /** Repository-relative, forward slashes. Empty for a tree-level finding. */
  path: string;
  /** One-based. Zero when the finding is about a file, or about the tree. */
  line: number;
  /** The clause of `documentation/pinning-conventions.md` this breaks. */
  clause: "P1" | "P2" | "P3" | "P4" | "P7";
  rule: string;
  /** The offending text, verbatim. */
  reference: string;
  message: string;
};

export type PinningCategoryReport = {
  category: PinningCategory;
  filesScanned: number;
  referencesFound: number;
  /** True when the category is legitimately empty and is asserted so by name. */
  assertedAbsent: boolean;
};

export type PinningReport = {
  findings: PinningFinding[];
  categories: PinningCategoryReport[];
};

/* ------------------------------------------------------------------ *
 * Which file is which
 * ------------------------------------------------------------------ */

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash"]);

/** `compose.yml`, `docker-compose.yml`, `docker-compose.override.yaml`, ... */
const COMPOSE_BASENAME = /^(?:docker-)?compose(?:\.[A-Za-z0-9_.-]+)?\.ya?ml$/;
const CONTAINER_BUILD_BASENAME = /^Dockerfile(?:\..+)?$|^.+\.Dockerfile$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export function isComposeFile(filePath: string): boolean {
  return COMPOSE_BASENAME.test(path.basename(filePath));
}

export function isContainerBuildFile(filePath: string): boolean {
  return CONTAINER_BUILD_BASENAME.test(path.basename(filePath));
}

export function isWorkflowFile(filePath: string): boolean {
  return WORKFLOW_PATH.test(filePath);
}

function isShellFile(filePath: string): boolean {
  return SHELL_EXTENSIONS.has(path.extname(filePath));
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function isManifestFile(filePath: string): boolean {
  return path.basename(filePath) === "package.json";
}

function isLockfile(filePath: string): boolean {
  return path.basename(filePath) === "pnpm-lock.yaml";
}

function isWorkspaceConfig(filePath: string): boolean {
  return path.basename(filePath) === "pnpm-workspace.yaml";
}

function isNpmConfig(filePath: string): boolean {
  return path.basename(filePath) === ".npmrc";
}

function isIgnoreFile(filePath: string): boolean {
  return path.basename(filePath) === ".gitignore";
}

/** Every category a file belongs to. A file with none is not read at all. */
export function categoriesOf(filePath: string): PinningCategory[] {
  if (isWorkflowFile(filePath)) return ["workflow-uses"];
  if (isContainerBuildFile(filePath)) return ["dockerfile-from"];
  if (isComposeFile(filePath)) return ["compose-image"];
  if (isShellFile(filePath)) return ["script-image"];
  if (isSourceFile(filePath)) return ["source-image"];
  if (isManifestFile(filePath)) return ["node-manifest"];
  if (isLockfile(filePath)) return ["lockfile"];
  if (isWorkspaceConfig(filePath) || isNpmConfig(filePath)) {
    return ["lifecycle-scripts"];
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * P1: is this reference pinned?
 * ------------------------------------------------------------------ */

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const READABLE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type PinVerdict = { pinned: true } | { pinned: false; reason: string };

/**
 * P1, applied to one reference. A reference is pinned when it carries BOTH a
 * human-readable tag and a `sha256:` digest of 64 lowercase hexadecimal
 * characters. `registry:5000/name:tag@sha256:...` is handled: the tag is the
 * last colon AFTER the last slash, so a registry port is not read as one.
 */
export function describeImagePin(reference: string): PinVerdict {
  const at = reference.indexOf("@");
  if (at === -1) {
    return { pinned: false, reason: "carries no @sha256: digest" };
  }
  const named = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  if (!DIGEST.test(digest)) {
    return {
      pinned: false,
      reason:
        "carries a digest that is not sha256: followed by 64 lowercase " +
        "hexadecimal characters",
    };
  }
  const lastColon = named.lastIndexOf(":");
  const lastSlash = named.lastIndexOf("/");
  if (lastColon <= lastSlash) {
    return {
      pinned: false,
      reason: "names a digest with no human-readable tag beside it",
    };
  }
  const tag = named.slice(lastColon + 1);
  if (!READABLE_TAG.test(tag)) {
    return { pinned: false, reason: `carries the unreadable tag "${tag}"` };
  }
  return { pinned: true };
}

/**
 * Whether a token is shaped like an image reference at all. Deliberately
 * narrow, and only ever applied to tokens already in an image POSITION: it
 * anchors the whole token, so a libpq URL, a host-and-port and a shell
 * expansion are all excluded rather than reported.
 */
const IMAGE_SHAPED =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[0-9]+)?(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?(?:@sha256:[0-9a-f]{64})?$/;

/**
 * A candidate is a token that both looks like a reference and carries a tag or
 * a digest. Requiring one of those is what keeps a bare word - `true`, a
 * program name, a flag's value - from being read as an unpinned image.
 */
function isImageCandidate(token: string): boolean {
  if (token === "") return false;
  if (!token.includes(":")) return false;
  return IMAGE_SHAPED.test(token);
}

/* ------------------------------------------------------------------ *
 * Reading values out of lines
 * ------------------------------------------------------------------ */

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Every quoted literal on a line, quotes removed, in the order written. */
function stringLiterals(line: string): string[] {
  const found: string[] = [];
  const pattern = /"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`/g;
  let match = pattern.exec(line);
  while (match !== null) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = pattern.exec(line);
  }
  return found;
}

/**
 * The default inside a shell parameter expansion: `${NAME:-default}` and
 * `${NAME-default}` both yield `default`. This is where a script's pin
 * actually lives, so it is read rather than skipped over as an expansion.
 */
function expansionDefaults(line: string): string[] {
  const found: string[] = [];
  const pattern = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g;
  let match = pattern.exec(line);
  while (match !== null) {
    found.push(match[1]);
    match = pattern.exec(line);
  }
  return found;
}

/** Bare (unquoted, unexpanded) whitespace-separated words on a line. */
function bareWords(line: string): string[] {
  return line
    .replace(/"[^"\n]*"/g, " ")
    .replace(/'[^'\n]*'/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

const IMAGE_BINDING_NAME = /image/i;

const SHELL_BINDING =
  /^\s*(?:export\s+|local\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const SOURCE_BINDING =
  /(?:^|[^A-Za-z0-9_$])(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]*)?=\s*(.*)$/;

const P1_ADVICE =
  "pinning-conventions P1 - a container image is pinned by tag AND digest. " +
  "Write name:tag@sha256:<64 hex>, so the tag stays readable and the digest " +
  "is what resolves.";

function imageFinding(
  file: ScannedFile,
  line: number,
  rule: string,
  clause: "P1" | "P2",
  reference: string,
  reason: string,
): PinningFinding {
  return {
    path: file.path,
    line,
    clause,
    rule,
    reference,
    message: `${reference} ${reason}. ${P1_ADVICE}`,
  };
}

type RuleOutcome = { findings: PinningFinding[]; referencesFound: number };

function empty(): RuleOutcome {
  return { findings: [], referencesFound: 0 };
}

/** P1, in a compose `image:` key. */
function scanComposeImages(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  file.text.split("\n").forEach((line, index) => {
    const match = /^\s*(?:-\s*)?image:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (match === null) return;
    const reference = stripQuotes(match[1]);
    if (reference === "") return;
    outcome.referencesFound += 1;
    if (reference.includes("${")) {
      outcome.findings.push(
        imageFinding(
          file,
          index + 1,
          "compose-image-pin",
          "P1",
          reference,
          "is built from a variable, so nothing committed here names what resolves",
        ),
      );
      return;
    }
    const verdict = describeImagePin(reference);
    if (!verdict.pinned) {
      outcome.findings.push(
        imageFinding(file, index + 1, "compose-image-pin", "P1", reference, verdict.reason),
      );
    }
  });
  return outcome;
}

/** P2, in a `FROM` line. A stage name and `scratch` are not references. */
function scanBaseImages(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  const stages = new Set<string>();
  file.text.split("\n").forEach((line, index) => {
    const match = /^\s*FROM\s+(.+?)\s*$/i.exec(line);
    if (match === null) return;
    const words = match[1].split(/\s+/).filter((word) => word !== "");
    const reference = words.find((word) => !word.startsWith("--"));
    if (reference === undefined) return;
    const asIndex = words.findIndex((word) => word.toLowerCase() === "as");
    if (asIndex !== -1 && words[asIndex + 1] !== undefined) {
      stages.add(words[asIndex + 1].toLowerCase());
    }
    if (reference.toLowerCase() === "scratch") return;
    if (stages.has(reference.toLowerCase())) return;
    outcome.referencesFound += 1;
    const verdict = describeImagePin(reference);
    if (!verdict.pinned) {
      outcome.findings.push(
        imageFinding(file, index + 1, "base-image-pin", "P2", reference, verdict.reason),
      );
    }
  });
  return outcome;
}

const P3_ADVICE =
  "pinning-conventions P3 - an action is pinned to a 40-character commit SHA " +
  "with the human-readable version in a trailing comment. A tag is mutable " +
  "and is moved by its publisher, which is a supply-chain path into every " +
  "build.";

/** P3, in a workflow `uses:` line. */
function scanActionUses(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  file.text.split("\n").forEach((line, index) => {
    const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(?:#\s*(.*?))?\s*$/.exec(line);
    if (match === null) return;
    const reference = stripQuotes(match[1]);
    const comment = (match[2] ?? "").trim();
    if (reference.startsWith("./") || reference.startsWith("../")) return;
    outcome.referencesFound += 1;

    if (reference.startsWith("docker://")) {
      const verdict = describeImagePin(reference.slice("docker://".length));
      if (!verdict.pinned) {
        outcome.findings.push(
          imageFinding(file, index + 1, "action-image-pin", "P1", reference, verdict.reason),
        );
      }
      return;
    }

    const at = reference.lastIndexOf("@");
    const pinned = at !== -1 && /^[0-9a-f]{40}$/.test(reference.slice(at + 1));
    if (!pinned) {
      outcome.findings.push({
        path: file.path,
        line: index + 1,
        clause: "P3",
        rule: "action-sha-pin",
        reference,
        message: `${reference} names a mutable reference rather than a commit SHA. ${P3_ADVICE}`,
      });
      return;
    }
    if (comment === "") {
      outcome.findings.push({
        path: file.path,
        line: index + 1,
        clause: "P3",
        rule: "action-version-comment",
        reference,
        message:
          `${reference} is pinned to a commit SHA with no version comment, so ` +
          `nobody can read which release it is. ${P3_ADVICE}`,
      });
    }
  });
  return outcome;
}

/**
 * P1, at a binding whose NAME says it holds an image. This is where every pin
 * in this repository's scripts and harness actually lives: neither the backup
 * script nor the container harness hands a literal to `docker run`, both hand
 * it the binding, so the binding is the position that resolves.
 */
function scanImageBindings(file: ScannedFile, shell: boolean): RuleOutcome {
  const outcome = empty();
  file.text.split("\n").forEach((line, index) => {
    const match = shell ? SHELL_BINDING.exec(line) : SOURCE_BINDING.exec(line);
    if (match === null) return;
    if (!IMAGE_BINDING_NAME.test(match[1])) return;
    const value = match[2];
    const candidates = [
      ...expansionDefaults(value),
      ...stringLiterals(value),
      ...(shell ? bareWords(value.replace(/\$\{[^}]*\}/g, " ")) : []),
    ].map(stripQuotes);
    for (const candidate of candidates) {
      if (!isImageCandidate(candidate)) continue;
      outcome.referencesFound += 1;
      const verdict = describeImagePin(candidate);
      if (!verdict.pinned) {
        outcome.findings.push(
          imageFinding(file, index + 1, "image-binding-pin", "P1", candidate, verdict.reason),
        );
      }
    }
  });
  return outcome;
}

/**
 * P1, at a literal argument on a line that runs a container. A shell
 * continuation is followed, so `docker run \` spread over ten lines is one
 * invocation, and the finding is reported on the physical line the reference
 * sits on rather than on the line the command started.
 *
 * A reference handed through a variable is NOT reported here, on purpose: it
 * has no literal to grade, and the binding rule above already graded the one
 * it came from.
 */
function scanContainerRuns(file: ScannedFile, shell: boolean): RuleOutcome {
  const outcome = empty();
  const lines = file.text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    let last = index;
    if (shell) {
      while (last < lines.length - 1 && /\\\s*$/.test(lines[last])) last += 1;
    }
    const joined = lines.slice(index, last + 1).join(" ");
    if (!/\bdocker\b[^\n]*\brun\b/.test(joined) && !/\bpodman\b[^\n]*\brun\b/.test(joined)) {
      index = last;
      continue;
    }
    for (let physical = index; physical <= last; physical += 1) {
      const line = lines[physical];
      const candidates = [
        ...stringLiterals(line),
        ...bareWords(line.replace(/\$\{[^}]*\}/g, " ")),
      ].map(stripQuotes);
      for (const candidate of candidates) {
        if (!isImageCandidate(candidate)) continue;
        outcome.referencesFound += 1;
        const verdict = describeImagePin(candidate);
        if (!verdict.pinned) {
          outcome.findings.push(
            imageFinding(
              file,
              physical + 1,
              "container-run-image-pin",
              "P1",
              candidate,
              verdict.reason,
            ),
          );
        }
      }
    }
    index = last;
  }
  return outcome;
}

/**
 * P1, by NAME, wherever the name is written - including in a comment. A
 * documentation block that still promises a floating tag is a promise somebody
 * keeps, and it is the shape a check anchored only on code positions walks
 * straight past.
 */
function scanKnownImageNames(file: ScannedFile): {
  outcome: RuleOutcome;
  seen: Set<string>;
} {
  const outcome = empty();
  const seen = new Set<string>();
  const lines = file.text.split("\n");
  for (const name of KNOWN_IMAGE_NAMES) {
    const pattern = new RegExp(
      "(?<![A-Za-z0-9._-])" +
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        ":([A-Za-z0-9_][A-Za-z0-9._-]*)(@sha256:[0-9a-f]{64})?",
      "g",
    );
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      let match = pattern.exec(line);
      while (match !== null) {
        seen.add(name);
        outcome.referencesFound += 1;
        if (match[2] === undefined) {
          outcome.findings.push(
            imageFinding(
              file,
              index + 1,
              "known-image-pin",
              "P1",
              `${name}:${match[1]}`,
              "carries no @sha256: digest",
            ),
          );
        }
        match = pattern.exec(line);
      }
    });
  }
  return { outcome, seen };
}

/* ------------------------------------------------------------------ *
 * P4: manifests, the lockfile, and lifecycle scripts
 * ------------------------------------------------------------------ */

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const WORKSPACE_SCOPE = "@deal-sentinel/";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const P4_ADVICE =
  "pinning-conventions P4 - a dependency manifest is locked: no floating " +
  "specifier, and the lockfile committed beside it.";

/**
 * P4, over a node manifest.
 *
 * A cross-workspace `"*"` is NOT an unbounded range: `pnpm-workspace.yaml`
 * sets `linkWorkspacePackages: true` and the lockfile records every
 * `@deal-sentinel/*` specifier resolving to a directory in this repository, so
 * that specifier never reaches a registry. It stays `"*"` so npm and pnpm both
 * read it. Any OTHER name carrying `*` is a registry range and is refused.
 */
function scanManifest(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (error) {
    outcome.findings.push({
      path: file.path,
      line: 0,
      clause: "P4",
      rule: "manifest-unreadable",
      reference: file.path,
      message:
        `is not readable as JSON (${error instanceof Error ? error.message : String(error)}), ` +
        `so its dependency specifiers cannot be graded at all. ${P4_ADVICE}`,
    });
    return outcome;
  }
  if (typeof parsed !== "object" || parsed === null) return outcome;
  const manifest = parsed as Record<string, unknown>;
  const lines = file.text.split("\n");

  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (typeof block !== "object" || block === null) continue;
    for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
      outcome.referencesFound += 1;
      if (typeof specifier !== "string") continue;
      const line = lines.findIndex((text) => text.includes(`"${name}"`)) + 1;
      if (name.startsWith(WORKSPACE_SCOPE)) {
        if (specifier === "*" || specifier.startsWith("workspace:") || EXACT_VERSION.test(specifier)) {
          continue;
        }
        outcome.findings.push({
          path: file.path,
          line,
          clause: "P4",
          rule: "manifest-dependency-pin",
          reference: `${name}@${specifier}`,
          message:
            `${name} is a package in this workspace and its specifier "${specifier}" is ` +
            `neither "*" nor an exact version. ${P4_ADVICE}`,
        });
        continue;
      }
      if (EXACT_VERSION.test(specifier)) continue;
      const why =
        specifier === "latest"
          ? 'resolves to "latest", which is a different package tomorrow'
          : specifier === "*" || specifier === ""
            ? "is an unbounded range on a registry package"
            : `is the range "${specifier}" rather than an exact MAJOR.MINOR.PATCH version`;
      outcome.findings.push({
        path: file.path,
        line,
        clause: "P4",
        rule: "manifest-dependency-pin",
        reference: `${name}@${specifier}`,
        message: `${name} ${why}. ${P4_ADVICE}`,
      });
    }
  }
  return outcome;
}

/** Does a `.gitignore` pattern exclude this path? */
function ignorePatternMatches(pattern: string, target: string): boolean {
  const cleaned = pattern.replace(/\/+$/, "");
  if (cleaned === "") return false;
  const anchored = cleaned.startsWith("/");
  const body = anchored ? cleaned.slice(1) : cleaned;
  const expression = body
    .split("")
    .map((character) => {
      if (character === "*") return "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${expression}$`);
  if (regex.test(target)) return true;
  if (!anchored && !body.includes("/")) return regex.test(path.basename(target));
  return false;
}

export function gitignoreExcludes(gitignoreText: string, target: string): boolean {
  let excluded = false;
  for (const raw of gitignoreText.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (ignorePatternMatches(pattern, target)) excluded = !negated;
  }
  return excluded;
}

const OPT_IN_REASON = "pinning-conventions P4 opt-in:";

/**
 * Is the reason for turning lifecycle scripts back on written beside the line
 * that turns them on? "Beside" means the trailing comment on that line, or the
 * unbroken block of comment lines immediately above it - a reason worth
 * writing rarely fits on one line, and one that has drifted to the far end of
 * the file is not a reason a reviewer of THIS line ever sees.
 */
function hasOptInComment(lines: readonly string[], lineIndex: number): boolean {
  const here = lines[lineIndex] ?? "";
  const hash = here.indexOf("#");
  if (hash !== -1 && here.slice(hash + 1).trim().startsWith(OPT_IN_REASON)) return true;
  for (let above = lineIndex - 1; above >= 0; above -= 1) {
    const text = (lines[above] ?? "").trim();
    if (text === "") continue;
    if (!text.startsWith("#")) return false;
    if (text.slice(1).trim().startsWith(OPT_IN_REASON)) return true;
  }
  return false;
}

function hasOptInAnywhere(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const hash = line.indexOf("#");
    return hash !== -1 && line.slice(hash + 1).trim().startsWith(OPT_IN_REASON);
  });
}

const LIFECYCLE_ADVICE =
  "pinning-conventions P4 - node installs run with lifecycle scripts " +
  "DISABLED unless the repo opts back in with a committed reason. Restore the " +
  `setting, or put a comment beginning "${OPT_IN_REASON}" on the line above it ` +
  "saying which dependency needs a native build and why.";

/** P4, over `pnpm-workspace.yaml`: `ignoreScripts` stays true. */
function scanWorkspaceLifecycle(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  const lines = file.text.split("\n");
  const index = lines.findIndex((line) => /^\s*ignoreScripts\s*:/.test(line));
  if (index === -1) {
    if (hasOptInAnywhere(lines)) return outcome;
    outcome.findings.push({
      path: file.path,
      line: 0,
      clause: "P4",
      rule: "lifecycle-scripts-off",
      reference: "ignoreScripts",
      message: `sets no ignoreScripts at all, so lifecycle scripts run. ${LIFECYCLE_ADVICE}`,
    });
    return outcome;
  }
  outcome.referencesFound += 1;
  const value = (/^\s*ignoreScripts\s*:\s*([^\s#]*)/.exec(lines[index])?.[1] ?? "").toLowerCase();
  if (value === "true") return outcome;
  if (hasOptInComment(lines, index)) return outcome;
  outcome.findings.push({
    path: file.path,
    line: index + 1,
    clause: "P4",
    rule: "lifecycle-scripts-off",
    reference: `ignoreScripts: ${value}`,
    message: `enables lifecycle scripts with no committed reason. ${LIFECYCLE_ADVICE}`,
  });
  return outcome;
}

/** P4, over an `.npmrc`: it says `ignore-scripts=true`, or it says why not. */
function scanNpmConfigLifecycle(file: ScannedFile): RuleOutcome {
  const outcome = empty();
  const lines = file.text.split("\n");
  const index = lines.findIndex((line) => /^\s*ignore-scripts\s*=/.test(line));
  if (index === -1) {
    if (hasOptInAnywhere(lines)) return outcome;
    outcome.findings.push({
      path: file.path,
      line: 0,
      clause: "P4",
      rule: "lifecycle-scripts-off",
      reference: "ignore-scripts",
      message:
        "exists and sets ignore-scripts nowhere at all, so it re-enables " +
        `lifecycle scripts for everything below it. ${LIFECYCLE_ADVICE}`,
    });
    return outcome;
  }
  outcome.referencesFound += 1;
  const value = (/^\s*ignore-scripts\s*=\s*([^\s#]*)/.exec(lines[index])?.[1] ?? "").toLowerCase();
  if (value === "true") return outcome;
  if (hasOptInComment(lines, index)) return outcome;
  outcome.findings.push({
    path: file.path,
    line: index + 1,
    clause: "P4",
    rule: "lifecycle-scripts-off",
    reference: `ignore-scripts=${value}`,
    message: `enables lifecycle scripts with no committed reason. ${LIFECYCLE_ADVICE}`,
  });
  return outcome;
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

export type ScanOptions = {
  /**
   * The lockfile the tree is expected to carry. Present so a fixture set can
   * be graded without the repository's own lockfile being in it.
   */
  lockfileName?: string;
  /**
   * Whether to assert the facts that are only true of a WHOLE tree: that the
   * lockfile is committed at all, and that every name on `KNOWN_IMAGE_NAMES`
   * was found somewhere. Off by default, so that a handful of offending
   * samples can be graded by the same rules without being asked to be a
   * repository.
   */
  treeLevel?: boolean;
};

/**
 * Report every unpinned reference in `files`, and how much of each category
 * was actually examined. Pure: it takes text, so an offending sample is graded
 * by exactly the same code as the repository is.
 */
export function scanPinning(
  files: readonly ScannedFile[],
  options: ScanOptions = {},
): PinningReport {
  const lockfileName = options.lockfileName ?? "pnpm-lock.yaml";
  const treeLevel = options.treeLevel ?? false;
  const findings: PinningFinding[] = [];
  const counts = new Map<PinningCategory, { files: number; references: number }>();
  for (const category of PINNING_CATEGORIES) counts.set(category, { files: 0, references: 0 });

  const seenImageNames = new Set<string>();
  let ignoreText: string | undefined;
  let lockfileSeen = false;

  for (const file of files) {
    if (isIgnoreFile(file.path)) ignoreText = file.text;
    const categories = categoriesOf(file.path);
    if (categories.length === 0) continue;
    const category = categories[0];
    const tally = counts.get(category);
    if (tally === undefined) continue;
    tally.files += 1;

    const outcomes: RuleOutcome[] = [];

    if (category === "compose-image") outcomes.push(scanComposeImages(file));
    if (category === "dockerfile-from") outcomes.push(scanBaseImages(file));
    if (category === "workflow-uses") outcomes.push(scanActionUses(file));
    if (category === "script-image") {
      outcomes.push(scanImageBindings(file, true), scanContainerRuns(file, true));
    }
    if (category === "source-image") {
      outcomes.push(scanImageBindings(file, false), scanContainerRuns(file, false));
    }
    if (category === "node-manifest") outcomes.push(scanManifest(file));
    if (category === "lifecycle-scripts") {
      outcomes.push(
        isWorkspaceConfig(file.path)
          ? scanWorkspaceLifecycle(file)
          : scanNpmConfigLifecycle(file),
      );
    }
    if (category === "lockfile") {
      lockfileSeen = lockfileSeen || path.basename(file.path) === lockfileName;
      tally.references += 1;
    }

    if (category !== "node-manifest" && category !== "lockfile" && category !== "lifecycle-scripts") {
      const named = scanKnownImageNames(file);
      outcomes.push(named.outcome);
      for (const name of named.seen) seenImageNames.add(name);
    }

    for (const outcome of outcomes) {
      findings.push(...outcome.findings);
      tally.references += outcome.referencesFound;
    }
  }

  if (treeLevel && !lockfileSeen) {
    findings.push({
      path: "",
      line: 0,
      clause: "P4",
      rule: "lockfile-committed",
      reference: lockfileName,
      message: `is not committed, so nothing fixes what an install resolves. ${P4_ADVICE}`,
    });
  }
  if (ignoreText !== undefined && gitignoreExcludes(ignoreText, lockfileName)) {
    findings.push({
      path: ".gitignore",
      line: 0,
      clause: "P4",
      rule: "lockfile-committed",
      reference: lockfileName,
      message: `is excluded by .gitignore, so it cannot stay committed. ${P4_ADVICE}`,
    });
  }

  if (treeLevel) {
    for (const name of KNOWN_IMAGE_NAMES) {
      if (seenImageNames.has(name)) continue;
      findings.push({
        path: "",
        line: 0,
        clause: "P7",
        rule: "known-image-unseen",
        reference: name,
        message:
          "is on KNOWN_IMAGE_NAMES and was found nowhere in the files scanned. " +
          "Either this repository no longer resolves it, and it belongs off that " +
          "list, or the scan has stopped reaching the file it lives in - and a " +
          "check that has quietly stopped looking is worse than no check (P7).",
      });
    }
  }

  const categories: PinningCategoryReport[] = PINNING_CATEGORIES.map((category) => {
    const tally = counts.get(category)!;
    return {
      category,
      filesScanned: tally.files,
      referencesFound: tally.references,
      assertedAbsent: EXPECTED_ABSENT_CATEGORIES.includes(category) && tally.files === 0,
    };
  });

  return { findings, categories };
}

/**
 * P7, over the report: a category that produced nothing, and that is not one
 * of the two asserted absent by name, is a check that has stopped looking.
 */
export function findEmptyCategories(
  categories: readonly PinningCategoryReport[],
): PinningFinding[] {
  return categories
    .filter((report) => !report.assertedAbsent && report.referencesFound === 0)
    .map((report) => ({
      path: "",
      line: 0,
      clause: "P7" as const,
      rule: "empty-category",
      reference: report.category,
      message:
        `was examined and produced no reference at all (${report.filesScanned} ` +
        "file(s) read). Either a file moved, or a pattern stopped matching: a " +
        "check that has quietly stopped looking must never be mistaken for a " +
        "compliant tree (P7).",
    }));
}

/** The findings as the message a failing check should carry (P7). */
export function describePinningFindings(findings: readonly PinningFinding[]): string {
  if (findings.length === 0) return "every reference is pinned";
  const lines = findings.map((finding) => {
    const where = finding.path === "" ? "(tree)" : `${finding.path}:${finding.line}`;
    return `  ${where} [${finding.clause} ${finding.rule}] ${finding.message}`;
  });
  return (
    `${findings.length} unpinned reference(s). A floating reference is a ` +
    "different artifact every time it resolves, which is a change nobody " +
    "reviewed reaching a machine somebody trusts:\n" +
    lines.join("\n")
  );
}

/* ------------------------------------------------------------------ *
 * Reading the tree
 * ------------------------------------------------------------------ */

/** Other people's code, and things git does not track. Never scanned. */
const SKIPPED_ANYWHERE = new Set(["node_modules", ".git"]);

/**
 * Build output and data, and only where they land: the repository root. A
 * directory named `build` inside a package's `src` is hand-written source.
 * `backups/` and `backups-test-*` are what the two database scripts write, and
 * `.gitignore` already excludes them.
 */
const SKIPPED_AT_ROOT = new Set(["dist", "build", "coverage", "backups"]);

/**
 * Every file in the tree this check has an opinion about, repository-relative.
 * The offending samples under `test/fixtures/pinning/` carry a `.fixture`
 * extension and are deliberately NOT read here: they are handed to
 * `scanPinning` under a synthetic path by the test instead, which is how the
 * repository already parks samples its own scans must not read.
 */
export function collectPinningFiles(rootDir: string): ScannedFile[] {
  const files: ScannedFile[] = [];

  const walk = (directory: string, atRoot: boolean): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIPPED_ANYWHERE.has(entry)) continue;
      if (atRoot && SKIPPED_AT_ROOT.has(entry)) continue;
      if (atRoot && entry.startsWith("backups-test-")) continue;
      const absolute = path.join(directory, entry);
      const stats = statSync(absolute);
      const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
      if (stats.isDirectory()) {
        walk(absolute, false);
        continue;
      }
      if (path.extname(entry) === ".fixture") continue;
      if (categoriesOf(relative).length === 0 && !isIgnoreFile(relative)) continue;
      files.push({ path: relative, text: readFileSync(absolute, "utf8") });
    }
  };

  walk(rootDir, true);
  return files;
}

/**
 * The whole check over a real tree: every rule, plus P7's refusal to accept a
 * category that produced nothing. Reads committed text and opens no
 * connection, so it reaches the same verdict with a network and without one.
 */
export function checkRepositoryPinning(rootDir: string): PinningReport {
  const report = scanPinning(collectPinningFiles(rootDir), { treeLevel: true });
  return {
    findings: [...report.findings, ...findEmptyCategories(report.categories)],
    categories: report.categories,
  };
}

/* ------------------------------------------------------------------ *
 * The runtime refusal
 * ------------------------------------------------------------------ */

/**
 * The distinct status a digestless override exits with. Both database scripts
 * already exit 2 for a usage error, so 3 says "the pin was refused" and
 * nothing else - which is what P7 asks a pin failure to do.
 */
export const UNPINNED_IMAGE_EXIT_CODE = 3;

export class UnpinnedImageError extends Error {
  readonly exitCode = UNPINNED_IMAGE_EXIT_CODE;
  readonly variable: string;
  readonly reference: string;

  constructor(variable: string, reference: string, reason: string) {
    super(
      `${variable} supplied "${reference}", which ${reason}. ` +
        "pinning-conventions P1 - a container image is pinned by tag AND " +
        "digest - so this refuses before contacting docker rather than " +
        "starting an image whose contents nobody has named. Supply the " +
        "digest, as in name:tag@sha256:<64 hex>; " +
        "docs/decisions/0005-container-image-pinning.md says how to resolve one.",
    );
    this.name = "UnpinnedImageError";
    this.variable = variable;
    this.reference = reference;
  }
}

/**
 * Return `reference` if P1 is satisfied, and throw naming the variable, the
 * reference and the clause if it is not. It throws rather than exiting: this
 * runs inside a test process, where an exit would take the whole run with it,
 * and the error carries the status a command-line caller should use.
 */
export function requirePinnedImage(reference: string, variable: string): string {
  const verdict = describeImagePin(reference);
  if (!verdict.pinned) {
    throw new UnpinnedImageError(variable, reference, verdict.reason);
  }
  return reference;
}
