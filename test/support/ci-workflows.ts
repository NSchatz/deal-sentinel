/**
 * The check that makes "the pull-request gate actually gates" a property of the
 * committed workflows rather than a habit.
 *
 * Spec S0062-deal-sentinel-ci-gate. Two check runs, `test` and `typecheck`, are
 * required contexts on this repository's default branch. A required context is
 * a strange thing to depend on: it blocks a merge only while it REPORTS, and
 * every ordinary way of making a workflow cheaper - a `paths:` filter, an `if:`,
 * a matrix, a `continue-on-error` - makes it report nothing or report under a
 * different name. A required context that reports nothing does not fail a pull
 * request, it freezes one, forever, and the symptom is a merge button that
 * never lights rather than a red tick anybody can read.
 *
 * So the properties the gate rests on are graded here, by the suite, on every
 * run. This module is built the way `pinning.ts` is built, for the same two
 * reasons: a PURE function over `{ path, text }` records, so a broken sample is
 * graded by exactly the same code the real workflows are, and every rule proved
 * against a mutation of a REAL committed workflow in
 * `test/unit/ci-workflows.test.ts` before the pass over the tree is believed.
 *
 * WHAT IT READS, and what it therefore cannot see:
 *
 *   - Committed YAML. It calls no GitHub API, so it cannot know whether a run
 *     happened, whether branch protection is really set, or whether a runner had
 *     a Docker daemon. Those are graded on real runs, recorded under
 *     `work/specs/S0062-deal-sentinel-ci-gate/probes/` in the umbrella.
 *   - It parses the SUBSET of YAML that GitHub workflow files are written in:
 *     block mappings, block and flow sequences, block scalars, quoted and plain
 *     scalars, comments. Anchors, aliases, tags, multi-document streams and
 *     flow mappings spanning lines are NOT supported, and a file using one is
 *     reported as unreadable rather than passed. Every scalar stays a string,
 *     deliberately: `on` is the key `"on"` here and not the boolean a YAML 1.1
 *     reader turns it into, which is the single most common way a workflow
 *     grader silently stops looking at triggers.
 *   - Workflow files are discovered by DIRECTORY SCAN, never by name, so a
 *     workflow added tomorrow is graded the moment it is committed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ScannedFile } from "./pinning.ts";

/* ------------------------------------------------------------------ *
 * A small, honest YAML reader
 * ------------------------------------------------------------------ */

export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode } | null;

export class WorkflowParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "WorkflowParseError";
    this.line = line;
  }
}

/**
 * Everything before an unquoted `#` that begins a comment. YAML wants a comment
 * hash to start the line or to follow whitespace, which is what keeps a SHA
 * fragment or a URL from being read as one.
 */
export function stripYamlComment(text: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === "#" && !single && !double) {
      if (index === 0 || /\s/.test(text[index - 1])) {
        return text.slice(0, index).replace(/\s+$/, "");
      }
    }
  }
  return text;
}

/**
 * `key: value`, `key:`, and the quoted forms of a key. A sequence item that does
 * NOT match this is a plain scalar - `- main`, `- packages/**` - rather than a
 * mapping opened on the dash line, and reading it as one is how a grader ends up
 * reporting "unparseable" over an ordinary branch list.
 */
const MAPPING_ENTRY = /^(?:"([^"]*)"|'([^']*)'|([^:]+?))\s*:(?:\s+(.*))?$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `[a, b]`, and nothing cleverer: a nested flow collection is refused. */
function parseFlowSequence(value: string, line: number): YamlNode[] {
  const body = value.slice(1, -1).trim();
  if (body === "") return [];
  if (/[[\]{}]/.test(body)) {
    throw new WorkflowParseError("a nested flow collection is not supported here", line);
  }
  return body.split(",").map((entry) => unquote(entry));
}

function parseFlowMapping(value: string, line: number): { [key: string]: YamlNode } {
  const body = value.slice(1, -1).trim();
  if (body === "") return {};
  if (/[[\]{}]/.test(body)) {
    throw new WorkflowParseError("a nested flow collection is not supported here", line);
  }
  const mapping: { [key: string]: YamlNode } = {};
  for (const entry of body.split(",")) {
    const at = entry.indexOf(":");
    if (at === -1) throw new WorkflowParseError("a flow mapping entry carries no colon", line);
    mapping[unquote(entry.slice(0, at))] = unquote(entry.slice(at + 1));
  }
  return mapping;
}

type Cursor = { indent: number; content: string; index: number };

class WorkflowReader {
  private readonly lines: string[];
  private at = 0;

  constructor(text: string) {
    this.lines = text.split("\n");
  }

  /** The next line carrying content, comments and blanks stepped over. */
  private peek(): Cursor | null {
    while (this.at < this.lines.length) {
      const stripped = stripYamlComment(this.lines[this.at]).replace(/\s+$/, "");
      if (stripped.trim() === "") {
        this.at += 1;
        continue;
      }
      if (stripped.trimStart().startsWith("---") || stripped.trimStart().startsWith("...")) {
        throw new WorkflowParseError("a multi-document stream is not supported here", this.at + 1);
      }
      return {
        indent: stripped.length - stripped.trimStart().length,
        content: stripped.trimStart(),
        index: this.at,
      };
    }
    return null;
  }

  parseDocument(): YamlNode {
    const first = this.peek();
    if (first === null) return null;
    const node = this.parseNode(first.indent);
    const trailing = this.peek();
    if (trailing !== null) {
      throw new WorkflowParseError("content sits outside the top-level mapping", trailing.index + 1);
    }
    return node;
  }

  private parseNode(indent: number): YamlNode {
    const line = this.peek();
    if (line === null || line.indent < indent) return null;
    if (line.content === "-" || line.content.startsWith("- ")) return this.parseSequence(indent);
    return this.parseMapping(indent);
  }

  private parseSequence(indent: number): YamlNode[] {
    const items: YamlNode[] = [];
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent !== indent) break;
      if (line.content !== "-" && !line.content.startsWith("- ")) break;

      const after = line.content.slice(1);
      const lead = after.length - after.trimStart().length;
      const body = after.trimStart();
      if (body === "") {
        this.at = line.index + 1;
        const nested = this.peek();
        items.push(nested !== null && nested.indent > indent ? this.parseNode(nested.indent) : null);
        continue;
      }
      if (!MAPPING_ENTRY.test(body)) {
        // A plain scalar item: `- main`, `- packages/**`.
        this.at = line.index + 1;
        items.push(unquote(body));
        continue;
      }
      // Re-present the item's content at the column it really begins in, so the
      // mapping reader below sees an ordinary block.
      const itemIndent = indent + 1 + lead;
      this.lines[line.index] = " ".repeat(itemIndent) + body;
      items.push(this.parseNode(itemIndent));
    }
    return items;
  }

  private parseMapping(indent: number): { [key: string]: YamlNode } {
    const mapping: { [key: string]: YamlNode } = {};
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) {
        throw new WorkflowParseError("this line is indented past the block it is in", line.index + 1);
      }
      if (line.content === "-" || line.content.startsWith("- ")) break;

      const match = MAPPING_ENTRY.exec(line.content);
      if (match === null) {
        throw new WorkflowParseError(`"${line.content}" is not a mapping entry`, line.index + 1);
      }
      const key = match[1] ?? match[2] ?? match[3];
      const rawValue = (match[4] ?? "").trim();
      this.at = line.index + 1;

      if (key in mapping) {
        throw new WorkflowParseError(`the key "${key}" appears twice in one mapping`, line.index + 1);
      }

      const block = /^([|>])[+-]?[0-9]*$/.exec(rawValue);
      if (block !== null) {
        mapping[key] = this.readBlockScalar(indent);
        continue;
      }
      if (rawValue === "") {
        const nested = this.peek();
        if (nested === null) {
          mapping[key] = null;
        } else if (nested.indent > indent) {
          mapping[key] = this.parseNode(nested.indent);
        } else if (
          nested.indent === indent &&
          (nested.content === "-" || nested.content.startsWith("- "))
        ) {
          // A sequence written at its parent's own indent, which YAML allows.
          mapping[key] = this.parseSequence(indent);
        } else {
          mapping[key] = null;
        }
        continue;
      }
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        mapping[key] = parseFlowSequence(rawValue, line.index + 1);
        continue;
      }
      if (rawValue.startsWith("{") && rawValue.endsWith("}")) {
        mapping[key] = parseFlowMapping(rawValue, line.index + 1);
        continue;
      }
      if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
        throw new WorkflowParseError("an unclosed flow collection", line.index + 1);
      }
      mapping[key] = unquote(rawValue);
    }
    return mapping;
  }

  /**
   * A `|` or `>` block, read VERBATIM. Comment stripping is deliberately not
   * applied: a `#` inside a shell script is a shell comment and part of what
   * runs, and a grader that removed it would be grading something the runner
   * never sees.
   */
  private readBlockScalar(parentIndent: number): string {
    const body: string[] = [];
    let scalarIndent = -1;
    while (this.at < this.lines.length) {
      const raw = this.lines[this.at];
      if (raw.trim() === "") {
        body.push("");
        this.at += 1;
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      if (indent <= parentIndent) break;
      if (scalarIndent === -1) scalarIndent = indent;
      body.push(raw.slice(Math.min(scalarIndent, indent)));
      this.at += 1;
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    return body.join("\n");
  }
}

export function parseWorkflowYaml(text: string): YamlNode {
  return new WorkflowReader(text).parseDocument();
}

/* ------------------------------------------------------------------ *
 * What a workflow has to be
 * ------------------------------------------------------------------ */

/**
 * The check-run names the default branch requires. A context on that list and
 * no job producing it is the freeze described at the top of this file, so the
 * scan refuses that rather than reporting a clean tree.
 */
export const REQUIRED_CONTEXTS: readonly string[] = ["test", "typecheck"];

/** The required context that runs the suite, and what it must invoke. */
export const FULL_TEST_CONTEXT = "test";
export const FULL_TEST_COMMAND = "pnpm run test";
export const SKIP_REFUSAL_PATH = "test/support/assert-no-skipped-tests.ts";

/** `NSchatz/deal-sentinel`'s default branch, which protection is set on. */
export const DEFAULT_BRANCH = "main";

export type CiClause =
  | "context"
  | "trigger"
  | "condition"
  | "install"
  | "skips"
  | "token"
  | "runtime";

/**
 * Every rule this module can report, named so that a rule which has quietly
 * stopped firing cannot be mistaken for a compliant tree. `ci-workflows.test.ts`
 * demonstrates each one RED against a mutation of a real committed workflow
 * before it believes the pass over the tree, and refuses to run if this list
 * and that table have drifted apart. Same reasoning as pinning-conventions P7.
 */
export const CI_RULES: readonly string[] = [
  "workflow-readable",
  "workflows-present",
  "required-context-produced",
  "pull-request-trigger",
  "push-trigger",
  "no-path-filter",
  "default-branch-covered",
  "pull-request-types",
  "no-job-condition",
  "no-matrix",
  "no-continue-on-error",
  "no-step-condition",
  "frozen-install",
  "no-lifecycle-scripts",
  "install-present",
  "full-test-target",
  "skip-refusal",
  "pipefail",
  "container-capable-runner",
  "no-secrets",
  "permissions-declared",
  "no-write-permission",
  "pinned-runner",
  "node-version-exact",
  "node-version-floor",
  "pnpm-version-exact",
];

export type CiFinding = {
  /** Repository-relative, forward slashes. Empty for a tree-level finding. */
  path: string;
  /** One-based. Zero when the finding is about a file, or about the tree. */
  line: number;
  clause: CiClause;
  rule: string;
  /** The offending text, verbatim. */
  reference: string;
  message: string;
};

export type CiScanOptions = {
  requiredContexts?: readonly string[];
  defaultBranch?: string;
  fullTestContext?: string;
  fullTestCommand?: string;
  skipRefusalPath?: string;
  /** An `engines.node` range out of `package.json`, e.g. `">=22.6.0"`. */
  nodeFloor?: string;
  /**
   * Whether to assert the facts only true of a WHOLE tree: that at least one
   * workflow was read, and that every required context is produced exactly
   * once. Off by default, so a single broken sample can be graded by the same
   * rules without being asked to be a repository.
   */
  treeLevel?: boolean;
};

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export function isWorkflowFile(filePath: string): boolean {
  return WORKFLOW_PATH.test(filePath);
}

function asMapping(node: YamlNode): { [key: string]: YamlNode } | null {
  return typeof node === "object" && node !== null && !Array.isArray(node) ? node : null;
}

function asList(node: YamlNode): string[] | null {
  if (Array.isArray(node)) return node.filter((entry): entry is string => typeof entry === "string");
  if (typeof node === "string") return [node];
  return null;
}

/** The check-run name a job produces: its `name`, or its id when it has none. */
export function contextNameOf(jobId: string, job: { [key: string]: YamlNode }): string {
  const name = job["name"];
  return typeof name === "string" && name.trim() !== "" ? name.trim() : jobId;
}

/** Every `run:` script in a job, in order. */
function runScripts(job: { [key: string]: YamlNode }): string[] {
  const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
  const scripts: string[] = [];
  for (const step of steps) {
    const mapping = asMapping(step);
    const script = mapping?.["run"];
    if (typeof script === "string") scripts.push(script);
  }
  return scripts;
}

function steps(job: { [key: string]: YamlNode }): { [key: string]: YamlNode }[] {
  const list = Array.isArray(job["steps"]) ? job["steps"] : [];
  return list.map(asMapping).filter((step): step is { [key: string]: YamlNode } => step !== null);
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

/** The floor out of an `engines.node` range, or null when it is not one. */
export function readNodeFloor(range: string): string | null {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match === null ? null : match[1];
}

const WHY_A_REQUIRED_CONTEXT_MUST_REPORT =
  "A required status check blocks a merge only while it REPORTS. One that is " +
  "filtered out, skipped, or renamed reports nothing, and a pull request " +
  "waiting on a context that reports nothing can never be merged by the " +
  "ordinary path - which looks like a merge button that never lights rather " +
  "than a red tick anybody can read.";

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

type Rule = (context: FileContext, finding: (f: Omit<CiFinding, "path">) => void) => void;

type FileContext = {
  file: ScannedFile;
  document: { [key: string]: YamlNode };
  jobs: [string, { [key: string]: YamlNode }][];
  /** Jobs in this file producing a context the default branch requires. */
  required: [string, { [key: string]: YamlNode }][];
  options: Required<Omit<CiScanOptions, "treeLevel" | "nodeFloor">> & {
    nodeFloor: string | undefined;
    treeLevel: boolean;
  };
  /** Comment-stripped lines, so a rule can name the line it fired on. */
  lines: string[];
};

function lineOf(context: FileContext, needle: RegExp): number {
  const index = context.lines.findIndex((line) => needle.test(line));
  return index + 1;
}

/** Triggers: the two events a required context must be scheduled by. */
const triggerRule: Rule = (context, finding) => {
  if (context.required.length === 0) return;
  const on = context.document["on"];
  const events = asMapping(on);
  const listed = events !== null ? Object.keys(events) : (asList(on) ?? []);

  for (const event of ["pull_request", "push"]) {
    if (!listed.includes(event)) {
      finding({
        line: lineOf(context, /^on\s*:/),
        clause: "trigger",
        rule: `${event.replace("_", "-")}-trigger`,
        reference: event,
        message:
          `produces a required check run and is not triggered by \`${event}\`. ` +
          (event === "push"
            ? "A branch whose state is only ever inherited from a pull request " +
              "that ran against an older base is a branch nobody has checked. "
            : "") +
          WHY_A_REQUIRED_CONTEXT_MUST_REPORT,
      });
      continue;
    }
    const filters = events === null ? null : asMapping(events[event]);
    if (filters === null) continue;

    for (const key of ["paths", "paths-ignore"]) {
      if (!(key in filters)) continue;
      finding({
        line: lineOf(context, new RegExp(`^\\s*${key}\\s*:`)),
        clause: "trigger",
        rule: "no-path-filter",
        reference: `${event}.${key}`,
        message:
          "filters a required check run by path. A pull request touching only " +
          "files this filter excludes - documentation, a fixture, a comment in " +
          `this very file - then gets no \`${event}\` run at all. ` +
          WHY_A_REQUIRED_CONTEXT_MUST_REPORT,
      });
    }

    const branches = asList(filters["branches"]);
    if (branches !== null && !branches.includes(context.options.defaultBranch)) {
      finding({
        line: lineOf(context, /^\s*branches\s*:/),
        clause: "trigger",
        rule: "default-branch-covered",
        reference: `${event}.branches: ${branches.join(", ")}`,
        message:
          `restricts \`${event}\` to branches that do not include ` +
          `\`${context.options.defaultBranch}\`, which is the branch these ` +
          `contexts are required on. ${WHY_A_REQUIRED_CONTEXT_MUST_REPORT}`,
      });
    }
    const ignored = asList(filters["branches-ignore"]);
    if (ignored !== null && ignored.includes(context.options.defaultBranch)) {
      finding({
        line: lineOf(context, /^\s*branches-ignore\s*:/),
        clause: "trigger",
        rule: "default-branch-covered",
        reference: `${event}.branches-ignore: ${ignored.join(", ")}`,
        message:
          `ignores \`${context.options.defaultBranch}\`, which is the branch ` +
          `these contexts are required on. ${WHY_A_REQUIRED_CONTEXT_MUST_REPORT}`,
      });
    }

    if (event === "pull_request") {
      const types = asList(filters["types"]);
      if (types !== null) {
        for (const wanted of ["opened", "synchronize"]) {
          if (types.includes(wanted)) continue;
          finding({
            line: lineOf(context, /^\s*types\s*:/),
            clause: "trigger",
            rule: "pull-request-types",
            reference: `pull_request.types: ${types.join(", ")}`,
            message:
              `narrows \`pull_request\` to types that leave out \`${wanted}\`, so a ` +
              "pull request that is opened, or whose head moves, gets no run. " +
              WHY_A_REQUIRED_CONTEXT_MUST_REPORT,
          });
        }
      }
    }
  }
};

/** Nothing may make a required job decline to report. */
const conditionRule: Rule = (context, finding) => {
  for (const [jobId, job] of context.required) {
    const name = contextNameOf(jobId, job);
    if ("if" in job && job["if"] !== null) {
      finding({
        line: lineOf(context, /^\s*if\s*:/),
        clause: "condition",
        rule: "no-job-condition",
        reference: `${jobId}.if: ${String(job["if"])}`,
        message:
          `guards the required check run \`${name}\` with a condition. A job ` +
          "whose condition is false is SKIPPED, and a skipped job's check run " +
          `never reaches a conclusion. ${WHY_A_REQUIRED_CONTEXT_MUST_REPORT}`,
      });
    }
    if ("strategy" in job && job["strategy"] !== null) {
      finding({
        line: lineOf(context, /^\s*strategy\s*:/),
        clause: "condition",
        rule: "no-matrix",
        reference: `${jobId}.strategy`,
        message:
          `runs the required check run \`${name}\` under a strategy. A matrix ` +
          `suffixes every check run with its parameters - \`${name} (24)\` - so ` +
          `no run named exactly \`${name}\` is ever reported. ` +
          WHY_A_REQUIRED_CONTEXT_MUST_REPORT,
      });
    }
    const holders: [string, { [key: string]: YamlNode }][] = [
      [jobId, job],
      ...steps(job).map(
        (step, index): [string, { [key: string]: YamlNode }] => [
          `${jobId}.steps[${index}]`,
          step,
        ],
      ),
    ];
    for (const [where, holder] of holders) {
      if (String(holder["continue-on-error"] ?? "") !== "true") continue;
      finding({
        line: lineOf(context, /^\s*continue-on-error\s*:/),
        clause: "condition",
        rule: "no-continue-on-error",
        reference: `${where}.continue-on-error`,
        message:
          `lets ${where} fail without failing the required check run \`${name}\`, ` +
          "so the context can conclude success over work that did not succeed. " +
          "A gate that reports green on a failure is worse than no gate.",
      });
      break;
    }
    for (const [where, step] of steps(job).entries()) {
      if (!("if" in step) || step["if"] === null) continue;
      finding({
        line: lineOf(context, /^\s*if\s*:/),
        clause: "condition",
        rule: "no-step-condition",
        reference: `${jobId}.steps[${where}].if: ${String(step["if"])}`,
        message:
          `conditions a step of the required check run \`${name}\`. Every step ` +
          "here is part of what the context claims to have proved, and a step " +
          "that quietly did not run is a claim nobody checked.",
      });
    }
  }
};

const INSTALL_COMMAND = /\b(?:pnpm(?:\s+\S+)*?\s+(?:install|i|add)|npm\s+(?:install|ci|i)|yarn(?:\s+install)?)\b/;
const LIFECYCLE_REENABLED =
  /(?:ignore[-_]scripts\s*[=:]\s*false|--no-ignore-scripts|--allow-scripts|--unsafe-perm)/i;

/** P4: an install resolves the lockfile and nothing else, scripts still off. */
const installRule: Rule = (context, finding) => {
  let installs = 0;

  context.lines.forEach((line, index) => {
    if (LIFECYCLE_REENABLED.test(line)) {
      finding({
        line: index + 1,
        clause: "install",
        rule: "no-lifecycle-scripts",
        reference: line.trim(),
        message:
          "turns package lifecycle scripts back on for this job. " +
          "`pnpm-workspace.yaml` keeps them off with a committed reason " +
          "(pinning-conventions P4), and a workflow that re-enables them lets " +
          "an install execute code no review here has seen.",
      });
    }
    if (!INSTALL_COMMAND.test(line)) return;
    installs += 1;
    if (/--no-frozen-lockfile|--force\b/.test(line)) {
      finding({
        line: index + 1,
        clause: "install",
        rule: "frozen-install",
        reference: line.trim(),
        message:
          "installs with the lockfile explicitly unfrozen, so a run may resolve " +
          "a dependency version nothing committed here names. " +
          "pinning-conventions P4.",
      });
      return;
    }
    if (/^\s*(?:-\s*)?(?:run\s*:\s*)?pnpm\s+install\b/.test(line) && line.includes("--frozen-lockfile")) {
      return;
    }
    if (/\bpnpm\s+install\b/.test(line) && line.includes("--frozen-lockfile")) return;
    finding({
      line: index + 1,
      clause: "install",
      rule: "frozen-install",
      reference: line.trim(),
      message:
        "installs dependencies without `pnpm install --frozen-lockfile`. A " +
        "lockfile that no longer satisfies the manifests must fail the check " +
        "rather than be quietly repaired, and no run may resolve a version the " +
        "lockfile does not already name. pinning-conventions P4.",
    });
  });

  for (const step of context.jobs.flatMap(([, job]) => steps(job))) {
    const uses = step["uses"];
    if (typeof uses !== "string" || !uses.startsWith("pnpm/action-setup@")) continue;
    const inputs = asMapping(step["with"]) ?? {};
    const runInstall = inputs["run_install"];
    if (runInstall === undefined || String(runInstall) === "false") continue;
    finding({
      line: lineOf(context, /^\s*run_install\s*:/),
      clause: "install",
      rule: "frozen-install",
      reference: `pnpm/action-setup run_install: ${String(runInstall)}`,
      message:
        "lets the setup action install for itself, which is an install this " +
        "check cannot read the flags of. Leave it off and install in a `run:` " +
        "step, where `--frozen-lockfile` is visible. pinning-conventions P4.",
    });
  }

  if (context.required.length > 0 && installs === 0) {
    finding({
      line: 0,
      clause: "install",
      rule: "install-present",
      reference: context.required.map(([id, job]) => contextNameOf(id, job)).join(", "),
      message:
        "produces a required check run and installs nothing, so there is no " +
        "frozen install here for that context to rest on. Either the job runs " +
        "against dependencies nobody resolved, or this check has stopped " +
        "reading the step that resolves them.",
    });
  }
};

/** AC-9: a green that skipped a test is refused, on a runner that can help it. */
const skipsRule: Rule = (context, finding) => {
  for (const [jobId, job] of context.required) {
    if (contextNameOf(jobId, job) !== context.options.fullTestContext) continue;
    const scripts = runScripts(job).join("\n");

    // The whole target, not a prefix of one: `pnpm run test:unit` contains
    // `pnpm run test` and is exactly the downgrade this rule exists to catch.
    const wholeTarget = new RegExp(
      `${context.options.fullTestCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:.-])`,
    );
    if (!wholeTarget.test(scripts)) {
      finding({
        line: 0,
        clause: "skips",
        rule: "full-test-target",
        reference: context.options.fullTestCommand,
        message:
          `is the \`${context.options.fullTestContext}\` context and never runs ` +
          `\`${context.options.fullTestCommand}\`. A narrower target - the unit ` +
          "half alone - leaves the ten integration tests, which are the only " +
          "thing here that exercises a real database, unrun behind a green tick.",
      });
    }

    if (!scripts.includes(context.options.skipRefusalPath)) {
      finding({
        line: 0,
        clause: "skips",
        rule: "skip-refusal",
        reference: context.options.skipRefusalPath,
        message:
          "runs the suite and never asks whether it SKIPPED anything. Three " +
          "integration suites skip themselves rather than failing when the " +
          "machine's Docker cannot start a container, and the process still " +
          `exits zero. Run \`${context.options.skipRefusalPath}\` over the ` +
          "captured output so that green means every test executed.",
      });
    }

    const piping = runScripts(job).some((script) => /\|\s*tee\b/.test(script));
    const shells = [
      String(asMapping(asMapping(context.document["defaults"])?.["run"] ?? null)?.["shell"] ?? ""),
      ...steps(job).map((step) => String(step["shell"] ?? "")),
    ];
    if (piping && !shells.includes("bash")) {
      finding({
        line: 0,
        clause: "skips",
        rule: "pipefail",
        reference: "defaults.run.shell",
        message:
          "pipes the test target into another command without asking for the " +
          "`bash` shell, whose `-eo pipefail` is what carries a failing suite's " +
          "status through the pipe. Without it the step takes `tee`'s status " +
          "and a red suite reports success.",
      });
    }

    const runners = asList(job["runs-on"]) ?? [];
    if (!runners.some((label) => /^ubuntu-/.test(label))) {
      finding({
        line: lineOf(context, /^\s*runs-on\s*:/),
        clause: "skips",
        rule: "container-capable-runner",
        reference: `runs-on: ${runners.join(", ") || "(unreadable)"}`,
        message:
          "runs the suite on a runner that is not a GitHub-hosted Linux image. " +
          "Seven of the ten integration tests start a real PostgreSQL " +
          "container, and the hosted macOS and Windows images carry no Docker " +
          "daemon: three suites would skip and seven would fail.",
      });
    }
  }
};

/** AC-12: no secret in scope, and a token that can write nothing. */
const tokenRule: Rule = (context, finding) => {
  context.lines.forEach((line, index) => {
    if (!/\bsecrets\s*\./.test(line)) return;
    finding({
      line: index + 1,
      clause: "token",
      rule: "no-secrets",
      reference: line.trim(),
      message:
        "puts a secret in reach of this job. Nothing in this suite reads a " +
        "credential - the only hosts it contacts are loopback servers and " +
        "`.invalid` fixtures - and a job holding a secret is a secret a pull " +
        "request from a fork can be written to reach for.",
    });
  });

  const holders: [string, YamlNode][] = [
    ["the workflow", context.document["permissions"] ?? null],
    ...context.jobs.map(([id, job]): [string, YamlNode] => [`job ${id}`, job["permissions"] ?? null]),
  ];

  if (context.document["permissions"] === undefined) {
    finding({
      line: 0,
      clause: "token",
      rule: "permissions-declared",
      reference: "permissions",
      message:
        "declares no `permissions:` block, so each job receives whatever the " +
        "repository's default happens to be - which is write access to " +
        "contents on a repository that has never been narrowed. A check that " +
        "reads code needs no ability to change it.",
    });
  }

  for (const [where, node] of holders) {
    if (node === null || node === undefined) continue;
    if (typeof node === "string") {
      if (node === "read-all") continue;
      finding({
        line: lineOf(context, /^\s*permissions\s*:/),
        clause: "token",
        rule: "no-write-permission",
        reference: `${where}: permissions: ${node}`,
        message:
          `grants \`${node}\` to a job that only needs to read this repository. ` +
          "The automatic token must carry no write permission on contents.",
      });
      continue;
    }
    const scopes = asMapping(node);
    if (scopes === null) continue;
    for (const [scope, value] of Object.entries(scopes)) {
      if (String(value) !== "write") continue;
      finding({
        line: lineOf(context, new RegExp(`^\\s*${scope}\\s*:`)),
        clause: "token",
        rule: "no-write-permission",
        reference: `${where}: ${scope}: write`,
        message:
          `grants write on \`${scope}\` to a job that only reads. Nothing here ` +
          "creates a comment, a tag, a release or a commit, and a token that " +
          "could is a token a malicious pull request would like to borrow.",
      });
    }
    const contents = scopes["contents"];
    if (contents !== undefined && String(contents) !== "read" && String(contents) !== "none") {
      finding({
        line: lineOf(context, /^\s*contents\s*:/),
        clause: "token",
        rule: "no-write-permission",
        reference: `${where}: contents: ${String(contents)}`,
        message: "grants more than read on repository contents.",
      });
    }
  }
};

/** The versions a run resolves are fixed by something committed. */
const runtimeRule: Rule = (context, finding) => {
  const floor = context.options.nodeFloor;
  for (const [jobId, job] of context.jobs) {
    const runners = asList(job["runs-on"]) ?? [];
    for (const label of runners) {
      if (!label.endsWith("-latest")) continue;
      finding({
        line: lineOf(context, /^\s*runs-on\s*:/),
        clause: "runtime",
        rule: "pinned-runner",
        reference: `${jobId}.runs-on: ${label}`,
        message:
          `names the moving label \`${label}\`. GitHub repoints it at a new ` +
          "image on its own schedule, so the machine a check ran on last week " +
          "is not the one it runs on today and a break arrives with no diff.",
      });
    }

    for (const step of steps(job)) {
      const uses = step["uses"];
      if (typeof uses !== "string") continue;
      const inputs = asMapping(step["with"]) ?? {};

      if (uses.startsWith("actions/setup-node@")) {
        const version = String(inputs["node-version"] ?? "");
        if (!EXACT_VERSION.test(version)) {
          finding({
            line: lineOf(context, /^\s*node-version\s*:/),
            clause: "runtime",
            rule: "node-version-exact",
            reference: `node-version: ${version || "(absent)"}`,
            message:
              "does not name an exact MAJOR.MINOR.PATCH Node version. This " +
              "repository has no build step: Node runs the TypeScript sources " +
              "by stripping types, so the runtime version decides whether the " +
              "suite executes at all rather than merely how fast it does.",
          });
        } else if (floor !== undefined && compareVersions(version, floor) < 0) {
          finding({
            line: lineOf(context, /^\s*node-version\s*:/),
            clause: "runtime",
            rule: "node-version-floor",
            reference: `node-version: ${version}`,
            message:
              `is below this repository's own \`engines.node\` floor of ${floor}. ` +
              "Below it Node does not warn and carry on, it cannot execute a " +
              "`.ts` test file at all.",
          });
        }
      }

      if (uses.startsWith("pnpm/action-setup@")) {
        const version = String(inputs["version"] ?? "");
        if (!EXACT_VERSION.test(version)) {
          finding({
            line: lineOf(context, /^\s*version\s*:/),
            clause: "runtime",
            rule: "pnpm-version-exact",
            reference: `pnpm/action-setup version: ${version || "(absent)"}`,
            message:
              "does not name an exact pnpm version. `package.json` carries no " +
              "`packageManager` field, so with nothing here either, nothing " +
              "committed in this repository decides which pnpm a fresh machine " +
              "resolves the lockfile with.",
          });
        }
      }
    }
  }
};

const RULES: readonly Rule[] = [
  triggerRule,
  conditionRule,
  installRule,
  skipsRule,
  tokenRule,
  runtimeRule,
];

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

/**
 * Grade `files` - every one of them treated as a workflow - against the
 * properties the required contexts rest on. Pure: it takes text, so a broken
 * sample is graded by exactly the same code the committed workflows are.
 */
export function scanCiWorkflows(
  files: readonly ScannedFile[],
  options: CiScanOptions = {},
): CiFinding[] {
  const settled = {
    requiredContexts: options.requiredContexts ?? REQUIRED_CONTEXTS,
    defaultBranch: options.defaultBranch ?? DEFAULT_BRANCH,
    fullTestContext: options.fullTestContext ?? FULL_TEST_CONTEXT,
    fullTestCommand: options.fullTestCommand ?? FULL_TEST_COMMAND,
    skipRefusalPath: options.skipRefusalPath ?? SKIP_REFUSAL_PATH,
    nodeFloor: options.nodeFloor,
    treeLevel: options.treeLevel ?? false,
  };

  const findings: CiFinding[] = [];
  const producedBy = new Map<string, string[]>();

  for (const file of files) {
    let document: { [key: string]: YamlNode } | null;
    try {
      document = asMapping(parseWorkflowYaml(file.text));
    } catch (error) {
      findings.push({
        path: file.path,
        line: error instanceof WorkflowParseError ? error.line : 0,
        clause: "context",
        rule: "workflow-readable",
        reference: file.path,
        message:
          `cannot be read as a workflow (${error instanceof Error ? error.message : String(error)}). ` +
          "A workflow this check cannot parse is a workflow it is not grading, " +
          "and a grader that has quietly stopped looking must never be mistaken " +
          "for a compliant tree.",
      });
      continue;
    }
    if (document === null) {
      findings.push({
        path: file.path,
        line: 0,
        clause: "context",
        rule: "workflow-readable",
        reference: file.path,
        message: "is not a mapping, so it declares no jobs and no triggers at all.",
      });
      continue;
    }

    const jobs = Object.entries(asMapping(document["jobs"]) ?? {})
      .map(([id, node]): [string, { [key: string]: YamlNode } | null] => [id, asMapping(node)])
      .filter((entry): entry is [string, { [key: string]: YamlNode }] => entry[1] !== null);

    for (const [id, job] of jobs) {
      const name = contextNameOf(id, job);
      producedBy.set(name, [...(producedBy.get(name) ?? []), `${file.path}:${id}`]);
    }

    const context: FileContext = {
      file,
      document,
      jobs,
      required: jobs.filter(([id, job]) =>
        settled.requiredContexts.includes(contextNameOf(id, job)),
      ),
      options: settled,
      lines: file.text.split("\n").map(stripYamlComment),
    };

    for (const rule of RULES) {
      rule(context, (finding) => findings.push({ path: file.path, ...finding }));
    }
  }

  if (settled.treeLevel) {
    if (files.length === 0) {
      findings.push({
        path: "",
        line: 0,
        clause: "context",
        rule: "workflows-present",
        reference: ".github/workflows",
        message:
          "holds no workflow this scan could read. Either every gate this " +
          "repository has was deleted, or the scan stopped reaching the " +
          "directory they live in - and a check that has quietly stopped " +
          "looking is worse than no check.",
      });
    }
    for (const wanted of settled.requiredContexts) {
      const producers = producedBy.get(wanted) ?? [];
      if (producers.length === 1) continue;
      findings.push({
        path: "",
        line: 0,
        clause: "context",
        rule: "required-context-produced",
        reference: wanted,
        message:
          producers.length === 0
            ? `is required on \`${settled.defaultBranch}\` and no committed job ` +
              `produces a check run by that name. ${WHY_A_REQUIRED_CONTEXT_MUST_REPORT}`
            : `is required on \`${settled.defaultBranch}\` and ${producers.length} ` +
              `jobs produce a check run by that name (${producers.join(", ")}). ` +
              "Protection names a context, not a job, so which of them satisfies " +
              "it is not something anybody can read off the tree.",
      });
    }
  }

  return findings;
}

/** The findings as the message a failing check should carry. */
export function describeCiFindings(findings: readonly CiFinding[]): string {
  if (findings.length === 0) return "every committed workflow gates what it claims to";
  const lines = findings.map((finding) => {
    const where = finding.path === "" ? "(tree)" : `${finding.path}:${finding.line}`;
    return `  ${where} [${finding.clause} ${finding.rule}] ${finding.reference} ${finding.message}`;
  });
  return (
    `${findings.length} finding(s) against the committed workflows. The gate is ` +
    "the only thing standing between a red suite and this repository's default " +
    "branch:\n" +
    lines.join("\n")
  );
}

/* ------------------------------------------------------------------ *
 * Reading the tree
 * ------------------------------------------------------------------ */

/**
 * Every committed workflow, found by SCANNING the directory rather than by
 * name, so a workflow added tomorrow is graded the moment it is committed.
 * Samples parked behind a `.fixture` extension are never read as tree content,
 * the way the pinning check's are not.
 */
export function collectCiWorkflows(rootDir: string): ScannedFile[] {
  const directory = path.join(rootDir, ".github", "workflows");
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return [];
  }
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    if (!statSync(absolute).isFile()) continue;
    const relative = `.github/workflows/${entry}`;
    if (!isWorkflowFile(relative)) continue;
    files.push({ path: relative, text: readFileSync(absolute, "utf8") });
  }
  return files;
}

/** The whole check over a real tree. */
export function checkCiWorkflows(rootDir: string, nodeFloor?: string): CiFinding[] {
  return scanCiWorkflows(collectCiWorkflows(rootDir), { treeLevel: true, nodeFloor });
}
