/**
 * Parsing and matching robots.txt, to RFC 9309 rather than to folklore.
 *
 * Three rules from the standard that a hand-rolled matcher gets wrong, all
 * quoted from RFC 9309 as fetched 2026-08-24:
 *
 *   - Group selection is case-INSENSITIVE (2.2.1: "Crawlers MUST use
 *     case-insensitive matching to find the group that matches the product
 *     token"), with a fallback to "the group with a user-agent line with the
 *     '*' value, if present", and groups matching the same product token "MUST
 *     be combined into one group".
 *   - Path matching is case-SENSITIVE (2.2.2: "The matching SHOULD be case
 *     sensitive"), starts at the first octet, and "The most specific match
 *     found MUST be used. The most specific match is the match that has the
 *     most octets ... If an 'allow' rule and a 'disallow' rule are equivalent,
 *     then the 'allow' rule SHOULD be used." No match at all means allowed, and
 *     "The /robots.txt URI is implicitly allowed."
 *   - `#` is a line comment, `$` anchors the end of a pattern, and `*` is zero
 *     or more of any character (2.2.3).
 *
 * Two different case rules in one file is the detail worth writing down.
 */

export type RobotsRule = {
  kind: "allow" | "disallow";
  /** The pattern exactly as written, minus surrounding whitespace. */
  pattern: string;
};

export type RobotsGroup = {
  /** Product tokens this group applies to, lower-cased. */
  agents: string[];
  rules: RobotsRule[];
};

export type RobotsFile = {
  groups: RobotsGroup[];
  /**
   * Records the parser saw but does not act on (`sitemap`, `crawl-delay`, ...).
   * RFC 9309 2.2.4 puts them in the MAY bucket and says they MUST NOT terminate
   * a group, so they are kept for a later phase and ignored here.
   */
  otherRecords: Array<{ field: string; value: string }>;
};

/**
 * Parse robots.txt text.
 *
 * `truncated` says the text was cut off at the parsing limit. The final line is
 * then dropped, because half of `allow: /private-area` is `allow: /priv`, and
 * acting on half a rule is inventing one.
 */
export function parseRobotsTxt(text: string, truncated = false): RobotsFile {
  const lines = text.split(/\r\n|\r|\n/);
  if (truncated && lines.length > 0) lines.pop();

  const groups: RobotsGroup[] = [];
  const otherRecords: Array<{ field: string; value: string }> = [];

  let current: RobotsGroup | null = null;
  // A user-agent line directly after a rule line starts a NEW group; one after
  // another user-agent line extends the same group's agent list.
  let lastWasAgent = false;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent" || field === "useragent") {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (field === "allow" || field === "disallow") {
      // 2.2.2: "The crawler SHOULD ignore 'disallow' and 'allow' rules that are
      // not in any group (for example, any rule that precedes the first
      // user-agent line)."
      if (current === null) continue;
      current.rules.push({ kind: field, pattern: value });
      lastWasAgent = false;
      continue;
    }

    otherRecords.push({ field, value });
  }

  return { groups, otherRecords };
}

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * The group that applies to `productToken`: every group naming it (merged, per
 * 2.2.1), or else every group naming `*`, or else no rules at all.
 */
export function selectGroup(file: RobotsFile, productToken: string): RobotsRule[] {
  const token = productToken.toLowerCase();

  const exact = file.groups.filter((group) => group.agents.includes(token));
  if (exact.length > 0) return exact.flatMap((group) => group.rules);

  const wildcard = file.groups.filter((group) => group.agents.includes("*"));
  if (wildcard.length > 0) return wildcard.flatMap((group) => group.rules);

  return [];
}

export type RobotsVerdict = {
  allowed: boolean;
  /** The rule that decided it, or null when nothing matched. */
  rule: RobotsRule | null;
};

/**
 * Decide one path against one group's rules.
 *
 * `path` is the path plus query, as Figure 4 of 2.2.2 shows
 * (`/foo/bar?baz=quz`), already percent-normalised by `normalisePath`.
 */
export function decidePath(rules: RobotsRule[], path: string): RobotsVerdict {
  const target = normalisePath(path);

  // 2.2.2: "The /robots.txt URI is implicitly allowed."
  if (target === "/robots.txt") return { allowed: true, rule: null };

  let best: { rule: RobotsRule; octets: number } | null = null;

  for (const rule of rules) {
    // An empty pattern matches nothing: `disallow:` with no value is the
    // documented way to say "nothing is disallowed".
    if (rule.pattern.length === 0) continue;
    if (!matchesPattern(normalisePath(rule.pattern), target)) continue;

    const octets = octetLength(rule.pattern);
    if (best === null || octets > best.octets) {
      best = { rule, octets };
      continue;
    }
    // "If an 'allow' rule and a 'disallow' rule are equivalent, then the
    // 'allow' rule SHOULD be used."
    if (octets === best.octets && rule.kind === "allow") best = { rule, octets };
  }

  // "If no match is found amongst the rules in a group for a matching
  // user-agent or there are no rules in the group, the URI is allowed."
  if (best === null) return { allowed: true, rule: null };
  return { allowed: best.rule.kind === "allow", rule: best.rule };
}

/**
 * `*` is zero or more of any character and `$` anchors the end of the match;
 * every other character is compared as an octet, case sensitively. Matching
 * always starts at the first octet of the path.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");

  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (i === 0) {
      if (!path.startsWith(segment)) return false;
      index = segment.length;
      continue;
    }
    if (segment.length === 0) continue;
    const found = path.indexOf(segment, index);
    if (found === -1) return false;
    index = found + segment.length;
  }

  if (!anchored) return true;

  // With `$`, the last literal segment has to land exactly at the end. When the
  // pattern ends in `*$` the remainder is free, so only the anchor's own
  // position matters.
  const last = segments[segments.length - 1];
  if (last.length === 0) return true;
  return path.endsWith(last) && path.length >= index;
}

/**
 * 2.2.2: a percent-encoded ASCII octet in the URI "MUST be unencoded prior to
 * comparison, unless it is a reserved character ... or the character is outside
 * the unreserved character range". So `%62%61%7A` compares as `baz`, while
 * `%3A` and `%E3%83%84` stay encoded. Encoded octets that survive are
 * upper-cased so the two sides agree on their spelling.
 */
export function normalisePath(path: string): string {
  return path.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const code = Number.parseInt(escape.slice(1), 16);
    const character = String.fromCharCode(code);
    if (/[A-Za-z0-9\-._~]/.test(character)) return character;
    return escape.toUpperCase();
  });
}

/** "The most specific match is the match that has the most octets." */
function octetLength(pattern: string): number {
  return Buffer.byteLength(pattern, "utf8");
}
