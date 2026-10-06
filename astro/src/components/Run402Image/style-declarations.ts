/**
 * Canonical `style` attribute form shared by the HTML and React renderers.
 *
 * React only accepts object-form styles, so the React renderer parses the
 * merged string back into an object and React serializes it again. For the
 * two adapters to emit byte-identical attributes, the string core builds
 * must already be what that round trip produces:
 *
 *   - one declaration per property, written `name:value` (trimmed, no
 *     spaces around `:`), joined by `;` with no trailing `;`;
 *   - property names lowercased, except custom properties (`--*`), which
 *     are case-sensitive;
 *   - declarations with an empty value dropped (React skips `""`, and the
 *     browser ignores `color:` as invalid).
 *
 * A repeated property keeps only its winning declaration, at that
 * declaration's position. Within one declaration block a later
 * declaration of the same property fully overrides an earlier one (a
 * shorthand resets every longhand it set before), so dropping the earlier
 * occurrence leaves the computed style unchanged, while moving the
 * survivor to the last position keeps it after any shorthand it followed.
 * `!important` is honored the same way the cascade does: a normal
 * declaration does not displace an earlier `!important` one.
 */

export type StyleDeclaration = readonly [name: string, value: string];

/**
 * Split a CSS-declarations string on `;`, but only at top-level depth
 * (outside of `url(...)`, `calc(...)`, and quoted strings). Data URLs
 * carry a `;` between the MIME type and the payload
 * (`data:image/png;base64,...`) that is not a declaration separator.
 */
export function splitDeclarations(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Parse a declarations string into `[name, value]` pairs in source order. */
export function parseDeclarations(s: string): StyleDeclaration[] {
  const out: StyleDeclaration[] = [];
  for (const decl of splitDeclarations(s)) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const name = canonicalPropertyName(decl.slice(0, colon).trim());
    const value = decl.slice(colon + 1).trim();
    if (name !== "" && value !== "") out.push([name, value]);
  }
  return out;
}

/** CSS property names are ASCII case-insensitive; custom properties are not. */
export function canonicalPropertyName(name: string): string {
  return name.startsWith("--") ? name : name.toLowerCase();
}

/**
 * Fold declarations to one per property, at the position of the winning
 * declaration (see the module comment).
 */
export function foldDeclarations(decls: Iterable<StyleDeclaration>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of decls) {
    const prev = out.get(name);
    if (prev !== undefined && isImportant(prev) && !isImportant(value)) continue;
    out.delete(name);
    out.set(name, value);
  }
  return out;
}

export function serializeDeclarations(decls: Map<string, string>): string {
  return [...decls].map(([name, value]) => `${name}:${value}`).join(";");
}

function isImportant(value: string): boolean {
  return /!\s*important$/i.test(value);
}

/**
 * The React style key for a CSS property name: `background-image` →
 * `backgroundImage`, `-webkit-line-clamp` → `WebkitLineClamp`,
 * `-ms-transform` → `msTransform` (React's spelling of the `-ms-` prefix).
 * Custom properties pass through verbatim.
 */
export function reactStyleKey(cssName: string): string {
  if (cssName.startsWith("--")) return cssName;
  return cssName.replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * React keys whose numeric values React writes without a unit: react-dom
 * 19's `unitlessNumbers`, except that its `WebKitBoxFlexGroup` is spelled
 * `WebkitBoxFlexGroup` here, the key React's own camelCase produces.
 */
export const UNITLESS_NUMBER_KEYS: ReadonlySet<string> = new Set(
  (
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth " +
    "boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive " +
    "flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart " +
    "gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight " +
    "opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity " +
    "stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth " +
    "MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp " +
    "msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder " +
    "msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan " +
    "WebkitAnimationIterationCount WebkitBoxFlex WebkitBoxFlexGroup WebkitBoxOrdinalGroup " +
    "WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive " +
    "WebkitFlexShrink WebkitLineClamp"
  ).split(" "),
);

/**
 * Format an object-form style value the way React's style writer does: a
 * number gets `px` unless it is `0`, the property takes unitless numbers,
 * or the property is custom. Strings are only trimmed.
 */
export function formatObjectStyleValue(cssName: string, value: string | number): string {
  if (typeof value === "string") return value.trim();
  if (value === 0 || cssName.startsWith("--") || UNITLESS_NUMBER_KEYS.has(reactStyleKey(cssName))) {
    return String(value);
  }
  return `${value}px`;
}
