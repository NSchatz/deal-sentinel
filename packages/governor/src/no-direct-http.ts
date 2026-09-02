/**
 * The check that makes "there is no path around the governor" a property of the
 * repository rather than a habit.
 *
 * A governor something can route around is a suggestion. So this module reads
 * every source file in the tree and reports any site that reaches an HTTP
 * client outside the governor. Two kinds of site count:
 *
 *   1. A CLIENT reached directly: the global HTTP client named in any position
 *      at all, an import of `node:http`, `undici`, `axios` or their neighbours,
 *      an `https.request(`, an `XMLHttpRequest`.
 *   2. THIS PACKAGE'S OWN ungoverned transport: the factory that builds a live
 *      client, or an import of the module it lives in. That factory is not
 *      exported from `index.ts` - a caller asks for the `LIVE_TRANSPORT` marker
 *      instead, which has no `send` and only the `Governor` can redeem - and
 *      naming it anyway is reported here so that removing it from the public
 *      surface is not the only thing standing in the way.
 *   3. ANOTHER MECHANISM that puts a request on the wire without naming a
 *      client the first two rules know: a raw socket (`node:net`, `node:tls`),
 *      a global that opens its own connection (the two socket constructors), a
 *      module specifier reached through a call the import rules do not spell -
 *      `createRequire(import.meta.url)("node:http")` is the shape - or a
 *      subprocess running a program whose whole job is fetching a URL.
 *
 * Rule 1 does NOT enumerate the global names the client can be reached through.
 * It cannot: `globalThis`, `window`, `self` and Node's own `global` all resolve
 * to the same object, a bracket property is the same access as a dotted one, a
 * local alias of the global object is a name nobody can predict, and a renamed
 * destructure leaves no recognisable call at all. Enumerating spellings catches
 * the ones somebody thought of. So instead the rule treats ANY RESOLUTION OF
 * THE IDENTIFIER as a call site: the identifier may appear, in code, in exactly
 * one file in this repository.
 *
 * Making that workable takes one more step than a regular expression over the
 * raw text. The word also occurs in English, in test names and in error
 * messages, and a check that fires on prose is a check somebody switches off.
 * So the identifier rules are matched against a CODE VIEW of each line, in
 * which comment bodies and plain string contents are blanked while a template
 * literal's `${...}` interpolations - which run - are kept, and a computed
 * access with a literal key is first rewritten into the dotted form it is.
 * The import rules keep reading the raw text, because an import specifier IS a
 * string and has to stay legible, and one more rule reads the raw text on
 * purpose: a string whose whole contents are the client's name is a property
 * lookup waiting to happen, not a sentence.
 *
 * What this cannot do, said plainly rather than left to be discovered: it is a
 * text scan, so a name COMPUTED at run time - `eval`, `new Function`, a
 * specifier concatenated from fragments - is outside its reach, and would be
 * outside an AST checker's reach too. Rule 3 is an ENUMERATION of mechanisms
 * and it is not claimed to be complete: a subprocess running a program not on
 * its list, or a protocol implemented by hand over a socket obtained some other
 * way, is still a way out. The property this does prove is that no ordinary
 * spelling of a client survives review - not a call, not a property of any
 * object, not an alias, not a destructure, not an import, not a string - and
 * that the mechanisms below have each been thought about once, in writing.
 *
 * The allowlist is deliberately by exact path and by rule. Widening it is a
 * visible, reviewable diff, which is the point.
 *
 * `test/unit/no-direct-http.test.ts` proves this check can FAIL before it
 * believes that it passes: it runs the same function over committed fixture
 * call sites that bypass the governor and asserts the findings, then runs it
 * over the tree as it stands and asserts none. A check that can only pass
 * proves nothing.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type SourceFile = {
  /** Repository-relative, with forward slashes. */
  path: string;
  text: string;
};

export type DirectHttpFinding = {
  path: string;
  /** One-based. */
  line: number;
  rule: string;
  snippet: string;
};

export type AllowlistEntry = {
  /** Repository-relative path, forward slashes. */
  path: string;
  /** Rules this file may break, and the reason it may. */
  rules: string[];
  why: string;
};

/**
 * The complete list of files permitted to name an HTTP client or this package's
 * own ungoverned transport, and why.
 *
 * Exactly ONE path may break a client rule - `fetch-call`, `client-import` from
 * a sending file, `client-request-call` - and that is the transport. If you are
 * adding a second, you are adding a second way out of this process, and the
 * governor stops being one.
 */
export const HTTP_CLIENT_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    path: "packages/governor/src/transport.ts",
    rules: [
      "fetch-call",
      "client-import",
      "client-request-call",
      "ungoverned-transport",
    ],
    why:
      "The single HTTP transport, and the factory that builds one. Everything " +
      "else takes an HttpTransport port and receives one from the governor.",
  },
  {
    path: "packages/governor/src/governor.ts",
    rules: ["ungoverned-transport", "transport-import"],
    why:
      "The chokepoint. It is the one place the LIVE_TRANSPORT marker is " +
      "redeemed for a real client, and the client it builds is reachable only " +
      "from behind all six gates. It names no HTTP client itself.",
  },
  {
    path: "test/support/loopback-server.ts",
    rules: ["client-import", "client-module-literal"],
    why:
      "Creates an http.Server bound to 127.0.0.1 so the suite can exercise " +
      "robots, back-pressure and breaker cases without touching a third " +
      "party. It serves; it never sends. The module literals are that same " +
      "import and a type-only one for the socket it is handed.",
  },
];

/**
 * What a rule reads.
 *
 * `source`: comment bodies blanked, everything else verbatim. An import
 * specifier is a string, so the import rules need this.
 * `code`: the same, plus plain string contents blanked and computed accesses
 * with a literal key rewritten as dotted ones. The identifier rules need this,
 * so that the word in a sentence is not read as a call.
 */
export type ScanTarget = "source" | "code";

type Rule = { name: string; scans: ScanTarget; pattern: RegExp; describe: string };

/**
 * The names this repository may not spell outside the allowlist, assembled
 * from fragments so that THIS file - which has to talk about them - is not
 * itself a finding. The same reason the test fixtures live under a `.fixture`
 * extension.
 */
const GLOBAL_CLIENT = "fet" + "ch";
const TRANSPORT_FACTORY = "create" + "Fetch" + "Transport";
const TRANSPORT_MODULE = "trans" + "port";
/** Globals that open their own connection: an HTTP upgrade and a GET stream. */
const SOCKET_CLIENTS = ["Web" + "Socket", "Event" + "Source"];
/** Programs whose whole job is fetching a URL, for the subprocess rule. */
const FETCHING_PROGRAMS = ["cu" + "rl", "wg" + "et", "htt" + "pie"];

/**
 * An identifier boundary. `-` joins the two halves so that `node-fetch` inside
 * a package name and `fetch-call` inside a rule name are words, not
 * identifiers, while `.fetch`, `{ fetch:` and `= fetch;` all are.
 */
const BEFORE = "(?<![\\w$-])";
const AFTER = "(?![\\w$-])";

/**
 * `\x22` and `\x27` are `"` and `'`. Spelled as escapes so that the code view
 * of this file - which blanks string contents - does not mistake a character
 * class inside a regular expression literal for the start of a string.
 */
const QUOTE = "[\\x22\\x27]";
const NOT_QUOTE = "[^\\x22\\x27]";
const ANY_QUOTE = "[\\x22\\x27`]";
/**
 * What can sit immediately before a module specifier. The last alternative is
 * the return value of a call being called with one - `createRequire(
 * import.meta.url)("node:http")` reaches every module the list below names
 * through a head none of the other three spell.
 */
const IMPORT_HEAD =
  "(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\)\\s*\\(\\s*)";

/**
 * Specifiers that reach a client or a raw socket. `net` and `tls` are here
 * because a socket plus the seven bytes of a request line is an HTTP client
 * that no client rule would recognise.
 */
const CLIENT_MODULE =
  "(?:node:)?(?:http|https|http2|net|tls|undici|axios|node-" +
  GLOBAL_CLIENT +
  "|got|superagent|request|phin|needle|ky)";

/**
 * The same list, narrowed to the one spelling that can ONLY be a specifier: the
 * `node:` scheme. A bare `"http"` or `"request"` is a config key and a URL
 * scheme in this repository long before it is a module, and a bare package name
 * is something people write in a list of package names - both directions
 * produce a check that fires on `config.ts` or on prose, and a check that fires
 * on prose is a check somebody deletes. The bare spellings are not lost: the
 * rule above reads them wherever an import head precedes them, and that head
 * now includes the returned-call form.
 */
const CLIENT_MODULE_LITERAL = "node:(?:http|https|http2|net|tls)";

const RULES: readonly Rule[] = [
  {
    name: "client-import",
    scans: "source",
    pattern: new RegExp(IMPORT_HEAD + QUOTE + CLIENT_MODULE + QUOTE),
    describe: "imports an HTTP client",
  },
  {
    name: "fetch-call",
    scans: "code",
    // ANY resolution of the identifier, in any position: a bare call, a dotted
    // property of anything at all, a bracket property (rewritten to a dotted
    // one before this runs), a destructure with or without a rename, an alias.
    // `governor.request(...)` is a method call on an object and is not this.
    pattern: new RegExp(BEFORE + GLOBAL_CLIENT + AFTER),
    describe: "names the global HTTP client",
  },
  {
    name: "client-request-call",
    scans: "source",
    pattern:
      /\b(?:https?|http2)\s*\.\s*(?:request|get|connect)\s*\(|new\s+XMLHttpRequest\b|\bnew\s+(?:Agent|ClientRequest)\s*\(/,
    describe: "issues a request through a client object",
  },
  {
    name: "ungoverned-transport",
    scans: "code",
    pattern: new RegExp(BEFORE + TRANSPORT_FACTORY + AFTER),
    describe:
      "names the factory that builds a live, ungoverned HTTP transport",
  },
  {
    name: "transport-import",
    scans: "source",
    pattern: new RegExp(
      IMPORT_HEAD +
        QUOTE +
        NOT_QUOTE +
        "*" +
        TRANSPORT_MODULE +
        "(?:\\.ts|\\.js|\\.mjs)?" +
        QUOTE,
    ),
    describe: "imports the governor's internal HTTP transport module",
  },
  {
    name: "client-name-literal",
    // Deliberately reads the RAW text, where the rules above read code: a
    // string whose contents are exactly one of these names is a property
    // lookup waiting to happen - `Reflect.get(globalThis, "...")`, an access
    // split over two lines - and it is not a sentence anybody writes.
    scans: "source",
    pattern: new RegExp(
      ANY_QUOTE +
        "(?:" +
        [GLOBAL_CLIENT, TRANSPORT_FACTORY, ...SOCKET_CLIENTS].join("|") +
        ")" +
        ANY_QUOTE,
    ),
    describe: "spells the name of an HTTP client as a string",
  },
  {
    name: "client-module-literal",
    // The module names, by the same reasoning as the rule above and for the
    // shape the import rules cannot reach: a specifier handed to a call, or
    // parked in a variable first. `client-import` reads the head; this reads
    // the name wherever it is written.
    scans: "source",
    pattern: new RegExp(ANY_QUOTE + CLIENT_MODULE_LITERAL + ANY_QUOTE),
    describe: "spells the specifier of an HTTP client module as a string",
  },
  {
    name: "client-global-constructor",
    // Any resolution of the identifier, exactly as `fetch-call` treats the
    // global client: both of these open their own connection to a URL and
    // neither is reached through anything the client rules name.
    scans: "code",
    pattern: new RegExp(BEFORE + "(?:" + SOCKET_CLIENTS.join("|") + ")" + AFTER),
    describe: "names a global client that opens its own connection",
  },
  {
    name: "fetching-subprocess",
    // The other end of `node:child_process`, which is NOT itself a rule: this
    // repository legitimately runs `docker` and `pg_restore` from three test
    // files, and allowlisting those for "may run any program" would be a wider
    // hole than the one it closed. What is reported is the payload - a program
    // whose whole job is fetching a URL - wherever it is named.
    scans: "source",
    pattern: new RegExp("\\b(?:" + FETCHING_PROGRAMS.join("|") + ")\\b"),
    describe: "runs a program that fetches a URL",
  },
];

/** The identifiers a computed access with a literal key is rewritten for. */
const COMPUTED_ACCESS = [GLOBAL_CLIENT, TRANSPORT_FACTORY, ...SOCKET_CLIENTS].map(
  (identifier) => ({
    identifier,
    pattern: new RegExp("\\[[ \\t]*([\\x22\\x27`])" + identifier + "\\1[ \\t]*\\]", "g"),
  }),
);

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

/** Every source file under `rootDir`, repository-relative, comments intact. */
export function collectSourceFiles(rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const absolute = path.join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry))) continue;
      files.push({
        path: path.relative(rootDir, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(rootDir);
  return files;
}

/**
 * Report every direct HTTP call site in `files` that the allowlist does not
 * cover. Pure: it takes text, so a fixture call site is checked by exactly the
 * same code as the repository is.
 */
export function findDirectHttpCallSites(
  files: readonly SourceFile[],
  allowlist: readonly AllowlistEntry[] = HTTP_CLIENT_ALLOWLIST,
): DirectHttpFinding[] {
  const findings: DirectHttpFinding[] = [];

  for (const file of files) {
    const allowed = allowlist.find((entry) => entry.path === file.path);

    const source = stripComments(file.text);
    // Same length, same newlines, so the two views stay line-for-line aligned
    // and a finding can quote the readable text while the rule reads the code.
    const code = maskStringLiterals(normaliseComputedAccess(source));

    const sourceLines = source.split("\n");
    const codeLines = code.split("\n");

    sourceLines.forEach((line, index) => {
      for (const rule of RULES) {
        const subject = rule.scans === "code" ? (codeLines[index] ?? "") : line;
        if (!rule.pattern.test(subject)) continue;
        if (allowed !== undefined && allowed.rules.includes(rule.name)) continue;
        findings.push({
          path: file.path,
          line: index + 1,
          rule: rule.name,
          snippet: line.trim(),
        });
      }
    });
  }

  return findings;
}

/** The findings as the message a failing check should carry. */
export function describeFindings(findings: readonly DirectHttpFinding[]): string {
  if (findings.length === 0) return "no direct HTTP call sites";
  const lines = findings.map(
    (finding) =>
      `  ${finding.path}:${finding.line} (${finding.rule}) ${finding.snippet}`,
  );
  return (
    `${findings.length} call site(s) reach an HTTP client outside the ` +
    "governor. Every outbound request in this repository goes through " +
    "Governor.request, which applies the destination host's configured " +
    "ceiling, a randomised delay, the robots.txt decision, back-pressure, the " +
    "breaker and the allowance. A path around it is a path around all six:\n" +
    lines.join("\n")
  );
}

/** What each rule is looking for, for a message or a test that enumerates them. */
export function describeRules(): { name: string; describe: string }[] {
  return RULES.map((rule) => ({ name: rule.name, describe: rule.describe }));
}

/**
 * Blank out comment bodies, keeping every newline and every other character, so
 * that line numbers survive and a sentence ABOUT a call site is not read as
 * one.
 *
 * String and template contents are kept verbatim here rather than blanked, on
 * purpose: an import specifier has to stay readable. `maskStringLiterals` is
 * the second pass, for the rules that read code rather than text. Quote state
 * is tracked only to decide whether a `/` starts a comment, and it RESETS at
 * every newline: a quote character inside a regular expression literal would
 * otherwise swallow the rest of the file, and a check that silently stops
 * looking is worse than no check at all.
 */
export function stripComments(text: string): string {
  let output = "";
  let index = 0;
  let inBlockComment = false;
  let quote = "";

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? "";

    if (character === "\n") {
      // Line boundary: a single-quoted string cannot cross it, and a template
      // that does is not worth losing the rest of the file over.
      quote = "";
      output += "\n";
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        output += "  ";
        index += 2;
        continue;
      }
      output += " ";
      index += 1;
      continue;
    }

    if (quote !== "") {
      if (character === "\\") {
        output += character + next;
        index += 2;
        continue;
      }
      if (character === quote) quote = "";
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", index);
      const stop = lineEnd === -1 ? text.length : lineEnd;
      output += " ".repeat(stop - index);
      index = stop;
      continue;
    }

    if (character === "/" && next === "*") {
      inBlockComment = true;
      output += "  ";
      index += 2;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    }

    output += character;
    index += 1;
  }

  return output;
}

/**
 * Rewrite a computed member access with a literal key into the dotted access it
 * is: `globalThis["fetch"]` becomes `globalThis.fetch`, padded to the same
 * length so line offsets survive.
 *
 * This runs BEFORE the string contents are blanked, because the key is a
 * string and blanking it first would hide the very access the rewrite exists
 * to expose. A bracket is not a dot, and that difference is not allowed to be
 * the difference between a governed request and an ungoverned one.
 */
export function normaliseComputedAccess(text: string): string {
  let output = text;
  for (const { identifier, pattern } of COMPUTED_ACCESS) {
    output = output.replace(pattern, (match) => {
      const dotted = `.${identifier}`;
      return dotted + " ".repeat(Math.max(0, match.length - dotted.length));
    });
  }
  return output;
}

/**
 * Blank the contents of plain string literals, keeping their quotes, every
 * newline and every offset - and keeping a template literal's `${...}`
 * interpolations verbatim, because an interpolation RUNS.
 *
 * This is what lets the identifier rules say "the name may appear in exactly
 * one file" without firing on the word in a test title or an error message.
 * Regular expression literals are not parsed as such (telling one from a
 * division needs the grammar), so quote state RESETS at every newline exactly
 * as it does in `stripComments`: a line this misreads is one line, never the
 * rest of the file.
 */
export function maskStringLiterals(text: string): string {
  type Mode =
    | { kind: "code"; braces: number }
    | { kind: "quoted"; quote: string }
    | { kind: "template" };

  const modes: Mode[] = [{ kind: "code", braces: 0 }];
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? "";
    const mode = modes[modes.length - 1];

    if (mode.kind === "code") {
      if (character === '"' || character === "'") {
        modes.push({ kind: "quoted", quote: character });
        output += character;
        index += 1;
        continue;
      }
      if (character === "`") {
        modes.push({ kind: "template" });
        output += character;
        index += 1;
        continue;
      }
      if (character === "{") {
        mode.braces += 1;
      } else if (character === "}") {
        if (mode.braces === 0 && modes.length > 1) {
          // The close of a `${...}` interpolation.
          modes.pop();
          output += character;
          index += 1;
          continue;
        }
        mode.braces = Math.max(0, mode.braces - 1);
      }
      output += character;
      index += 1;
      continue;
    }

    if (mode.kind === "quoted") {
      if (character === "\\") {
        output += "  ";
        index += 2;
        continue;
      }
      if (character === "\n") {
        // A quoted string cannot cross a line. Whatever this was, recover.
        while (modes.length > 1) modes.pop();
        output += "\n";
        index += 1;
        continue;
      }
      if (character === mode.quote) {
        modes.pop();
        output += character;
        index += 1;
        continue;
      }
      output += " ";
      index += 1;
      continue;
    }

    // A template literal.
    if (character === "\\") {
      output += "  ";
      index += 2;
      continue;
    }
    if (character === "`") {
      modes.pop();
      output += character;
      index += 1;
      continue;
    }
    if (character === "$" && next === "{") {
      modes.push({ kind: "code", braces: 0 });
      output += "${";
      index += 2;
      continue;
    }
    if (character === "\n") {
      output += "\n";
      index += 1;
      continue;
    }
    output += " ";
    index += 1;
  }

  return output;
}
