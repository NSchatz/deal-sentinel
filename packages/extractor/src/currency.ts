/**
 * ISO 4217 currencies and their minor-unit exponents.
 *
 * A price is converted to minor units by that currency's OWN exponent, never by
 * a fixed multiply-by-100: USD 12.99 is 1299 cents, JPY 1299 is 1299 yen (no
 * subdivision at all), KWD 12.995 is 12995 fils. A fixed x100 records JPY 1299
 * as 129900 and KWD 12.995 as 1299 (or 1300 after a rounding), and neither
 * error is visible a week later when the page is gone.
 *
 * A code this table does not carry is not resolvable as an ISO 4217 currency
 * here, and the extractor answers `no-currency` for it rather than assume the
 * exponent is 2. Extending the table is how a new currency is onboarded.
 */

/** The exception currencies: everything whose exponent is not 2. */
const EXPONENT_0 = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
];

const EXPONENT_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

const EXPONENT_4 = ["CLF", "UYW"];

/**
 * The exponent-2 currencies this repo recognises. Not the whole of ISO 4217:
 * the list is the set a source in this project might plausibly quote, and it is
 * extended by adding a code rather than by loosening the unknown-code rule.
 */
const EXPONENT_2 = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CNY",
  "COP",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IRR",
  "JMD",
  "KES",
  "KGS",
  "KHR",
  "KPW",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "MAD",
  "MDL",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "USD",
  "UZS",
  "VES",
  "WST",
  "XCD",
  "YER",
  "ZAR",
  "ZMW",
];

function buildTable(): Map<string, number> {
  const table = new Map<string, number>();
  for (const code of EXPONENT_0) table.set(code, 0);
  for (const code of EXPONENT_3) table.set(code, 3);
  for (const code of EXPONENT_4) table.set(code, 4);
  for (const code of EXPONENT_2) table.set(code, 2);
  return table;
}

const MINOR_UNIT_EXPONENTS = buildTable();

/**
 * The ISO 4217 minor-unit exponent for `code`, or null when this repo does not
 * recognise the code. Case-insensitive on input; codes are upper case.
 */
export function minorUnitExponent(code: string): number | null {
  const normalised = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalised)) return null;
  const exponent = MINOR_UNIT_EXPONENTS.get(normalised);
  return exponent === undefined ? null : exponent;
}

/** Normalise a currency code, or null when it is not one this repo resolves. */
export function normaliseCurrency(code: string): string | null {
  const normalised = code.trim().toUpperCase();
  return minorUnitExponent(normalised) === null ? null : normalised;
}

/**
 * Convert a decimal price string to an exact integer in the currency's minor
 * unit. Returns null when the conversion cannot be exact, which the caller
 * turns into a typed failure - a rounded price is a poisoned price.
 *
 * Accepted number shapes, and deliberately only these:
 *   - "1299", "1299.00"        plain, '.' as the decimal separator
 *   - "1,299.00"               US-style grouping, groups of exactly 3
 * Anything else (European "1.299,00", a bare "1.299" that is either 1299 or
 * 1.299 depending on locale, "Call for price", an empty string) returns null.
 * Guessing which of two readings a retailer meant is exactly how a price
 * history gets poisoned silently.
 *
 * Fractional digits beyond the currency's exponent are accepted only when they
 * are all zeros ("12.9900" in USD is 1299); a non-zero digit past the exponent
 * ("12.995" in USD) is not representable and returns null.
 *
 * A NEGATIVE amount is refused rather than converted. No new-retail offer is
 * priced below zero, so a leading minus is markup this reader does not
 * understand - a subtraction, a discount delta, a broken template - and reading
 * it as a price puts a number in the history that no comparison can ever be
 * right about. A typed failure is a visible gap; a negative all-time low is not.
 */
export function toMinorUnits(price: string, currency: string): bigint | null {
  const exponent = minorUnitExponent(currency);
  if (exponent === null) return null;

  const cleaned = stripCurrencyDecoration(price, currency);
  if (cleaned === null) return null;
  // Stated explicitly rather than left to the shape tests below, which would
  // also reject it: the refusal is a decision about money, not an accident of
  // a regular expression somebody may widen later.
  if (cleaned.startsWith("-")) return null;

  let digits: string;
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    digits = cleaned;
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    digits = cleaned.replace(/,/g, "");
  } else {
    return null;
  }

  const [whole, fraction = ""] = digits.split(".");
  const kept = fraction.slice(0, exponent);
  const dropped = fraction.slice(exponent);
  if (/[^0]/.test(dropped)) return null;

  const padded = kept.padEnd(exponent, "0");
  return BigInt(whole + padded);
}

/**
 * Remove the decoration a real retailer wraps around a price - whitespace
 * (JavaScript's \s already covers NBSP and narrow NBSP, which is what sits
 * between a symbol and its digits), a leading or trailing currency symbol, and
 * a leading or trailing copy of the declared ISO code - without touching the
 * digits or the separators between them. Returns null when nothing is left.
 */
function stripCurrencyDecoration(price: string, currency: string): string | null {
  const code = currency.trim().toUpperCase();
  let text = price.replace(/\s/g, "");
  if (text.length === 0) return null;

  text = text.replace(/^[$€£¥₩₹₽₦₱฿₪]+/, "");
  text = text.replace(/[$€£¥₩₹₽₦₱฿₪]+$/, "");
  if (code.length === 3) {
    text = text.replace(new RegExp(`^${code}`, "i"), "");
    text = text.replace(new RegExp(`${code}$`, "i"), "");
  }

  return text.length === 0 ? null : text;
}
