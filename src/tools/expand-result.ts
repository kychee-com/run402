/**
 * `expand_result` — the other half of the lossy surface's contract.
 *
 * A tool that shows a window MUST hand back the affordance for the rest, or
 * "truncate the view, never the data" is just truncation with a nicer message.
 * This is that affordance: give it the `ref` a tool printed and it returns any
 * window of the FULL result the tool actually received.
 *
 * A secret-bearing result never has a ref (see `../result-store.js`), so it can
 * never be reached from here — that is enforced at store time, not by this tool
 * refusing to look.
 */

import { z } from "zod";
import {
  RESULT_STORE_DEFAULT_EXPAND_LIMIT,
  RESULT_STORE_MAX_ENTRIES,
  RESULT_STORE_MAX_EXPAND_LIMIT,
  RESULT_STORE_TTL_MS,
  expandResult,
} from "../result-store.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const TTL_MINUTES = Math.round(RESULT_STORE_TTL_MS / 60_000);

export const expandResultSchema = {
  ref: z
    .string()
    .describe(
      "The opaque handle a tool printed alongside its bounded view (res_ followed by 16 hex). Refs are per-process and short-lived — do not store one across sessions.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Index of the first item to return. Defaults to 0. Page by adding the previous window's shown count."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RESULT_STORE_MAX_EXPAND_LIMIT)
    .optional()
    .describe(
      `How many items to return, ${RESULT_STORE_DEFAULT_EXPAND_LIMIT} by default and at most ${RESULT_STORE_MAX_EXPAND_LIMIT}. The window stays bounded even when expanded — page with offset rather than asking for everything at once.`,
    ),
};

export async function handleExpandResult(args: {
  ref: string;
  offset?: number;
  limit?: number;
}): Promise<ToolResult> {
  const page = expandResult(args.ref, {
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

  if (!page) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `No result is held under ref ${args.ref}.`,
            "",
            `Refs live in this server process only: they expire ${TTL_MINUTES} minutes after the tool ran, and only the ${RESULT_STORE_MAX_ENTRIES} most recent are kept.`,
            "Unknown, evicted and expired are deliberately the same answer, because the recovery is the same one: re-run the tool that produced the ref.",
            "A result that carried a secret never has a ref at all — it is not retained, so there is nothing here to expand.",
          ].join("\n"),
        },
      ],
    };
  }

  const end = page.offset + page.shown;
  const lines = [
    `${page.ref} (${page.kind}) — items ${page.offset}..${Math.max(page.offset, end - 1)} of ${page.total}.`,
  ];
  if (end < page.total) {
    lines.push(`${page.total - end} more: expand_result with ref ${page.ref} and offset ${end}.`);
  } else if (page.total > 0) {
    lines.push("This window reaches the end of the result.");
  }
  lines.push("", JSON.stringify(page.items, null, 2));

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
