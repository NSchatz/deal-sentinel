/**
 * What an address IS, decided from its bytes rather than from its spelling.
 *
 * THE UNSPECIFIED ADDRESS HAS NO CANONICAL SPELLING. `0.0.0.0`, `::`, `::0`,
 * `0000:0000:0000:0000:0000:0000:0000:0000`, `0:0:0:0:0:0:0:0`, `::0.0.0.0`,
 * `::ffff:0.0.0.0`, `::ffff:0:0`, `000.000.000.000`, `0.0.0`, `0.0`, `0`, `00`,
 * `0x0`, `0x00000000` and `0000000000` are all the same address, and this
 * runtime binds every one of them to INADDR_ANY or in6addr_any. A list of
 * spellings closes the ones somebody thought of and leaves the rest open, which
 * is the whole failure mode: the check is then a spelling checker and the next
 * spelling walks past it.
 *
 * So nothing here compares text. An address is PARSED into its bytes and the
 * question is asked of the bytes: are they all zero, or are they the IPv4-mapped
 * form of an all-zero IPv4 address. Both answers mean "every interface this
 * machine has", in either family, however it was written down.
 *
 * The parser is deliberately STRICT about what counts as naming one address:
 *
 *   - Dotted-quad IPv4 with exactly four decimal fields, no leading zeros. A
 *     leading zero is octal to `inet_aton` and decimal to a reader, and an
 *     address whose value depends on which of those you are is not an address
 *     anybody named on purpose.
 *   - IPv6 in the ordinary spellings, one `::` at most, an optional trailing
 *     dotted quad, an optional `%zone`, optional surrounding brackets.
 *   - NOTHING ELSE. `localhost`, a hostname, and the packed forms `0x7f000001`
 *     and `2130706433` (both of which this runtime binds to 127.0.0.1) are all
 *     refused: the first two are resolved at listen time to whatever the
 *     resolver answers, which is not what the configuration named, and the last
 *     two are addresses no reader of the file can check.
 *
 * The legacy forms are still RECOGNISED for the wildcard question - `0` binds
 * every interface and has to be refused as what it is, not as an unparseable
 * string - and they are refused either way. Recognising them buys the refusal an
 * accurate sentence.
 */

/** The two families, named so a refusal can say which one it found. */
export type IpFamily = "ipv4" | "ipv6";

export type ParsedAddress = {
  family: IpFamily;
  /** Four bytes for IPv4, sixteen for IPv6. Network order. */
  bytes: number[];
  /** An IPv6 zone identifier without its `%`, or null. */
  zoneId: string | null;
};

/** Surrounding brackets are a URL authority's punctuation, not part of an address. */
export function stripBrackets(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed.length > 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The address as bytes, or null when this text does not name exactly one
 * address in a spelling a reader can check.
 */
export function parseIpAddress(text: string): ParsedAddress | null {
  const address = stripBrackets(text);
  if (address.length === 0) return null;
  if (address.includes(":")) return parseIpv6(address);
  const bytes = parseIpv4(address);
  return bytes === null ? null : { family: "ipv4", bytes, zoneId: null };
}

/**
 * Which family's unspecified address this text names, or null when it names
 * none.
 *
 * This is the question AC24 turns on, and it is asked of the bytes. The legacy
 * `inet_aton` fallback at the end is not a spelling list: it is the numeric
 * grammar the resolver itself implements, evaluated, and it answers for every
 * member of that grammar including the ones nobody has written down yet.
 */
export function unspecifiedFamily(text: string): IpFamily | null {
  const address = stripBrackets(text);
  // An empty host is how a bare `listen(port)` is spelled, and that binds
  // everything.
  if (address.length === 0) return "ipv4";

  const parsed = parseIpAddress(address);
  if (parsed !== null) {
    if (parsed.bytes.every((byte) => byte === 0)) return parsed.family;
    if (parsed.family === "ipv6" && isIpv4Mapped(parsed.bytes)) {
      return parsed.bytes.slice(12).every((byte) => byte === 0) ? "ipv6" : null;
    }
    return null;
  }

  return legacyIpv4IsZero(address) ? "ipv4" : null;
}

/**
 * Is this the loopback net? 127.0.0.0/8, `::1`, and the IPv4-mapped form of any
 * address in 127.0.0.0/8, which is the same interface reached through the other
 * family.
 */
export function isLoopback(parsed: ParsedAddress): boolean {
  if (parsed.family === "ipv4") return parsed.bytes[0] === 127;
  if (
    parsed.bytes.slice(0, 15).every((byte) => byte === 0) &&
    parsed.bytes[15] === 1
  ) {
    return true;
  }
  return isIpv4Mapped(parsed.bytes) && parsed.bytes[12] === 127;
}

/** `::ffff:a.b.c.d`: ten zero bytes, then `ffff`, then an IPv4 address. */
function isIpv4Mapped(bytes: readonly number[]): boolean {
  return (
    bytes.length === 16 &&
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

/* -------------------------------------------------------------------------- */
/* The parsers                                                                 */
/* -------------------------------------------------------------------------- */

/** Exactly four decimal fields, each 0 to 255, and no leading zero. */
function parseIpv4(text: string): number[] | null {
  const fields = text.split(".");
  if (fields.length !== 4) return null;
  const bytes: number[] = [];
  for (const field of fields) {
    if (!/^\d{1,3}$/.test(field)) return null;
    // `010` is 8 to the resolver and 10 to a reader. Neither reading is the
    // address the configuration names, so there is no answer to give.
    if (field.length > 1 && field.startsWith("0")) return null;
    const value = Number(field);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(text: string): ParsedAddress | null {
  let body = text;
  let zoneId: string | null = null;

  const percent = body.indexOf("%");
  if (percent !== -1) {
    zoneId = body.slice(percent + 1);
    body = body.slice(0, percent);
    if (zoneId.length === 0) return null;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;

  if (halves.length === 1) {
    const groups = parseIpv6Groups(halves[0], true);
    if (groups === null || groups.length !== 8) return null;
    return { family: "ipv6", bytes: flatten(groups), zoneId };
  }

  const head = parseIpv6Groups(halves[0], false);
  const tail = parseIpv6Groups(halves[1], true);
  if (head === null || tail === null) return null;
  // `::` stands for AT LEAST ONE omitted group. A run of eight written groups
  // with a `::` beside them is not an address.
  const omitted = 8 - head.length - tail.length;
  if (omitted < 1) return null;

  return {
    family: "ipv6",
    bytes: [
      ...flatten(head),
      ...new Array<number>(omitted * 2).fill(0),
      ...flatten(tail),
    ],
    zoneId,
  };
}

/**
 * One side of a `::`, as 16-bit groups. A dotted quad is allowed only as the
 * LAST piece of the side that ends the address, where it stands for two groups.
 */
function parseIpv6Groups(
  text: string,
  allowTrailingIpv4: boolean,
): number[][] | null {
  if (text.length === 0) return [];
  const pieces = text.split(":");
  const groups: number[][] = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.includes(".")) {
      if (!allowTrailingIpv4 || index !== pieces.length - 1) return null;
      const bytes = parseIpv4(piece);
      if (bytes === null) return null;
      groups.push([bytes[0], bytes[1]], [bytes[2], bytes[3]]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
    const value = Number.parseInt(piece, 16);
    groups.push([(value >> 8) & 0xff, value & 0xff]);
  }

  return groups;
}

function flatten(groups: readonly number[][]): number[] {
  return groups.flat();
}

/**
 * The `inet_aton` grammar the resolver still implements: one to four numeric
 * fields, each decimal, octal (a leading zero) or hexadecimal (a leading `0x`).
 * Its value is zero exactly when every field is zero, so that is the whole
 * question - no spelling is enumerated and none needs to be.
 */
function legacyIpv4IsZero(text: string): boolean {
  const fields = text.split(".");
  if (fields.length < 1 || fields.length > 4) return false;
  return fields.every((field) => numericField(field) === 0);
}

function numericField(field: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(field)) {
    return Number.parseInt(field.slice(2), 16);
  }
  if (/^0[0-7]*$/.test(field)) return Number.parseInt(field, 8);
  if (/^[1-9][0-9]*$/.test(field)) return Number.parseInt(field, 10);
  return null;
}
