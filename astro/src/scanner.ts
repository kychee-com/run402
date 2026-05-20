/**
 * Scans `.astro` / `.tsx` / `.jsx` / `.mdx` source code for `<Image>` JSX
 * tags and extracts the `src` prop's string-literal value.
 *
 * This is deliberately a regex/lexer hybrid rather than a full AST parser:
 *
 * 1. We don't need to handle every JSX subtlety — only `<Image src="literal" />`
 *    extraction. Dynamic expressions (`src={expr}`, `{...spread}`) are
 *    deliberately unsupported in v0.1 and emit a build warning.
 * 2. Pulling in a real parser (Babel, the Astro compiler internals, swc)
 *    inflates the package size and creates upstream version-pin headaches.
 * 3. The scanner runs on EVERY transform pass during dev/build, so it needs
 *    to be fast. A regex pass over the source bytes is microseconds; an AST
 *    parse is milliseconds.
 *
 * The regex finds `<Image` followed by a tag body and reads `src` from the
 * raw bytes. The body parser then handles attribute extraction, including
 * skipping over expression interpolations (`{...}`) so we don't get confused
 * by Image tags nested inside JSX expressions.
 */

export interface ImageReference {
  /** Absolute path of the file that contains the reference. */
  importingFile: string;
  /** Raw `src` prop value (the literal string between quotes). */
  src: string;
  /** Approximate line number (1-indexed) where the tag starts. */
  line: number;
  /** Approximate column number (1-indexed). */
  column: number;
}

export interface ScanWarning {
  importingFile: string;
  line: number;
  column: number;
  reason: "dynamic-src" | "spread-props" | "no-src";
  message: string;
}

export interface ScanResult {
  references: ImageReference[];
  warnings: ScanWarning[];
}

/**
 * Match the opening of an `<Image` tag.
 * Followed immediately by whitespace, `/`, or `>` so we don't accidentally
 * match `<ImageGallery>` or similar.
 */
const IMAGE_OPENER_RE = /<Image(?=[\s/>])/g;

export function scanForImageRefs(source: string, importingFile: string): ScanResult {
  const references: ImageReference[] = [];
  const warnings: ScanWarning[] = [];

  // Precompute line offsets for fast line/column derivation.
  const lineOffsets = computeLineOffsets(source);

  let match: RegExpExecArray | null;
  IMAGE_OPENER_RE.lastIndex = 0;
  while ((match = IMAGE_OPENER_RE.exec(source)) !== null) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    const bodyEnd = findTagBodyEnd(source, bodyStart);
    if (bodyEnd === -1) continue; // Malformed/unterminated tag — skip silently.

    const body = source.slice(bodyStart, bodyEnd);
    const { line, column } = offsetToLineCol(start, lineOffsets);
    const parsed = parseTagBody(body);

    if (parsed.spreadFound) {
      warnings.push({
        importingFile,
        line,
        column,
        reason: "spread-props",
        message: `<Image> uses JSX spread props; src cannot be statically resolved.`,
      });
      continue;
    }

    if (parsed.srcLiteral !== null) {
      references.push({
        importingFile,
        src: parsed.srcLiteral,
        line,
        column,
      });
    } else if (parsed.srcDynamic) {
      warnings.push({
        importingFile,
        line,
        column,
        reason: "dynamic-src",
        message: `<Image src={...}> uses a dynamic expression; @run402/astro v0.1 only supports string-literal src.`,
      });
    } else {
      warnings.push({
        importingFile,
        line,
        column,
        reason: "no-src",
        message: `<Image> without a src prop.`,
      });
    }
  }

  return { references, warnings };
}

/**
 * Walk forward from `start` to find the index of the closing `>` of the
 * tag opening, respecting:
 *   - Single/double-quoted attribute values (don't terminate on `>` inside)
 *   - JSX expression interpolations `{...}` (balanced braces; don't terminate)
 *
 * Returns the index of `>` (exclusive of the `>` itself, so substring extraction
 * picks up the body without the closer) or -1 if the tag never closes.
 */
function findTagBodyEnd(source: string, start: number): number {
  let i = start;
  let inSingle = false;
  let inDouble = false;
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    // 39 = ', 34 = ", 123 = {, 125 = }, 62 = >, 47 = /
    if (!inSingle && !inDouble) {
      if (ch === 123) {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === 125) {
        braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0) {
        if (ch === 39) {
          inSingle = true;
          i++;
          continue;
        }
        if (ch === 34) {
          inDouble = true;
          i++;
          continue;
        }
        if (ch === 62 || (ch === 47 && source.charCodeAt(i + 1) === 62)) {
          return i;
        }
      }
    } else if (inSingle && ch === 39) {
      inSingle = false;
    } else if (inDouble && ch === 34) {
      inDouble = false;
    }
    i++;
  }
  return -1;
}

interface ParsedTagBody {
  srcLiteral: string | null;
  srcDynamic: boolean;
  spreadFound: boolean;
}

/**
 * Parse a tag body (everything between `<Image` and the closing `>`/`/>`)
 * looking for a `src` attribute. We accept:
 *   - `src="literal"` / `src='literal'`
 *   - `src={"literal"}` / `src={'literal'}` — single string-literal expr
 *
 * We REJECT (warn-only):
 *   - `src={expr}` where expr is anything non-literal
 *   - `{...rest}` spread props
 */
function parseTagBody(body: string): ParsedTagBody {
  let srcLiteral: string | null = null;
  let srcDynamic = false;
  let spreadFound = false;

  // Spread detection: any `{...identifier}` outside of an attribute value.
  if (/{\s*\.\.\./.test(body)) {
    spreadFound = true;
  }

  // src="literal" or src='literal'
  const literalMatch = body.match(/(?:^|\s)src\s*=\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
  if (literalMatch) {
    srcLiteral = (literalMatch[2] ?? literalMatch[3] ?? "").replace(/\\(["'\\])/g, "$1");
    return { srcLiteral, srcDynamic, spreadFound };
  }

  // src={"literal"} — common in TSX/JSX
  const exprLiteralMatch = body.match(
    /(?:^|\s)src\s*=\s*\{\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\}/,
  );
  if (exprLiteralMatch) {
    srcLiteral = (exprLiteralMatch[2] ?? exprLiteralMatch[3] ?? "").replace(
      /\\(["'\\])/g,
      "$1",
    );
    return { srcLiteral, srcDynamic, spreadFound };
  }

  // src={expr} — dynamic
  if (/(?:^|\s)src\s*=\s*\{/.test(body)) {
    srcDynamic = true;
    return { srcLiteral, srcDynamic, spreadFound };
  }

  return { srcLiteral, srcDynamic, spreadFound };
}

function computeLineOffsets(source: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToLineCol(offset: number, lineOffsets: number[]): { line: number; column: number } {
  // Binary search for the last line offset ≤ offset.
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const v = lineOffsets[mid] ?? 0;
    if (v <= offset) lo = mid;
    else hi = mid - 1;
  }
  const line = lo + 1;
  const column = offset - (lineOffsets[lo] ?? 0) + 1;
  return { line, column };
}
