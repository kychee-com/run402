import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { importArchiveToCore, inspectArchive, verifyArchive } from "#sdk/node";
import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, hasHelp, normalizeArgv, parseIntegerFlag, positionalArgs, resolveProjectSelector, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 archives — portable Run402 project archives

Usage:
  run402 archives create   [<project_id>] [--project <project_id>] [--target cloud] [options]
  run402 archives status   [<project_id>] <archive_id> [--project <project_id>] [--target cloud] [--json]
  run402 archives download [<project_id>] <archive_id> --output <file> [--project <project_id>] [--target cloud] [--json]
  run402 archives inspect  <archive_path> [--json]
  run402 archives verify   <archive_path> [--json]
  run402 archives import   <archive_path> --name <project_name> [--target core] [options]

--target names the Run402 deployment the command talks to: create, status, and
download export from Run402 Cloud (--target cloud, the default); import loads an
archive into a local Run402 Core (--target core, the default). inspect and verify
are local and offline and take no target. A leading prj_... positional selects
the project; --project defaults to the active project.

Canonical agent path:
  run402 archives create <project_id> --target cloud \\
    --scope portable-runtime-v1 --auth stubs --consistency pause-writes \\
    --wait --output ./project.r402ar --json
  run402 archives verify ./project.r402ar --json
  run402 archives import ./project.r402ar --target core --name imported-project --env-file ./required.env --json

Options for create:
  --scope <scope>          Archive scope. v1 supports portable-runtime-v1.
  --auth <mode>            Auth export mode: stubs (default) or none.
  --consistency <mode>     pause-writes (default) or cloud_write_pause_v1.
  --idempotency-key <key>  Retry-safe creation key.
  --wait                   Poll until the archive is ready.
  --output <file>          Save archive bytes. Implies --wait.
  --poll-interval <ms>     Poll interval while waiting (default 1000).
  --timeout <ms>           Wait timeout (default 600000).
  --json                   Emit final JSON on stdout.
  --json-stream            Emit NDJSON progress events on stdout.

Options for import:
  --name <name>             New Core project name (default imported-project)
  --env-file <path>         Env file satisfying required archive secrets.
  --secret KEY=VALUE        Inline secret value; repeatable. Overrides --env-file.
  --core-url <url>          Core gateway URL (default RUN402_CORE_URL or http://127.0.0.1:4020)
  --dry-run                 Verify and plan without creating a Core project.
  --require-runnable        Block import unless required secrets are supplied.
  --json                    Emit final JSON.
  --json-stream             Emit NDJSON progress events and final result event.

Notes:
  - Verification is local and offline. It does not require Cloud credentials.
  - Archives are untrusted input; verify checks integrity and compatibility, not trust.
`;

const TARGETS = ["cloud", "core"];

/**
 * Read --target and require the one deployment kind this verb talks to:
 * Run402 Cloud exports archives, Run402 Core imports them.
 */
function requireTarget(args, verb, expected) {
  const target = flagValue(args, "--target") ?? expected;
  assertAllowedValue(target, TARGETS, "--target");
  if (target !== expected) {
    fail({
      code: "BAD_FLAG",
      message: `archives ${verb} runs against --target ${expected}; --target ${target} does not ${expected === "cloud" ? "export archives" : "import archives"}.`,
      details: { flag: "--target", value: target, expected },
      hint: expected === "cloud"
        ? "Export with --target cloud, then load the file with: run402 archives import <archive_path> --target core"
        : "Import into Run402 Core with --target core; export from Run402 Cloud with: run402 archives create --target cloud",
    });
  }
  return target;
}

const CREATE_FLAG_VALUES = [
  "--project",
  "--target",
  "--scope",
  "--auth",
  "--consistency",
  "--idempotency-key",
  "--output",
  "--poll-interval",
  "--timeout",
];
const CREATE_FLAGS = new Set([
  ...CREATE_FLAG_VALUES,
  "--wait",
  "--json",
  "--json-stream",
  "--help",
  "-h",
]);

const IMPORT_FLAG_VALUES = ["--target", "--name", "--env-file", "--secret", "--core-url"];
const IMPORT_FLAGS = new Set([...IMPORT_FLAG_VALUES, "--dry-run", "--require-runnable", "--json", "--json-stream", "--help", "-h"]);

export async function run(sub, rawArgs = []) {
  const all = [sub, ...rawArgs].filter(Boolean);
  if (hasHelp(all)) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "create": return create(rawArgs);
    case "status": return status(rawArgs);
    case "download": return download(rawArgs);
    case "inspect": return inspect(rawArgs);
    case "verify": return verify(rawArgs);
    case "import": return importProject(rawArgs);
    default:
      failUnknownSubcommand("archives", sub);
  }
}

async function create(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, [...CREATE_FLAGS], CREATE_FLAG_VALUES);
  requireTarget(args, "create", "cloud");
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: CREATE_FLAG_VALUES });
  const extraPos = positionalArgs(rest, CREATE_FLAG_VALUES);
  if (extraPos.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for archives create: ${extraPos[0]}` });
  }
  const scope = flagValue(args, "--scope") ?? "portable-runtime-v1";
  const auth = flagValue(args, "--auth") ?? "stubs";
  const consistency = flagValue(args, "--consistency") ?? "pause-writes";
  assertAllowedValue(scope, ["portable-runtime-v1"], "--scope");
  assertAllowedValue(auth, ["stubs", "none"], "--auth");
  assertAllowedValue(consistency, ["pause-writes", "cloud_write_pause_v1"], "--consistency");

  const output = flagValue(args, "--output");
  const wait = args.includes("--wait") || Boolean(output);
  const jsonStream = args.includes("--json-stream");
  const idempotencyKey = flagValue(args, "--idempotency-key") ?? undefined;
  const pollIntervalMs = parseIntegerFlag("--poll-interval", flagValue(args, "--poll-interval"), { min: 100, def: 1000 });
  const timeoutMs = parseIntegerFlag("--timeout", flagValue(args, "--timeout"), { min: 1000, def: 600000 });
  const emit = (event) => {
    if (jsonStream) console.log(JSON.stringify(event));
  };

  try {
    const sdk = getSdk();
    const created = await sdk.archives.create(projectId, {
      scope,
      auth,
      consistency,
      idempotencyKey,
    });
    emit(progressEvent("archive_export_created", "create", projectId, created));

    let archive = created;
    let outputPath = null;
    let bytesWritten = 0;
    if (wait) {
      archive = created.status === "ready"
        ? created
        : await sdk.archives.wait(projectId, created.archive_id, {
            pollIntervalMs,
            timeoutMs,
            onProgress: emit,
          });
      if (archive.status !== "ready") {
        const result = finalCreateResult({ projectId, created, archive, outputPath, bytesWritten });
        printJson(result, jsonStream);
        process.exit(1);
      }
      if (output) {
        const download = await sdk.archives.download(projectId, archive.archive_id);
        outputPath = resolve(output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, download.bytes);
        bytesWritten = download.bytes.byteLength;
        emit({
          ...progressEvent("archive_export_downloaded", "download", projectId, archive),
          context: { output_path: outputPath, bytes_written: bytesWritten },
        });
      }
    }

    const result = finalCreateResult({ projectId, created, archive, outputPath, bytesWritten });
    if (jsonStream) {
      console.log(JSON.stringify({
        event: "archive_export_complete",
        stage: "complete",
        resource_type: "project_archive",
        resource_id: archive.archive_id,
        project_id: projectId,
        status: archive.status === "ready" ? "complete" : archive.status,
        completed_units: archive.status === "ready" ? 1 : 0,
        total_units: 1,
        code: null,
        message: archive.status === "ready" ? "Archive export complete." : "Archive export did not complete.",
        next_action: archive.next_action,
        retryable: false,
        result,
      }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (archive.status !== "ready") process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}

async function download(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--project", "--target", "--output", "--json", "--help", "-h"], ["--project", "--target", "--output"]);
  requireTarget(args, "download", "cloud");
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: ["--project", "--target", "--output"] });
  const pos = positionalArgs(rest, ["--project", "--target", "--output"]);
  const [archiveId] = pos;
  const output = flagValue(args, "--output");
  if (!archiveId || pos.length > 1 || !output) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 archives download [<project_id>] <archive_id> --output <file> [--project <project_id>] [--target cloud] [--json]" });
  }
  try {
    const download = await getSdk().archives.download(projectId, archiveId);
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, download.bytes);
    console.log(JSON.stringify({
      ok: true,
      project_id: projectId,
      archive_id: archiveId,
      output_path: outputPath,
      bytes_written: download.bytes.byteLength,
      sha256: download.archive.sha256,
      verify_command: `run402 archives verify ${JSON.stringify(outputPath)} --json`,
      import_command: `run402 archives import ${JSON.stringify(outputPath)} --target core --name imported-project --env-file ./required.env --json`,
      archive: download.archive,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--project", "--target", "--json", "--help", "-h"], ["--project", "--target"]);
  requireTarget(args, "status", "cloud");
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: ["--project", "--target"] });
  const pos = positionalArgs(rest, ["--project", "--target"]);
  const [archiveId] = pos;
  if (!archiveId || pos.length > 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 archives status [<project_id>] <archive_id> [--project <project_id>] [--target cloud] [--json]" });
  }
  try {
    const archive = await getSdk().archives.get(projectId, archiveId);
    console.log(JSON.stringify({ archive }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function finalCreateResult({ projectId, created, archive, outputPath, bytesWritten }) {
  return {
    ok: archive.status === "ready",
    project_id: projectId,
    archive_id: archive.archive_id,
    operation_id: archive.operation_id,
    created_archive_id: created.archive_id,
    archive_status: archive.status,
    output_path: outputPath,
    bytes_written: bytesWritten,
    sha256: archive.sha256,
    byte_count: archive.byte_count,
    expires_at: archive.expires_at,
    verify_command: outputPath ? `run402 archives verify ${JSON.stringify(outputPath)} --json` : null,
    import_command: outputPath ? `run402 archives import ${JSON.stringify(outputPath)} --target core --name imported-project --env-file ./required.env --json` : null,
    next_action: archive.next_action,
    portability_report: archive.portability_report,
    export_report: archive.export_report,
    archive,
  };
}

function progressEvent(event, stage, projectId, archive) {
  return {
    event,
    stage,
    resource_type: "project_archive",
    resource_id: archive.archive_id,
    project_id: projectId,
    status: archive.status,
    completed_units: archive.status === "ready" || archive.status === "failed" || archive.status === "expired" ? 1 : 0,
    total_units: 1,
    code: archive.status === "failed" ? archive.error?.code ?? "ARCHIVE_EXPORT_FAILED" : null,
    message: `Archive export status: ${archive.status}`,
    next_action: archive.next_action,
    retryable: archive.status === "running",
  };
}

function printJson(result, alreadyStreamed) {
  if (!alreadyStreamed) console.log(JSON.stringify(result, null, 2));
}

async function inspect(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--json", "--help", "-h"], []);
  const archivePath = positionalArgs(args, [])[0];
  if (!archivePath) fail({ code: "BAD_USAGE", message: "Usage: run402 archives inspect <archive_path> [--json]" });
  try {
    const result = await inspectArchive(archivePath);
    console.log(JSON.stringify({ archive: result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function verify(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--json", "--help", "-h"], []);
  const archivePath = positionalArgs(args, [])[0];
  if (!archivePath) fail({ code: "BAD_USAGE", message: "Usage: run402 archives verify <archive_path> [--json]" });
  try {
    const result = await verifyArchive(archivePath);
    console.log(JSON.stringify({ ok: result.ok, verified: result.ok, archive: result }, null, 2));
    if (!result.ok) process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}

async function importProject(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, [...IMPORT_FLAGS], IMPORT_FLAG_VALUES);
  requireTarget(args, "import", "core");
  const archivePath = positionalArgs(args, IMPORT_FLAG_VALUES)[0];
  if (!archivePath) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 archives import <archive_path> --name <project_name> [--target core] [options]" });
  }
  const jsonStream = args.includes("--json-stream");
  const secretValues = parseSecrets(args);
  const name = flagValue(args, "--name") ?? "imported-project";
  const coreUrl = flagValue(args, "--core-url") ?? undefined;
  const startedEvent = {
    event: "core_archive_import_started",
    stage: "verify",
    resource_type: "project_archive",
    resource_id: archivePath,
    status: "running",
    completed_units: 0,
    total_units: 1,
    code: null,
    message: "Verifying archive locally before Core import.",
    next_action: { type: "none" },
    retryable: false,
    context: { archive_path: archivePath, core_url: coreUrl ?? null, project_name: name },
  };
  if (jsonStream) console.log(JSON.stringify(startedEvent));
  try {
    const result = await importArchiveToCore({
      archivePath,
      name,
      coreUrl,
      envFile: flagValue(args, "--env-file") ?? undefined,
      secretValues,
      dryRun: args.includes("--dry-run"),
      requireRunnable: args.includes("--require-runnable"),
    });
    if (jsonStream) {
      console.log(JSON.stringify({
        event: "core_archive_import_complete",
        stage: "complete",
        resource_type: "project_archive",
        resource_id: archivePath,
        status: result.status,
        completed_units: result.status === "imported" || result.status === "dry_run" ? 1 : 0,
        total_units: 1,
        code: firstDiagnosticCode(result),
        message: `Core archive import status: ${result.status}`,
        next_action: result.next_action,
        retryable: result.status === "failed" && result.diagnostics.some((d) => d.retryable),
        result,
      }));
    } else {
      console.log(JSON.stringify({ ok: result.status === "imported" || result.status === "dry_run", import: result }, null, 2));
    }
    if (result.status !== "imported" && result.status !== "dry_run") process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}

function parseSecrets(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--secret") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      fail({ code: "BAD_FLAG", message: "--secret requires KEY=VALUE" });
    }
    const eq = value.indexOf("=");
    if (eq <= 0) {
      fail({ code: "BAD_FLAG", message: "--secret requires KEY=VALUE", details: { value } });
    }
    const key = value.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail({ code: "BAD_FLAG", message: `Invalid secret env var name: ${key}` });
    }
    out[key] = value.slice(eq + 1);
    i += 1;
  }
  return out;
}

function firstDiagnosticCode(result) {
  return result.diagnostics.find((d) => d.severity === "blocking")?.code ?? null;
}
