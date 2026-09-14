/**
 * Turning a stored value into text a page shows, without letting it become
 * anything else.
 *
 * Two failures this closes, and they pull in opposite directions. A value that
 * carries markup must not become an ELEMENT: listing ids are owner-supplied and
 * availability tokens are a third party's, and either could be a tag. A value
 * that carries a control character must not be DROPPED: filtering it would make
 * the page quietly disagree with the store. So every syntactic character is
 * escaped, every control character is shown as the escape that names it,
 * nothing is removed, and nothing that arrives as text leaves as structure.
 */

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

/**
 * A control character has no glyph, so showing it "as literal text" means
 * showing the escape that names it; tab, newline and carriage return are left
 * alone as whitespace a page already knows how to show. Built from escape
 * sequences so that no line of this file is itself a raw control byte.
 */
const CONTROL = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "g",
);

/** One stored value, as text, safe to put between two tags. */
export function literalText(value: string): string {
  const visible = value.replace(CONTROL, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
  let escaped = "";
  for (const character of visible) {
    escaped += ESCAPES.get(character) ?? character;
  }
  return escaped;
}

/** The same, for a value going into an attribute. Identical rules, said once. */
export function literalAttribute(value: string): string {
  return literalText(value);
}
