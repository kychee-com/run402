import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import {
  importArchiveToCore,
  inspectArchive,
  verifyArchive,
} from "../../sdk/dist/node/index.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const exportProjectArchiveSchema = {
  project_id: z.string().describe("Project ID to export from Run402 Cloud."),
  output_path: z
    .string()
    .optional()
    .describe("Optional local file path for the downloaded .r402ar archive. When set, the tool waits for readiness and writes bytes here."),
  scope: z.literal("portable-runtime-v1").optional().describe("Archive scope. v1 supports portable-runtime-v1."),
  auth: z.enum(["stubs", "none"]).optional().describe("Auth export mode. Default stubs; credentials are never exported."),
  consistency: z
    .enum(["pause-writes", "cloud_write_pause_v1"])
    .optional()
    .describe("Consistency mode. Default pause-writes, recorded as cloud_write_pause_v1."),
  idempotency_key: z.string().optional().describe("Retry-safe idempotency key for archive creation."),
  wait: z.boolean().optional().describe("Poll until ready. Defaults true when output_path is set, otherwise false."),
  poll_interval_ms: z.number().int().positive().optional().describe("Polling interval in milliseconds. Default 1000."),
  timeout_ms: z.number().int().positive().optional().describe("Wait timeout in milliseconds. Default 600000."),
};

export const inspectProjectArchiveSchema = {
  archive_path: z.string().describe("Local archive directory or .r402ar tar path."),
};

export const verifyProjectArchiveSchema = {
  archive_path: z.string().describe("Local archive directory or .r402ar tar path."),
};

export const importProjectArchiveSchema = {
  archive_path: z.string().describe("Local archive directory or .r402ar tar path."),
  name: z.string().optional().describe("New Core project name. Default imported-project."),
  env_file: z.string().optional().describe("Env file containing required secret values."),
  secret_values: z.record(z.string()).optional().describe("Explicit secret values. Overrides env_file entries for duplicate names."),
  core_url: z.string().optional().describe("Core gateway URL. Default RUN402_CORE_URL or http://127.0.0.1:4020."),
  dry_run: z.boolean().optional().describe("Verify and plan without creating a project."),
  require_runnable: z.boolean().optional().describe("Block import unless required secret values are supplied."),
};

export async function handleExportProjectArchive(args: {
  project_id: string;
  output_path?: string;
  scope?: "portable-runtime-v1";
  auth?: "stubs" | "none";
  consistency?: "pause-writes" | "cloud_write_pause_v1";
  idempotency_key?: string;
  wait?: boolean;
  poll_interval_ms?: number;
  timeout_ms?: number;
}): Promise<ToolResult> {
  try {
    const sdk = getSdk();
    const created = await sdk.archives.create(args.project_id, {
      scope: args.scope,
      auth: args.auth,
      consistency: args.consistency,
      idempotencyKey: args.idempotency_key,
    });
    const shouldWait = args.wait ?? Boolean(args.output_path);
    const archive = shouldWait && created.status !== "ready"
      ? await sdk.archives.wait(args.project_id, created.archive_id, {
          pollIntervalMs: args.poll_interval_ms,
          timeoutMs: args.timeout_ms,
        })
      : created;

    let outputPath: string | null = null;
    let bytesWritten = 0;
    if (args.output_path && archive.status === "ready") {
      const download = await sdk.archives.download(args.project_id, archive.archive_id);
      outputPath = resolve(args.output_path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, download.bytes);
      bytesWritten = download.bytes.byteLength;
    }

    const result = {
      status: archive.status === "ready" ? "ok" : archive.status,
      project_id: args.project_id,
      archive_id: archive.archive_id,
      output_path: outputPath,
      bytes_written: bytesWritten,
      sha256: archive.sha256,
      verify_command: outputPath ? `run402 archives verify ${JSON.stringify(outputPath)} --json` : null,
      import_command: outputPath ? `run402 core projects import ${JSON.stringify(outputPath)} --name imported-project --env-file ./required.env --json` : null,
      next_action: archive.next_action,
      archive,
    };
    return jsonToolResult("Project Archive Export", result, archive.status !== "ready");
  } catch (err) {
    return mapSdkError(err, "exporting project archive");
  }
}

export async function handleInspectProjectArchive(args: { archive_path: string }): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Archive Inspect", await inspectArchive(args.archive_path));
  } catch (err) {
    return mapSdkError(err, "inspecting project archive");
  }
}

export async function handleVerifyProjectArchive(args: { archive_path: string }): Promise<ToolResult> {
  try {
    const result = await verifyArchive(args.archive_path);
    return jsonToolResult("Project Archive Verify", result, !result.ok);
  } catch (err) {
    return mapSdkError(err, "verifying project archive");
  }
}

export async function handleImportProjectArchive(args: {
  archive_path: string;
  name?: string;
  env_file?: string;
  secret_values?: Record<string, string>;
  core_url?: string;
  dry_run?: boolean;
  require_runnable?: boolean;
}): Promise<ToolResult> {
  try {
    const result = await importArchiveToCore({
      archivePath: args.archive_path,
      name: args.name,
      envFile: args.env_file,
      secretValues: args.secret_values,
      coreUrl: args.core_url,
      dryRun: args.dry_run,
      requireRunnable: args.require_runnable,
    });
    return jsonToolResult("Project Archive Import", result, result.status !== "imported" && result.status !== "dry_run");
  } catch (err) {
    return mapSdkError(err, "importing project archive");
  }
}

function jsonToolResult(title: string, value: unknown, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n"),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
