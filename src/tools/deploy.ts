import { z } from "zod";
import { getSdk } from "../sdk.js";
import { formatCanonicalErrorContext, mapSdkError, projectNotFound } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { updateProject } from "../keystore.js";
import {
  PaymentRequired,
  ROUTE_HTTP_METHODS,
  Run402DeployError,
} from "../../sdk/dist/index.js";
import { normalizeDeployManifest } from "../../sdk/dist/node/index.js";
import type {
  DeployEvent,
  ReleaseSpec,
  RouteHttpMethod,
  WarningEntry,
} from "../../sdk/dist/index.js";

/**
 * MCP `deploy` tool — exposes the unified `r.deploy.apply` primitive.
 *
 * The Zod schema mirrors `ReleaseSpec` and accepts byte sources in either
 * shape: a bare UTF-8 string (the natural shape, e.g. `"<h1>hi</h1>"`) or
 * the `{ data, encoding?, contentType? }` object — the latter is required
 * for binary payloads via base64 or for explicit `contentType` override.
 * The SDK's `resolveContent` already accepts both polymorphically; this
 * schema mirrors that. Agents that want to ship a real app via patch
 * semantics, multi-resource atomicity, or the resumable operation model
 * use this tool.
 */

const fileEntry = z.union([
  z.string(),
  z
    .object({
      data: z.string(),
      encoding: z.enum(["utf-8", "base64"]).optional(),
      contentType: z
        .string()
        .optional()
        .describe(
          "MIME type override. Auto-detected from the path's extension when omitted.",
        ),
    })
    .strict(),
]);

const fileMap = z.record(fileEntry);

const migrationEntry = z
  .object({
    id: z
      .string()
      .describe(
        "Stable migration id (e.g. '001_init'). Same id+checksum across re-deploys is a registry noop; same id+different checksum is a hard error.",
      ),
    sql: z.string().optional().describe("Inline SQL (UTF-8). Either sql or sql_ref is required."),
    sql_ref: z
      .object({
        sha256: z.string(),
        size: z.number(),
        contentType: z.string().optional(),
      })
      .optional()
      .describe("Pre-uploaded CAS reference. Mutually exclusive with sql."),
    checksum: z
      .string()
      .optional()
      .describe(
        "Lowercase hex SHA-256 of the migration SQL. Computed from `sql` if omitted.",
      ),
    transaction: z.enum(["required", "none"]).optional(),
  })
  .strict();

const functionSpec = z
  .object({
    runtime: z.literal("node22").optional(),
    source: fileEntry
      .optional()
      .describe(
        "Single-file function source. The SDK uploads it to CAS and references it in the release.",
      ),
    files: fileMap
      .optional()
      .describe(
        "Multi-file function. Provide `entrypoint` to designate the entry path.",
      ),
    entrypoint: z.string().optional(),
    config: z
      .object({
        timeoutSeconds: z.number().optional(),
        memoryMb: z.number().optional(),
      })
      .optional(),
    schedule: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Cron expression (5-field). Pass null to remove an existing schedule; omit in patch mode to leave it unchanged.",
      ),
  })
  .strict();

const functionMap = z.record(functionSpec);
const routeMethod = z.enum(
  ROUTE_HTTP_METHODS as unknown as [RouteHttpMethod, ...RouteHttpMethod[]],
);
const functionRouteTarget = z
  .object({
    type: z.literal("function"),
    name: z
      .string()
      .describe("Materialized release function name, not a file name or handler export."),
  })
  .strict();
const staticRouteTarget = z
  .object({
    type: z.literal("static"),
    file: z
      .string()
      .describe("Materialized static-site file path, relative to the site root. No leading slash, query, fragment, traversal, or directory shorthand."),
  })
  .strict();
const routeTarget = z.union([functionRouteTarget, staticRouteTarget]);
const routeEntry = z
  .object({
    pattern: z
      .string()
      .describe("Route pattern such as /api, /api/*, or /login. Prefix wildcards only use a final /*."),
    methods: z
      .array(routeMethod)
      .min(1)
      .optional()
      .describe("Optional method allowlist. Omit to allow all supported methods; do not pass an empty array."),
    target: routeTarget,
  })
  .strict();

export const deploySchema = {
  project_id: z
    .string()
    .describe("Project ID to deploy to (from provision)."),
  base: z
    .union([
      z.object({ release: z.enum(["current", "empty"]) }).strict(),
      z.object({ release_id: z.string() }).strict(),
    ])
    .optional()
    .describe(
      "Diff base. Default `{ release: 'current' }`. Use `{ release: 'empty' }` for a fresh deploy that fails if a release already exists.",
    ),
  database: z
    .object({
      migrations: z.array(migrationEntry).optional(),
      expose: z
        .record(z.unknown())
        .optional()
        .describe(
          "Declarative authorization manifest (see https://run402.com/schemas/manifest.v1.json).",
        ),
      zero_downtime: z
        .boolean()
        .optional()
        .describe(
          "Skip the migrate-gate phase. Only safe when migrations are declared backward-compatible.",
        ),
    })
    .strict()
    .optional(),
  secrets: z
    .object({
      require: z
        .array(z.string())
        .optional()
        .describe(
          "Secret keys that must already exist. Set values first with `set_secret`; never put secret values in deploy specs.",
        ),
      delete: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
  functions: z
    .object({
      replace: functionMap.optional(),
      patch: z
        .object({
          set: functionMap.optional(),
          delete: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  site: z
    .union([
      z.object({ replace: fileMap }).strict(),
      z
        .object({
          patch: z
            .object({
              put: fileMap.optional(),
              delete: z.array(z.string()).optional(),
            })
            .strict(),
        })
        .strict(),
    ])
    .optional(),
  subdomains: z
    .object({
      set: z.array(z.string()).optional(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    })
    .strict()
    .optional()
    .describe(
      "At most one subdomain per project — multi-element `set` is rejected with SUBDOMAIN_MULTI_NOT_SUPPORTED.",
    ),
  routes: z
    .union([
      z.null(),
      z.object({ replace: z.array(routeEntry) }).strict(),
    ])
    .optional()
    .describe(
      "Deploy-v2 web routes. Omit or pass null to carry forward base routes; pass { replace: [] } to clear routes; pass { replace: [{ pattern, methods?, target: { type: 'function', name } }] } for functions or exact GET/HEAD { target: { type: 'static', file } } entries for static route targets.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client idempotency key. Combined with the project id and gateway-computed manifest digest to deduplicate retries.",
    ),
  allow_warnings: z
    .boolean()
    .optional()
    .describe(
      "Continue past plan warnings that require confirmation. Default false: the tool stops before upload/commit so an agent can set missing secrets or inspect warnings.",
    ),
};

type FileMapInput = z.infer<typeof fileMap>;
type FunctionSpecInput = z.infer<typeof functionSpec>;
type DeployArgs = {
  project_id: string;
  base?: ReleaseSpec["base"];
  database?: {
    migrations?: Array<z.infer<typeof migrationEntry>>;
    expose?: Record<string, unknown>;
    zero_downtime?: boolean;
  };
  secrets?: ReleaseSpec["secrets"];
  functions?: {
    replace?: Record<string, FunctionSpecInput>;
    patch?: {
      set?: Record<string, FunctionSpecInput>;
      delete?: string[];
    };
  };
  site?:
    | { replace: FileMapInput }
    | { patch: { put?: FileMapInput; delete?: string[] } };
  subdomains?: ReleaseSpec["subdomains"];
  routes?: ReleaseSpec["routes"];
  idempotency_key?: string;
  allow_warnings?: boolean;
};

export async function handleDeploy(
  args: DeployArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!args.project_id) return projectNotFound("(none — project_id is required)");

  const auth = requireAllowanceAuth("/deploy/v2/plans");
  if ("error" in auth) return auth.error;

  const events: DeployEvent[] = [];
  const onEvent = (e: DeployEvent): void => {
    events.push(e);
  };

  let spec: ReleaseSpec;
  let idempotencyKey: string | undefined;
  try {
    const { allow_warnings: _allowWarnings, ...manifestArgs } = args;
    const normalized = await normalizeDeployManifest(manifestArgs);
    spec = normalized.spec;
    idempotencyKey = normalized.idempotencyKey;
  } catch (err) {
    return mapSdkError(err, "validating deploy spec");
  }

  try {
    const result = await getSdk().deploy.apply(spec, {
      onEvent,
      idempotencyKey,
      allowWarnings: args.allow_warnings === true,
    });

    if (result.urls.deployment_id) {
      updateProject(args.project_id, { last_deployment_id: result.urls.deployment_id });
    }

    const lines = [
      `## Release Activated`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| project_id | \`${args.project_id}\` |`,
      `| release_id | \`${result.release_id}\` |`,
      `| operation_id | \`${result.operation_id}\` |`,
    ];
    for (const [k, v] of Object.entries(result.urls)) {
      lines.push(`| ${k} | ${v} |`);
    }
    if (result.warnings.length > 0) {
      lines.push(``, renderWarningsMarkdown(result.warnings));
    }
    lines.push(
      ``,
      `### Raw Deploy Result`,
      ``,
      "```json",
      JSON.stringify(result, null, 2),
      "```",
    );

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: renderEventsBlock(events) },
      ],
    };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text",
            text:
              `## Payment Required\n\nThis deploy requires payment (project lease renewal or x402 quote).\n\n` +
              "```json\n" +
              JSON.stringify(body, null, 2) +
              "\n```\n\n" +
              "Resolve payment via the project's allowance and retry this tool call.",
          },
        ],
      };
    }
    if (err instanceof Run402DeployError) {
      const lines = [
        `## Deploy Failed`,
        ``,
        ...formatCanonicalErrorContext(err, { includeDetails: true }),
      ];
      if (err.phase) lines.push(`**Phase:** \`${err.phase}\``);
      if (err.resource) lines.push(`**Resource:** \`${err.resource}\``);
      if (err.operationId) lines.push(`**Operation:** \`${err.operationId}\``);
      if (err.planId) lines.push(`**Plan:** \`${err.planId}\``);
      const warnings = warningsFromDeployError(err);
      if (warnings.length > 0) {
        lines.push(``, renderWarningsMarkdown(warnings));
      } else {
        const guidance = routeGuidanceMarkdownForCodes([err.code]);
        if (guidance) lines.push(``, guidance);
      }
      lines.push(``, err.message);
      if (err.fix) {
        lines.push(``, `**Suggested fix:**`);
        lines.push("```json", JSON.stringify(err.fix, null, 2), "```");
      }
      if (err.logs && err.logs.length > 0) {
        lines.push(``, `**Logs:**`);
        lines.push("```", ...err.logs.slice(0, 50), "```");
      }
      const out: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: true,
      };
      if (events.length > 0) {
        out.content.push({ type: "text", text: renderEventsBlock(events) });
      }
      return out;
    }
    const errResp = mapSdkError(err, "deploying release");
    if (events.length > 0) {
      errResp.content.push({ type: "text", text: renderEventsBlock(events) });
    }
    return errResp;
  }
}

function warningsFromDeployError(err: Run402DeployError): WarningEntry[] {
  const body = err.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const warnings = (body as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings as WarningEntry[] : [];
}

function renderWarningsMarkdown(warnings: WarningEntry[]): string {
  const lines = [`### Plan warnings`];
  for (const warning of warnings) {
    const affected = warning.affected && warning.affected.length > 0
      ? ` (${warning.affected.map((item: string) => `\`${item}\``).join(", ")})`
      : "";
    lines.push(
      `- **${warning.code}** [${warning.severity}]${affected}: ${warning.message}`,
    );
  }
  if (warnings.some((w) => w.code === "MISSING_REQUIRED_SECRET")) {
    const keys = Array.from(new Set(warnings.flatMap((w) => w.affected ?? [])));
    const suffix = keys.length > 0 ? ` for ${keys.map((k) => `\`${k}\``).join(", ")}` : "";
    lines.push(
      ``,
      `Set the missing secret value${keys.length === 1 ? "" : "s"}${suffix} with \`set_secret\`, then retry \`deploy\` with \`secrets.require\`.`,
    );
  } else if (warnings.some((w) => w.requires_confirmation)) {
    lines.push(
      ``,
      `Review these warnings before retrying with \`allow_warnings: true\`.`,
    );
  }
  const routeGuidance = routeWarningRows(warnings);
  if (routeGuidance.length > 0) {
    lines.push(``, routeGuidanceTable(routeGuidance));
  }
  return lines.join("\n");
}

const ROUTE_WARNING_GUIDANCE: Record<string, { meaning: string; recovery: string }> = {
  PUBLIC_ROUTED_FUNCTION: {
    meaning: "A route makes the target function public same-origin browser ingress.",
    recovery: "Review app auth, CSRF protection for cookie-authenticated unsafe methods, and CORS/OPTIONS behavior in the Node 22 Fetch Request -> Response handler; direct /functions/v1/:name remains API-key protected. Retry with allow_warnings only after that review.",
  },
  ROUTE_TARGET_CARRIED_FORWARD: {
    meaning: "A carried-forward route still points at a function from the base release.",
    recovery: "Inspect the active release routes and deploy a replacement route table if the target should change.",
  },
  ROUTE_SHADOWS_STATIC_PATH: {
    meaning: "A dynamic route takes precedence over a static path.",
    recovery: "Inspect the affected warning details and active release routes; confirm only when intentional.",
  },
  WILDCARD_ROUTE_SHADOWS_STATIC_PATHS: {
    meaning: "A prefix wildcard route shadows one or more static paths.",
    recovery: "Review affected paths, split exact routes if needed, and confirm only when intentional.",
  },
  METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK: {
    meaning: "A method-specific route leaves GET/HEAD static fallback available.",
    recovery: "Confirm that static fallback for unmatched methods is intended.",
  },
  WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS: {
    meaning: "A wildcard function route only allows GET/HEAD.",
    recovery: "Add the mutation methods the function supports, omit methods for an API prefix that should accept all supported methods, or retry with allow_warnings only when the prefix is intentionally read-only.",
  },
  ROUTE_TABLE_NEAR_LIMIT: {
    meaning: "The route table is close to the project or gateway limit.",
    recovery: "Consolidate route patterns or remove stale routes before adding more.",
  },
  ROUTES_NOT_ENABLED: {
    meaning: "Deploy-v2 web routes are not enabled for this project or environment.",
    recovery: "Deploy without routes or request enablement. Direct /functions/v1/:name remains protected and is not a browser-route substitute.",
  },
  STATIC_ALIAS_SHADOWS_STATIC_PATH: {
    meaning: "A static route target shadows a direct static path at the same public URL.",
    recovery: "Inspect the route pattern, target file, direct static path, and active release routes; confirm only when the static route target is intentional.",
  },
  STATIC_ALIAS_RELATIVE_ASSET_RISK: {
    meaning: "Relative asset URLs inside the target HTML may resolve differently at the static route target URL.",
    recovery: "Inspect the target HTML for relative assets and confirm only when the alternate public URL is intentional.",
  },
  STATIC_ALIAS_DUPLICATE_CANONICAL_URL: {
    meaning: "Both the static route target URL and the target file URL may be reachable.",
    recovery: "Decide which URL should be canonical, update links/canonical tags if needed, and confirm only when duplicate reachability is intended.",
  },
  STATIC_ALIAS_EXTENSIONLESS_NON_HTML: {
    meaning: "An extensionless static route target points at a non-HTML file.",
    recovery: "Check the target content type and prefer extensionless static route targets for HTML pages.",
  },
  STATIC_ALIAS_TABLE_NEAR_LIMIT: {
    meaning: "Static route targets count toward the route table limit.",
    recovery: "Consolidate manual static route targets and avoid one entry per page for large sites until framework-scale Web Output support exists.",
  },
  CI_ROUTE_SCOPE_DENIED: {
    meaning: "The CI binding does not cover one or more route declarations in this deploy.",
    recovery: "Re-link the GitHub Actions binding with exact scopes like /admin or prefix scopes like /api/*, or run the route-changing deploy locally.",
  },
};

function routeWarningRows(warnings: WarningEntry[]): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const warning of warnings) {
    const guidance = ROUTE_WARNING_GUIDANCE[warning.code];
    if (!guidance || seen.has(warning.code)) continue;
    seen.add(warning.code);
    rows.push(`| \`${warning.code}\` | ${guidance.meaning} | ${guidance.recovery} |`);
  }
  return rows;
}

function routeGuidanceMarkdownForCodes(codes: string[]): string | null {
  const rows: string[] = [];
  for (const code of codes) {
    const guidance = ROUTE_WARNING_GUIDANCE[code];
    if (!guidance) continue;
    rows.push(`| \`${code}\` | ${guidance.meaning} | ${guidance.recovery} |`);
  }
  return rows.length > 0 ? routeGuidanceTable(rows) : null;
}

function routeGuidanceTable(rows: string[]): string {
  return [
    `### Route warning guidance`,
    ``,
    `| Code | Meaning | Recovery |`,
    `|------|---------|----------|`,
    ...rows,
  ].join("\n");
}

function renderEventsBlock(events: DeployEvent[]): string {
  return [
    `### Progress events`,
    ``,
    "```json",
    JSON.stringify(events, null, 2),
    "```",
  ].join("\n");
}
