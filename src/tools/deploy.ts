import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError, projectNotFound } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { updateProject } from "../keystore.js";
import {
  PaymentRequired,
  Run402DeployError,
} from "../../sdk/dist/index.js";
import type {
  ContentSource,
  DeployEvent,
  ReleaseSpec,
} from "../../sdk/dist/index.js";

/**
 * MCP `deploy` tool — exposes the unified `r.deploy.apply` primitive.
 *
 * The Zod schema mirrors `ReleaseSpec` but constrains byte sources to
 * `{ data: string, encoding?: "utf-8" | "base64" }` (the same shape used
 * by the legacy `bundle_deploy`/`deploy_site` tools). Agents that want to
 * ship a real app via patch semantics, multi-resource atomicity, or the
 * resumable operation model use this tool; the legacy tools continue to
 * work and route through the same SDK shim under the hood.
 */

const fileEntry = z
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
  .strict();

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
      set: z.record(z.object({ value: z.string() }).strict()).optional(),
      delete: z.array(z.string()).optional(),
      replace_all: z.record(z.object({ value: z.string() }).strict()).optional(),
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
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client idempotency key. Combined with the project id and gateway-computed manifest digest to deduplicate retries.",
    ),
};

type FileEntryInput = z.infer<typeof fileEntry>;
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
  idempotency_key?: string;
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
  try {
    spec = translateMcpToReleaseSpec(args);
  } catch (err) {
    return mapSdkError(err, "validating deploy spec");
  }

  try {
    const result = await getSdk().deploy.apply(spec, {
      onEvent,
      idempotencyKey: args.idempotency_key,
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
        `**Code:** \`${err.code}\``,
      ];
      if (err.phase) lines.push(`**Phase:** \`${err.phase}\``);
      if (err.resource) lines.push(`**Resource:** \`${err.resource}\``);
      lines.push(`**Retryable:** ${err.retryable}`);
      if (err.operationId) lines.push(`**Operation:** \`${err.operationId}\``);
      if (err.planId) lines.push(`**Plan:** \`${err.planId}\``);
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

function renderEventsBlock(events: DeployEvent[]): string {
  return [
    `### Progress events`,
    ``,
    "```json",
    JSON.stringify(events, null, 2),
    "```",
  ].join("\n");
}

// ─── MCP → ReleaseSpec translator ────────────────────────────────────────────

function translateMcpToReleaseSpec(args: DeployArgs): ReleaseSpec {
  const spec: ReleaseSpec = { project: args.project_id };
  if (args.base) spec.base = args.base;
  if (args.subdomains) spec.subdomains = args.subdomains;
  if (args.secrets) spec.secrets = args.secrets;

  if (args.database) {
    spec.database = {};
    if (args.database.expose) spec.database.expose = args.database.expose;
    if (args.database.zero_downtime !== undefined) {
      spec.database.zero_downtime = args.database.zero_downtime;
    }
    if (args.database.migrations && args.database.migrations.length > 0) {
      spec.database.migrations = args.database.migrations.map((m) => ({
        id: m.id,
        ...(m.sql !== undefined ? { sql: m.sql } : {}),
        ...(m.sql_ref ? { sql_ref: m.sql_ref } : {}),
        ...(m.checksum ? { checksum: m.checksum } : {}),
        ...(m.transaction ? { transaction: m.transaction } : {}),
      }));
    }
  }

  if (args.functions) {
    spec.functions = {};
    if (args.functions.replace) {
      spec.functions.replace = mapFunctions(args.functions.replace);
    }
    if (args.functions.patch) {
      spec.functions.patch = {};
      if (args.functions.patch.set) {
        spec.functions.patch.set = mapFunctions(args.functions.patch.set);
      }
      if (args.functions.patch.delete) {
        spec.functions.patch.delete = args.functions.patch.delete;
      }
    }
  }

  if (args.site) {
    if ("replace" in args.site) {
      spec.site = { replace: mapFiles(args.site.replace) };
    } else if ("patch" in args.site) {
      const patch: { put?: Record<string, ContentSource>; delete?: string[] } = {};
      if (args.site.patch.put) patch.put = mapFiles(args.site.patch.put);
      if (args.site.patch.delete) patch.delete = args.site.patch.delete;
      spec.site = { patch };
    }
  }

  return spec;
}

function mapFunctions(
  map: Record<string, FunctionSpecInput>,
): Record<string, NonNullable<ReleaseSpec["functions"]>["replace"] extends Record<string, infer F> ? F : never> {
  const out: Record<string, ReturnType<typeof mapFunction>> = {};
  for (const [name, fn] of Object.entries(map)) {
    out[name] = mapFunction(fn);
  }
  return out as never;
}

function mapFunction(fn: FunctionSpecInput): {
  runtime?: "node22";
  source?: ContentSource;
  files?: Record<string, ContentSource>;
  entrypoint?: string;
  config?: { timeoutSeconds?: number; memoryMb?: number };
  schedule?: string | null;
} {
  const out: ReturnType<typeof mapFunction> = {};
  if (fn.runtime) out.runtime = fn.runtime;
  if (fn.source) out.source = fileEntryToContentSource(fn.source);
  if (fn.files) out.files = mapFiles(fn.files);
  if (fn.entrypoint) out.entrypoint = fn.entrypoint;
  if (fn.config) out.config = fn.config;
  if (fn.schedule !== undefined) out.schedule = fn.schedule;
  return out;
}

function mapFiles(map: FileMapInput): Record<string, ContentSource> {
  const out: Record<string, ContentSource> = {};
  for (const [path, entry] of Object.entries(map)) {
    out[path] = fileEntryToContentSource(entry);
  }
  return out;
}

function fileEntryToContentSource(entry: FileEntryInput): ContentSource {
  if (entry.encoding === "base64") {
    const bytes = base64ToBytes(entry.data);
    return entry.contentType ? { data: bytes, contentType: entry.contentType } : bytes;
  }
  // utf-8 (default)
  return entry.contentType ? { data: entry.data, contentType: entry.contentType } : entry.data;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
