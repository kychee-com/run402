/**
 * How a `run` value is paged: by items, never by text lines.
 *
 * A value that fits the inline budget is returned whole. A larger one is paged
 * by the unit a reader thinks in:
 *
 *   - an array: its elements (`path: "$"`);
 *   - an object holding arrays: the elements of its largest top-level array,
 *     e.g. the `rows` of a SQL result (`path: "$.rows"`), with the object's
 *     other fields kept whole beside the window (`rest`);
 *   - any other object: its entries as `{ key, value }` (`path: "$entries"`);
 *   - a long string: its lines (`path: "$lines"`).
 *
 * The window is whole items only: as many leading items as fit the budget,
 * and always at least one, so a page never ends in the middle of a row.
 */

/** A value whose pretty-printed JSON fits in this many lines is returned whole. */
export const VALUE_INLINE_LINES = 200;

export interface PagedValue {
  /** Where the paged items live in the value: `$`, `$.<key>`, `$entries`, or `$lines`. */
  path: string;
  /** Every item, in order: what the result store holds and `expand_result` pages. */
  items: unknown[];
  /** The leading items that fit the inline budget (at least one). */
  window: unknown[];
  /** For `$.<key>`: the object's other top-level fields, whole. */
  rest?: Record<string, unknown>;
}

function prettyLines(value: unknown): number {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? 1 : text.split("\n").length;
}

/** True when the whole value fits the inline budget. */
export function fitsInline(value: unknown, budget = VALUE_INLINE_LINES): boolean {
  return prettyLines(value) <= budget;
}

/** The items a value pages by, and where they live. */
export function pageableItems(value: unknown): Pick<PagedValue, "path" | "items" | "rest"> {
  if (Array.isArray(value)) return { path: "$", items: value };
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    let best: string | null = null;
    for (const [key, v] of Object.entries(obj)) {
      if (Array.isArray(v) && (best === null || v.length > (obj[best] as unknown[]).length)) best = key;
    }
    if (best !== null && (obj[best] as unknown[]).length > 0) {
      const rest: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(obj)) if (key !== best) rest[key] = v;
      return { path: `$.${best}`, items: obj[best] as unknown[], rest };
    }
    return { path: "$entries", items: Object.entries(obj).map(([key, v]) => ({ key, value: v })) };
  }
  if (typeof value === "string") return { path: "$lines", items: value.split("\n") };
  return { path: "$", items: [value] };
}

/** Page a value that does not fit inline: every item, and the leading window of whole items. */
export function pageValue(value: unknown, budget = VALUE_INLINE_LINES): PagedValue {
  const { path, items, rest } = pageableItems(value);
  const restLines = rest ? prettyLines(rest) : 0;
  const window: unknown[] = [];
  let used = restLines + 2; // the brackets around the window
  for (const item of items) {
    const cost = prettyLines(item);
    if (window.length > 0 && used + cost > budget) break;
    window.push(item);
    used += cost;
  }
  return { path, items, window, ...(rest ? { rest } : {}) };
}
