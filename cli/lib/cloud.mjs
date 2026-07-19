import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, hasHelp, normalizeArgv, parseIntegerFlag, positionalArgs, resolveProjectSelector } from "./argparse.mjs";

const HELP = `run402 cloud — Run402 Cloud portability commands

Usage:
  run402 cloud archives create [--project <id>] [options]
  run402 cloud archives download <archive-id> --output <file> [--project <id>] [--json]
  run402 cloud archives status <archive-id> [--project <id>] [--json]

Legacy (still supported): a leading prj_... positional selects the project,
e.g. run402 cloud archives download <project-id> <archive-id> --output <file>.
--project defaults to the active project.

Canonical agent path:
  run402 cloud archives create prj_... \\
    --scope portable-runtime-v1 --auth stubs --consistency pause-writes \\
    --wait --output ./project.r402ar --json

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
`;

const FLAG_VALUES = [
  "--project",
  "--scope",
  "--auth",
  "--consistency",
  "--idempotency-key",
  "--output",
  "--poll-interval",
  "--timeout",
];
const FLAGS = new Set([
  ...FLAG_VALUES,
  "--wait",
  "--json",
  "--json-stream",
  "--help",
  "-h",
]);

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (hasHelp(all)) {
    console.log(HELP);
    return;
  }
  if (sub !== "archives") {
    fail({
      code: "UNKNOWN_SUBCOMMAND",
      message: `Unknown cloud subcommand: ${sub}`,
      hint: "Run `run402 cloud --help` for usage.",
      details: { command: "cloud", subcommand: sub },
      next_actions: [{ type: "run_command", command: "run402 cloud archives --help" }],
    });
  }
  const action = args[0];
  const rest = args.slice(1);
  if (action === "create") return create(rest);
  if (action === "download") return download(rest);
  if (action === "status") return status(rest);
  fail({
    code: "UNKNOWN_SUBCOMMAND",
    message: `Unknown cloud archives subcommand: ${action}`,
    hint: "Run `run402 cloud archives --help` for usage.",
    details: { command: "cloud archives", subcommand: action },
    next_actions: [{ type: "run_command", command: "run402 cloud archives --help" }],
  });
}

async function create(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, [...FLAGS], FLAG_VALUES);
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: FLAG_VALUES });
  const extraPos = positionalArgs(rest, FLAG_VALUES);
  if (extraPos.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for cloud archives create: ${extraPos[0]}` });
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
  const json = args.includes("--json") || jsonStream || true;
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
    } else if (json) {
      console.log(JSON.stringify(result, null, 2));
    }
    if (archive.status !== "ready") process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}

async function download(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--project", "--output", "--json", "--help", "-h"], ["--project", "--output"]);
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: ["--project", "--output"] });
  const pos = positionalArgs(rest, ["--project", "--output"]);
  const [archiveId] = pos;
  const output = flagValue(args, "--output");
  if (!archiveId || pos.length > 1 || !output) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 cloud archives download <archive-id> --output <file> [--project <id>] [--json]" });
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
      import_command: `run402 core projects import ${JSON.stringify(outputPath)} --name imported-project --env-file ./required.env --json`,
      archive: download.archive,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--project", "--json", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(args, { valueFlags: ["--project"] });
  const pos = positionalArgs(rest, ["--project"]);
  const [archiveId] = pos;
  if (!archiveId || pos.length > 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 cloud archives status <archive-id> [--project <id>] [--json]" });
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
    import_command: outputPath ? `run402 core projects import ${JSON.stringify(outputPath)} --name imported-project --env-file ./required.env --json` : null,
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
