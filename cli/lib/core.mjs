import { importArchiveToCore } from "#sdk/node";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, hasHelp, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 core — Local Run402 Core commands

Usage:
  run402 core projects import <archive-path> --name <project-name> [options]

Options:
  --name <name>             New Core project name (default imported-project)
  --env-file <path>         Env file satisfying required archive secrets.
  --secret KEY=VALUE        Inline secret value; repeatable. Overrides --env-file.
  --core-url <url>          Core gateway URL (default RUN402_CORE_URL or http://127.0.0.1:4020)
  --dry-run                 Verify and plan without creating a Core project.
  --require-runnable        Block import unless required secrets are supplied.
  --json                    Emit final JSON.
  --json-stream             Emit NDJSON progress events and final result event.
`;

const FLAG_VALUES = ["--name", "--env-file", "--secret", "--core-url"];
const FLAGS = new Set([...FLAG_VALUES, "--dry-run", "--require-runnable", "--json", "--json-stream", "--help", "-h"]);

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (hasHelp(all)) {
    console.log(HELP);
    return;
  }
  if (sub !== "projects") {
    fail({ code: "BAD_USAGE", message: "Usage: run402 core projects import <archive-path> [options]" });
  }
  const action = args[0];
  if (action === "import") return importProject(args.slice(1));
  fail({ code: "BAD_USAGE", message: "Usage: run402 core projects import <archive-path> [options]" });
}

async function importProject(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, [...FLAGS], FLAG_VALUES);
  const archivePath = positionalArgs(args, FLAG_VALUES)[0];
  if (!archivePath) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 core projects import <archive-path> --name <project-name> [options]" });
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
      console.log(JSON.stringify({ status: result.status === "imported" || result.status === "dry_run" ? "ok" : "error", import: result }, null, 2));
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
