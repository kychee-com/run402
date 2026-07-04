import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";
import { createUpdateCheckScheduler, emitUpdateNotice } from "./update-check.mjs";

const HELP = `run402 up — Provision/link/deploy the current app

Usage:
  run402 up [repo-or-path] [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <tier>] [-y|--yes] [--check|--print-spec|--plan|--require-plan <id>] [--human|--json-stream] [--quiet]
  run402 up verify [repo-or-path] [--project <id>] [--manifest <path>] [--dir <path>] [--human|--json-stream]

Options:
  repo-or-path        Local app directory or public Git repository URL. Defaults
                      to the current directory.
  --name <name>       Project display name when up needs to create a project.
                      Not a deploy manifest field and never renames a project.
  --project <id>      Explicit project id. Highest-priority project selector.
  --manifest <path>   Manifest path. Defaults to run402.json, then
                      run402.deploy.json, then app.json in --dir/current directory.
  --dir <path>        Workspace directory to inspect (default: current dir).
  --tier <tier>       Bootstrap tier if no active Cloud tier exists
                      (prototype, hobby, team; default prototype).
  -y, --yes           Approve recursive prerequisites/local writes (allowance,
                      tier, project creation, workspace link) for non-interactive runs.
  --check             Validate the manifest/config locally. No gateway calls,
                      uploads, or local writes.
  --print-spec        Print the normalized ReleaseSpec JSON. No gateway calls,
                      uploads, or local writes.
  --plan              Ask the gateway for a reviewed deploy plan. No upload,
                      commit, project provisioning, or workspace link write.
  --require-plan <id> Apply only if this reviewed plan still matches.
  --plan-fingerprint <fingerprint>
                      Optional fingerprint returned by --plan. Only valid
                      with --require-plan.
  --allow-warning <code>
                      Acknowledge a reviewed deploy warning code (repeatable).
  --allow-warnings    Acknowledge all reviewed deploy warnings.
  --allow-prune       Approve destructive managed-resource prune steps for app manifests.
  --max-spend-usd <n> Maximum spend up may approve for app readiness.
  --build-mode <mode> Override app build mode: local, remote, or sandbox.
  --allow-shell-build Approve shell-string build commands in run402.json.
  --propagation-budget-s <n>
                      Maximum wall-clock seconds to wait for fresh edge
                      propagation during app HTTP verification (default 120).
  --no-propagation-wait
                      Return propagation_pending immediately when the edge is
                      still settling.
  --json              Emit one final JSON object on stdout (default; compatibility no-op).
  --human             Emit the legacy human success/blocking summary on stdout.
  --json-stream       Emit NDJSON progress events on stdout and a final result event.
  --quiet             Suppress action progress events on stderr.

Update notices:
  Stale CLI notices are advisory and never change the result payload or exit
  code. Non-streaming notices are JSON on stderr; --json-stream emits
  cli.update_available as an NDJSON event.

Project resolution:
  explicit --project > .run402/project.json > manifest project_id > approved
  project creation from --name > approved active-project fallback.

Examples:
  run402 up https://github.com/kychee-com/kysigned --name kysigned2 --yes --json
  run402 up --name my-app -y
  run402 up verify
  run402 up --manifest run402.deploy.ts --check
  run402 up --manifest run402.deploy.ts --plan
  run402 up --manifest run402.deploy.ts --require-plan pln_...
`;

const VERIFY_HELP = `run402 up verify — Rerun app manifest HTTP verification

Usage:
  run402 up verify [repo-or-path] [--project <id>] [--manifest <path>] [--dir <path>] [--name <name>] [--human|--json-stream]

Options:
  repo-or-path        Local app directory or public Git repository URL. Defaults
                      to the current directory.
  --project <id>      Existing project id. Defaults to .run402/project.json,
                      run402.json project.id, then active project.
  --manifest <path>   App manifest path. Defaults to run402.json.
  --dir <path>        Workspace directory to inspect (default: current dir).
  --name <name>       Instance name used only to materialize templated public origins.
  --propagation-budget-s <n>
                      Maximum wall-clock seconds to wait for fresh edge
                      propagation (default 120).
  --no-propagation-wait
                      Return propagation_pending immediately when the edge is
                      still settling.
  --json              Emit one final JSON object on stdout (default).
  --human             Emit a compact human verification summary on stdout.
  --json-stream       Emit NDJSON progress events on stdout and a final result event.
  --quiet             Suppress action progress events on stderr.
`;

const TIERS = new Set(["prototype", "hobby", "team"]);
const BUILD_MODES = new Set(["local", "remote", "sandbox"]);

export async function run(args = []) {
  const parsed = normalizeArgv(args);
  if (parsed[0] === "verify") return await runVerify(parsed.slice(1));
  if (parsed.includes("--help") || parsed.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(
    parsed,
    [
      "--help",
      "-h",
      "-y",
      "--yes",
      "--dry-run",
      "--check",
      "--print-spec",
      "--plan",
      "--quiet",
      "--final-only",
      "--allow-warnings",
      "--allow-prune",
      "--allow-shell-build",
      "--no-propagation-wait",
      "--json",
      "--human",
      "--json-stream",
    ],
    [
      "--name",
      "--project",
      "--manifest",
      "--dir",
      "--tier",
      "--idempotency-key",
      "--allow-warning",
      "--require-plan",
      "--plan-fingerprint",
      "--max-spend-usd",
      "--build-mode",
      "--propagation-budget-s",
    ],
  );
  const extras = positionalArgs(parsed, [
    "--name",
    "--project",
    "--manifest",
    "--dir",
    "--tier",
    "--idempotency-key",
    "--allow-warning",
    "--require-plan",
    "--plan-fingerprint",
    "--max-spend-usd",
    "--build-mode",
    "--propagation-budget-s",
  ]);
  if (extras.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for up: ${extras[1]}`,
      hint: "Use `run402 up --help`.",
    });
  }
  const source = extras[0] ?? undefined;
  if (source && flagValue(parsed, "--dir")) {
    fail({
      code: "BAD_USAGE",
      message: "Pass either a positional repo/path source or --dir, not both.",
      details: { source, dir: flagValue(parsed, "--dir") },
    });
  }

  const tier = flagValue(parsed, "--tier") ?? undefined;
  if (tier && !TIERS.has(tier)) {
    fail({
      code: "BAD_FLAG",
      message: "--tier must be one of: prototype, hobby, team",
      details: { flag: "--tier", value: tier, allowed: [...TIERS] },
    });
  }

  const buildMode = flagValue(parsed, "--build-mode") ?? undefined;
  if (buildMode && !BUILD_MODES.has(buildMode)) {
    fail({
      code: "BAD_FLAG",
      message: "--build-mode must be one of: local, remote, sandbox",
      details: { flag: "--build-mode", value: buildMode, allowed: [...BUILD_MODES] },
    });
  }

  const maxSpendRaw = flagValue(parsed, "--max-spend-usd");
  const maxSpendUsd = maxSpendRaw === null ? undefined : Number(maxSpendRaw);
  if (maxSpendRaw !== null && (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0)) {
    fail({
      code: "BAD_FLAG",
      message: "--max-spend-usd must be a non-negative number",
      details: { flag: "--max-spend-usd", value: maxSpendRaw },
    });
  }
  const propagationBudgetSeconds = parsePropagationBudget(parsed);

  const yes = parsed.includes("-y") || parsed.includes("--yes");
  const jsonStream = parsed.includes("--json-stream");
  const human = parsed.includes("--human");
  const quiet = parsed.includes("--quiet") || parsed.includes("--final-only") || jsonStream;
  const mode = parseExecutionMode(parsed);
  const dryRun = parsed.includes("--dry-run");
  if (human && (parsed.includes("--json") || jsonStream)) {
    fail({
      code: "BAD_USAGE",
      message: "--human cannot be combined with --json or --json-stream.",
      details: { flags: parsed.filter((arg) => arg === "--human" || arg === "--json" || arg === "--json-stream") },
    });
  }
  if (dryRun && mode !== undefined) {
    fail({
      code: "BAD_USAGE",
      message: "--dry-run cannot be combined with --check, --print-spec, --plan, or --require-plan.",
      details: { flag: "--dry-run" },
    });
  }
  if (isApplyReviewedMode(mode) && (parsed.includes("--allow-warnings") || parsed.includes("--allow-warning"))) {
    fail({
      code: "BAD_USAGE",
      message: "--allow-warning/--allow-warnings are not used with --require-plan; the reviewed plan already binds the warning set.",
      details: { flag: "--require-plan" },
    });
  }
  const allowWarningCodes = collectRepeatedValues(parsed, "--allow-warning");
  const updateScheduler = createUpdateCheckScheduler({
    command: ["run402", "up", ...parsed],
  });
  emitUpdateNotice(updateScheduler.cachedNotice, { jsonStream, quiet });

  try {
    const sdk = getSdk();
    const result = await sdk.up({
      source,
      name: flagValue(parsed, "--name") ?? undefined,
      projectId: flagValue(parsed, "--project") ?? undefined,
      manifest: flagValue(parsed, "--manifest") ?? undefined,
      dir: flagValue(parsed, "--dir") ?? undefined,
      tier,
      idempotencyKey: flagValue(parsed, "--idempotency-key") ?? undefined,
      allowPrune: parsed.includes("--allow-prune") ? true : undefined,
      maxSpendUsd,
      buildMode,
      allowShellBuild: parsed.includes("--allow-shell-build") ? true : undefined,
      allowWarnings: parsed.includes("--allow-warnings") ? true : undefined,
      allowWarningCodes,
      propagationBudgetSeconds,
      propagationWait: parsed.includes("--no-propagation-wait") ? false : undefined,
    }, {
      ...(mode !== undefined ? { mode } : {}),
      dryRun,
      approval: makeApproval(yes),
      onEvent: jsonStream
        ? (event) => console.log(JSON.stringify({ type: "action.event", event }))
        : quiet
          ? undefined
          : (event) => {
              console.error(JSON.stringify(event));
            },
    });
    if (jsonStream) {
      console.log(JSON.stringify({ type: "run402.up.result", result }));
    } else if (mode === "printSpec") {
      console.log(JSON.stringify(result.result?.spec ?? null, null, 2));
    } else if (human && result?.result?.app_result) {
      console.log(formatAppUpHuman(result.result.app_result));
    } else if (human && shouldRenderHumanSuccess(result)) {
      console.log(formatLegacyUpSuccess(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (shouldExitNonZeroForUpResult(result)) {
      process.exitCode = 1;
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function runVerify(args = []) {
  const parsed = normalizeArgv(args);
  if (parsed.includes("--help") || parsed.includes("-h")) {
    console.log(VERIFY_HELP);
    process.exit(0);
  }
  assertKnownFlags(
    parsed,
    ["--help", "-h", "--no-propagation-wait", "--json", "--human", "--json-stream", "--quiet"],
    ["--name", "--project", "--manifest", "--dir", "--idempotency-key", "--propagation-budget-s"],
  );
  const extras = positionalArgs(parsed, [
    "--name",
    "--project",
    "--manifest",
    "--dir",
    "--idempotency-key",
    "--propagation-budget-s",
  ]);
  if (extras.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for up verify: ${extras[1]}`,
      hint: "Use `run402 up verify --help`.",
    });
  }
  const source = extras[0] ?? undefined;
  if (source && flagValue(parsed, "--dir")) {
    fail({
      code: "BAD_USAGE",
      message: "Pass either a positional repo/path source or --dir, not both.",
      details: { source, dir: flagValue(parsed, "--dir") },
    });
  }
  const jsonStream = parsed.includes("--json-stream");
  const human = parsed.includes("--human");
  const quiet = parsed.includes("--quiet") || jsonStream;
  if (human && (parsed.includes("--json") || jsonStream)) {
    fail({
      code: "BAD_USAGE",
      message: "--human cannot be combined with --json or --json-stream.",
      details: { flags: parsed.filter((arg) => arg === "--human" || arg === "--json" || arg === "--json-stream") },
    });
  }
  const propagationBudgetSeconds = parsePropagationBudget(parsed);
  const updateScheduler = createUpdateCheckScheduler({
    command: ["run402", "up", "verify", ...parsed],
  });
  emitUpdateNotice(updateScheduler.cachedNotice, { jsonStream, quiet });

  try {
    const sdk = getSdk();
    const result = await sdk.up({
      source,
      name: flagValue(parsed, "--name") ?? undefined,
      projectId: flagValue(parsed, "--project") ?? undefined,
      manifest: flagValue(parsed, "--manifest") ?? undefined,
      dir: flagValue(parsed, "--dir") ?? undefined,
      idempotencyKey: flagValue(parsed, "--idempotency-key") ?? undefined,
      verifyOnly: true,
      propagationBudgetSeconds,
      propagationWait: parsed.includes("--no-propagation-wait") ? false : undefined,
    }, {
      approval: "never",
      autoPrerequisites: false,
      onEvent: jsonStream
        ? (event) => console.log(JSON.stringify({ type: "action.event", event }))
        : quiet
          ? undefined
          : (event) => {
              console.error(JSON.stringify(event));
            },
    });
    if (jsonStream) {
      console.log(JSON.stringify({ type: "run402.up.result", result }));
    } else if (human && result?.result?.app_result) {
      console.log(formatAppUpHuman(result.result.app_result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (shouldExitNonZeroForUpResult(result)) {
      process.exitCode = 1;
    }
  } catch (err) {
    reportSdkError(err);
  }
}

export function shouldExitNonZeroForUpResult(result) {
  return result?.action === "up" &&
    result?.mode === "apply" &&
    result?.result?.app_result?.status === "deployed_unverified";
}

function parseExecutionMode(args) {
  const modes = [];
  if (args.includes("--check")) modes.push("--check");
  if (args.includes("--print-spec")) modes.push("--print-spec");
  if (args.includes("--plan")) modes.push("--plan");
  const requiredPlan = flagValue(args, "--require-plan");
  if (requiredPlan) modes.push("--require-plan");
  const fingerprint = flagValue(args, "--plan-fingerprint");
  if (fingerprint && !requiredPlan) {
    fail({
      code: "BAD_USAGE",
      message: "--plan-fingerprint can only be used with --require-plan.",
      details: { flag: "--plan-fingerprint" },
    });
  }
  if (modes.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Choose only one execution mode: ${modes.join(", ")}`,
      details: { modes },
    });
  }
  if (args.includes("--check")) return "check";
  if (args.includes("--print-spec")) return "printSpec";
  if (args.includes("--plan")) return "plan";
  if (requiredPlan) {
    return {
      kind: "applyReviewed",
      planId: requiredPlan,
      ...(fingerprint ? { planFingerprint: fingerprint } : {}),
    };
  }
  return undefined;
}

function isApplyReviewedMode(mode) {
  return mode && typeof mode === "object" && mode.kind === "applyReviewed";
}

function collectRepeatedValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    if (args[i + 1] === undefined || String(args[i + 1]).startsWith("--")) {
      fail({
        code: "BAD_FLAG",
        message: `${flag} requires a value`,
        details: { flag },
      });
    }
    values.push(args[++i]);
  }
  return values;
}

function parsePropagationBudget(args) {
  const raw = flagValue(args, "--propagation-budget-s");
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail({
      code: "BAD_FLAG",
      message: "--propagation-budget-s must be a non-negative number",
      details: { flag: "--propagation-budget-s", value: raw },
    });
  }
  return value;
}

function makeApproval(yes) {
  if (yes) return "yes";
  if (!input.isTTY || !output.isTTY) return "never";
  return {
    mode: "interactive",
    async approve(request) {
      const rl = createInterface({ input, output });
      try {
        const answer = await rl.question(`${request.message} Continue? [y/N] `);
        return /^y(?:es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

function shouldRenderHumanSuccess(result) {
  return result?.action === "up" &&
    result?.dry_run === false &&
    result?.mode === "apply" &&
    result?.result?.deploy?.release_id;
}

function formatLegacyUpSuccess(result) {
  const urls = result?.result?.deploy?.urls ?? {};
  const origin = urls.site ?? urls.subdomain ?? urls.deployment;
  const lines = [];
  if (origin) lines.push(`Success! Project is up at: ${origin}`);
  else lines.push("Success! Project is up.");
  const releaseId = result?.result?.deploy?.release_id;
  if (releaseId) lines.push(`Release: ${releaseId}`);
  return lines.join("\n");
}

function formatAppUpHuman(appResult) {
  const lines = [];
  const status = appResult?.status ?? "unknown";
  const origin = appResult?.project?.public_origin;

  if (status === "succeeded" && origin) {
    lines.push(`Success! Project is up at: ${origin}`);
  } else if (status === "succeeded") {
    lines.push("Success! Project is up.");
  } else if (status === "propagation_pending" && origin) {
    lines.push(`Project deployed; verification is waiting on edge propagation at: ${origin}`);
  } else if (status === "propagation_pending") {
    lines.push("Project deployed; verification is waiting on edge propagation.");
  } else if (status === "planned") {
    lines.push("Run402 up plan is ready.");
    if (origin) lines.push(`Planned project URL: ${origin}`);
  } else if (status === "blocked") {
    lines.push("Run402 up is blocked.");
  } else {
    lines.push(`Run402 up status: ${status}`);
  }

  const diagnostics = Array.isArray(appResult?.diagnostics) ? appResult.diagnostics : [];
  for (const diagnostic of diagnostics) {
    if (diagnostic?.message) lines.push(`- ${diagnostic.message}`);
  }

  const nextActions = Array.isArray(appResult?.next_actions) ? appResult.next_actions : [];
  if (nextActions.length > 0) {
    lines.push("Next:");
    for (const action of nextActions) {
      if (action?.message) lines.push(`- ${action.message}`);
      if (action?.command) lines.push(`  ${action.command}`);
    }
  }

  return lines.join("\n");
}
