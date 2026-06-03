import { z } from "zod";

// Pure, offline generator — no SDK / network / project. Emits the conventional
// role-table migration, the matching requireRole gate snippet, and a
// first-operator bootstrap. (Keep in sync with the CLI `auth scaffold-roles`
// command in cli/lib/auth.mjs — same artifacts, different presentation.)

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const scaffoldRolesSchema = {
  table: z
    .string()
    .regex(IDENT)
    .optional()
    .describe("Role table name (unquoted SQL identifier). Default: app_roles."),
  user_col: z
    .string()
    .regex(IDENT)
    .optional()
    .describe("User-id column — matches the tenant user id (internal.users.id / JWT 'sub'). Default: user_id."),
  role_col: z
    .string()
    .regex(IDENT)
    .optional()
    .describe("Role column. Default: role."),
  roles: z
    .array(z.string().min(1))
    .optional()
    .describe('Allowed roles. Default: ["operator"].'),
  cache_ttl: z
    .number()
    .int()
    .min(0)
    .max(600)
    .optional()
    .describe("Role-lookup cache seconds (0-600). Default: 60. 0 = instant revocation (fresh DB read per request)."),
};

export function handleScaffoldRoles(args: {
  table?: string;
  user_col?: string;
  role_col?: string;
  roles?: string[];
  cache_ttl?: number;
}): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const table = args.table ?? "app_roles";
  const userCol = args.user_col ?? "user_id";
  const roleCol = args.role_col ?? "role";
  const allowed = (args.roles && args.roles.length > 0 ? args.roles : ["operator"])
    .map((r) => r.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    return { isError: true, content: [{ type: "text", text: "roles must contain at least one non-empty role" }] };
  }
  const cacheTtl = args.cache_ttl ?? 60;
  const firstRole = allowed[0];

  const migration = `-- Conventional Run402 role table: single role per user, keyed on the tenant user id.
CREATE TABLE IF NOT EXISTS ${table} (
  ${userCol} uuid NOT NULL,
  ${roleCol} text NOT NULL,
  PRIMARY KEY (${userCol})
);`;
  const gate = { table, idColumn: userCol, roleColumn: roleCol, allowed, cacheTtl };
  const bootstrap = `-- First-operator bootstrap: run ONCE with the SERVICE key (bypasses RLS).
-- Replace <FIRST_OPERATOR_USER_ID> with the tenant user id (internal.users.id /
-- the JWT 'sub') of the first '${firstRole}' — NOT a wallet address.
INSERT INTO ${table} (${userCol}, ${roleCol})
VALUES ('<FIRST_OPERATOR_USER_ID>', '${firstRole}')
ON CONFLICT (${userCol}) DO NOTHING;`;

  const text = [
    "## Role-gate scaffold",
    "",
    "**1. Migration** (apply once, or via your deploy spec's database migrations):",
    "```sql",
    migration,
    "```",
    "",
    "**2. `requireRole` gate** — put this on the function in your deploy spec (`spec.functions[].requireRole`):",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
    `**3. In the function:** \`await auth.requireRole(${JSON.stringify(firstRole)})\` — or \`await auth.role()\` to branch when \`allowed\` has multiple roles.`,
    "",
    "**4. First-operator bootstrap** (the table starts empty — grant the first role once with the service key):",
    "```sql",
    bootstrap,
    "```",
    "",
    "Notes:",
    "- `requireRole(x)` requires `x` to be in `allowed`; for multi-role gates read `auth.role()` and branch instead of re-asserting.",
    "- `cacheTtl` is the role-lookup cache in seconds; set it to `0` for instant revocation (fresh DB read per request).",
    "- The gate keys on the tenant **user id** (`internal.users.id` / JWT `sub`), NOT a wallet address.",
    `- The gate accepts any table/columns — \`${table}(${userCol}, ${roleCol})\` is the blessed default; point \`requireRole\` at your own table if you already have one.`,
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
