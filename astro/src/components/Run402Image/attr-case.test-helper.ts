/**
 * Test support for the Astro ↔ React byte-identity contract.
 *
 * React 19's SSR emits several DOM props under their camelCase React
 * names (`srcSet`, `fetchPriority`, `referrerPolicy`, `imageSrcSet`,
 * `imageSizes`) instead of lowercasing them, while `render-html.ts`
 * emits the lowercase HTML spelling. HTML attribute names are ASCII
 * case-insensitive, so the two parse to the same DOM. Passing the
 * lowercase spelling to React instead makes it log "Invalid DOM
 * property" (kychee-com/run402-private#796).
 *
 * The contract is therefore: byte-identical output once attribute
 * NAMES are ASCII-lowercased. Tag names, attribute values, ordering,
 * quoting and escaping must still match byte for byte.
 */

/** Lowercase every attribute name inside every tag; leave all else as is. */
export function lowercaseAttributeNames(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) =>
    // Quoted values are matched first so a name-shaped run inside a value
    // is never touched. Both serializers always quote values with `"`.
    tag.replace(/"[^"]*"|\s[^\s"'=/>]+(?==)/g, (m) =>
      m.startsWith('"') ? m : m.toLowerCase(),
    ),
  );
}
