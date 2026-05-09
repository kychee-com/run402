import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

const MANIFEST_POLICIES = [
  "user_owns_rows",
  "public_read_authenticated_write",
  "public_read_write_UNRESTRICTED",
  "custom",
] as const;

const tableSchema = z.object({
  name: z.string().describe("Table name"),
  expose: z.boolean().describe("true to expose the table; false to hide it (policies + grants revoked on apply)"),
  policy: z.enum(MANIFEST_POLICIES).optional().describe(
    "RLS policy template. Required when expose=true. " +
    "user_owns_rows (users access only their own rows; requires owner_column), " +
    "public_read_authenticated_write (anyone reads; any authenticated user can write ANY row), " +
    "public_read_write_UNRESTRICTED (⚠ fully open; requires i_understand_this_is_unrestricted: true), " +
    "custom (escape hatch; requires custom_sql).",
  ),
  owner_column: z.string().optional().describe("Column containing the user ID (required for user_owns_rows)"),
  force_owner_on_insert: z.boolean().optional().describe("If true, an INSERT trigger sets owner_column to auth.uid() automatically"),
  i_understand_this_is_unrestricted: z.boolean().optional().describe("Required to be true when policy is public_read_write_UNRESTRICTED"),
  custom_sql: z.string().optional().describe("Raw SQL (CREATE POLICY statements) run after RLS is enabled. Required when policy=custom"),
});

const viewSchema = z.object({
  name: z.string().describe("View name"),
  base: z.string().describe("Base table the view reads from"),
  select: z.array(z.string()).describe("Columns the view exposes"),
  filter: z.string().optional().describe("Optional SQL WHERE clause applied to the view"),
  security_invoker: z.boolean().optional().describe("Always coerced to true on apply (never bypass RLS)"),
  expose: z.boolean().optional().describe("Whether to grant SELECT to anon/authenticated (default true)"),
});

const rpcSchema = z.object({
  name: z.string().describe("RPC (function) name"),
  signature: z.string().describe('Argument list including parens, e.g. "(user_id uuid)" or "()"'),
  grant_to: z.array(z.string()).describe('Roles to grant EXECUTE to, e.g. ["authenticated"]'),
});

export const applyExposeSchema = {
  project_id: z.string().describe("The project ID"),
  manifest: z
    .object({
      version: z.literal("1").describe("Manifest version — always \"1\""),
      tables: z.array(tableSchema).describe("Tables to declare (include everything you want exposed AND anything to drop from a prior manifest)"),
      views: z.array(viewSchema).describe("Views to declare (typed projections over tables)"),
      rpcs: z.array(rpcSchema).describe("RPCs (PL/pgSQL functions) to expose with explicit grants"),
    })
    .describe(
      "Full authorization manifest. Convergent: applying twice is a no-op; items removed between applies are dropped. " +
      "Tables are dark by default — any table not listed with expose:true is unreachable via anon/authenticated.",
    ),
};

export async function handleApplyExpose(args: {
  project_id: string;
  manifest: {
    version: "1";
    tables: Array<Record<string, unknown>>;
    views: Array<Record<string, unknown>>;
    rpcs: Array<Record<string, unknown>>;
  };
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let body: {
    status: string;
    project_id: string;
    applied: { tables: string[]; views: string[]; rpcs: string[] };
    dropped: { tables: string[]; views: string[]; rpcs: string[] };
  };
  try {
    body = await getSdk().projects.applyExpose(args.project_id, args.manifest) as typeof body;
  } catch (err) {
    return mapSdkError(err, "applying expose manifest");
  }

  const fmtList = (items: string[]) => (items.length === 0 ? "_(none)_" : items.map((n) => `\`${n}\``).join(", "));

  const lines = [
    `## Expose Manifest Applied`,
    ``,
    `**Applied**`,
    `- Tables: ${fmtList(body.applied.tables)}`,
    `- Views: ${fmtList(body.applied.views)}`,
    `- RPCs: ${fmtList(body.applied.rpcs)}`,
    ``,
    `**Dropped**`,
    `- Tables: ${fmtList(body.dropped.tables)}`,
    `- Views: ${fmtList(body.dropped.views)}`,
    `- RPCs: ${fmtList(body.dropped.rpcs)}`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
