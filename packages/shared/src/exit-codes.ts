/**
 * deal-sentinel's exit-code vocabulary, and the `--help` block that publishes
 * it (`cli` L1, L1a, L5).
 *
 * The numbers are THIS repository's, chosen from what its own committed scripts
 * already spend and from what the Node runtime reserves. 1 is fixed by Node,
 * which returns it for an uncaught exception; 2 and 3 are fixed by
 * `packages/db/scripts/{backup,restore}.sh` and
 * `docs/decisions/0005-container-image-pinning.md`; 4 is the first free number
 * below the band Node produces for real programs. Reserved and never assigned a
 * meaning here: 9, 13 and anything above 128.
 *
 * What binds is the DISTINCTNESS, not the digits. The distinction a caller acts
 * on is 1 against 3: a scheduler retries "could not run" and obeys "the answer
 * is no", and a command that returns the same code for both makes a check that
 * never executed indistinguishable from a check that passed.
 */

/** It ran and the answer is yes. */
export const EXIT_OK = 0;
/** It could not run or could not finish. */
export const EXIT_ERROR = 1;
/** The caller got the invocation wrong. */
export const EXIT_USAGE = 2;
/** It ran, every input was legible, and a constraint said no. */
export const EXIT_REFUSED = 3;
/** It ran and found what it looks for. */
export const EXIT_FINDING = 4;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_ERROR
  | typeof EXIT_USAGE
  | typeof EXIT_REFUSED
  | typeof EXIT_FINDING;

export const EXIT_CODES: readonly ExitCode[] = [
  EXIT_OK,
  EXIT_ERROR,
  EXIT_USAGE,
  EXIT_REFUSED,
  EXIT_FINDING,
];

/**
 * The one wording of each code. Help blocks, the repository's `CLAUDE.md` table
 * and the tests all read it here, so a meaning cannot drift between the place a
 * caller reads it and the place the command prints it.
 */
export const EXIT_CODE_MEANINGS: Readonly<Record<ExitCode, string>> = {
  [EXIT_OK]: "it ran and the answer is yes",
  [EXIT_ERROR]: "it could not run or could not finish",
  [EXIT_USAGE]: "the caller got the invocation wrong",
  [EXIT_REFUSED]: "it ran, every input was legible, and a constraint said no",
  [EXIT_FINDING]: "it ran and found what it looks for",
};

export function exitCodeMeaning(code: ExitCode): string {
  return EXIT_CODE_MEANINGS[code];
}

export type FlagHelp = { flag: string; means: string };
export type ArgumentHelp = { name: string; required: boolean; means: string };

/** Everything `--help` prints, as data a test can enumerate (`cli` L5). */
export type HelpSpec = {
  /** How an operator invokes it, e.g. `pnpm db:init`. */
  command: string;
  summary: string;
  usage: string;
  args: readonly ArgumentHelp[];
  flags: readonly FlagHelp[];
  /** Every code this command can return. `--help` prints each with its meaning. */
  exitCodes: readonly ExitCode[];
  /** One line a reader can paste. */
  example: string;
  /** Environment variables the command reads, if any. */
  environment?: readonly FlagHelp[];
};

/** The `--help` every command in this repository accepts. */
export const HELP_FLAG: FlagHelp = {
  flag: "-h, --help",
  means: "print this help, with every exit code and its meaning, and exit 0",
};

function block(title: string, rows: readonly [string, string][]): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([left]) => left.length));
  return [
    "",
    `${title}:`,
    ...rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`),
  ];
}

/** The help text itself. Deterministic, so a test asserts on it verbatim. */
export function renderHelp(spec: HelpSpec): string {
  const lines = [
    `${spec.command} - ${spec.summary}`,
    "",
    `usage: ${spec.usage}`,
    ...block(
      "arguments",
      spec.args.map(
        (entry) =>
          [
            entry.name,
            `${entry.means} (${entry.required ? "required" : "optional"})`,
          ] as [string, string],
      ),
    ),
    ...block(
      "flags",
      spec.flags.map((entry) => [entry.flag, entry.means] as [string, string]),
    ),
    ...block(
      "environment",
      (spec.environment ?? []).map(
        (entry) => [entry.flag, entry.means] as [string, string],
      ),
    ),
    ...block(
      "exit codes",
      [...spec.exitCodes]
        .sort((left, right) => left - right)
        .map((code) => [String(code), exitCodeMeaning(code)] as [string, string]),
    ),
    "",
    "example:",
    `  ${spec.example}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

export type Invocation =
  | { kind: "run"; positional: readonly string[] }
  | { kind: "help" }
  | { kind: "usage-error"; problem: string };

/**
 * Read a command line against its own help spec: `--help` is answered, an
 * unrecognized flag and a missing or surplus argument are refused, and anything
 * else is the command's to run. One reader, so every command in this repository
 * refuses the same shapes with the same code.
 */
export function readInvocation(
  argv: readonly string[],
  spec: HelpSpec,
): Invocation {
  const positional: string[] = [];

  for (const token of argv) {
    if (token === "-h" || token === "--help") return { kind: "help" };
    if (token.length > 1 && token.startsWith("-")) {
      return { kind: "usage-error", problem: `unrecognized flag ${token}` };
    }
    positional.push(token);
  }

  const required = spec.args.filter((entry) => entry.required);
  if (positional.length < required.length) {
    const missing = required[positional.length];
    return {
      kind: "usage-error",
      problem: `missing required argument ${missing.name}`,
    };
  }
  if (positional.length > spec.args.length) {
    return {
      kind: "usage-error",
      problem:
        `${positional.length} argument(s) given and this command takes ` +
        `at most ${spec.args.length}`,
    };
  }

  return { kind: "run", positional };
}

/** What a command writes to stderr before exiting 2. */
export function renderUsageError(spec: HelpSpec, problem: string): string {
  return `${spec.command}: ${problem}\n${renderHelp(spec)}`;
}
