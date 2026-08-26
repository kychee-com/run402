import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";
import { createUpdateCheckScheduler, emitUpdateNotice } from "./update-check.mjs";
import { allowanceAuthHeaders, isCoreApiTarget } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";

const HELP = `run402 up — Provision/link/deploy the current app

Usage:
  run402 up [repo-or-path] [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <tier>] [-y|--yes] [--check|--print-spec|--plan|--require-plan <id>|--repo-only] [--verify] [--human|--json-stream] [--quiet]
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
  --verify            After a deploy apply, wait for gateway/edge release
                      coherence and attach the report to the final result.
  --no-propagation-wait
                      Return propagation_pending immediately when the edge is
                      still settling.
  --repo-only         Provision + scaffold the run402 remote + first push,
                      and stop there — no deploy. The vault-only track
                      (D8), composed through up instead of run402 repos
                      create. Incompatible with --check/--print-spec/--plan/
                      --require-plan/--verify.

Repo composition (D4): against a local directory (not a git URL source), up
composes git init (only when not already a repository) + provision + a
run402 remote scaffold (D1: claims origin when free, falls back to run402)
+ a first gitvault push — one command, the fly-launch shape. The scaffold
and first push are best-effort: a git or vault hiccup never turns an
otherwise-successful deploy into a failure, and is reported under
result.repo (default apply) or result (--repo-only) instead.
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
  run402 up --repo-only -y --json
`;

const VERIFY_HELP = `run402 up verify — Rerun manifest HTTP verification (verify.http[])

Works for both app manifests (run402.json) and deploy manifests
(run402.deploy.json / app.json) that declare a top-level verify block.

Usage:
  run402 up verify [repo-or-path] [--project <id>] [--manifest <path>] [--dir <path>] [--name <name>] [--human|--json-stream]

Options:
  repo-or-path        Local app directory or public Git repository URL. Defaults
                      to the current directory.
  --project <id>      Existing project id. Defaults to .run402/project.json,
                      manifest project id, then active project.
  --manifest <path>   Manifest path. Defaults to run402.json, then
                      run402.deploy.json, then app.json.
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
      "--verify",
      "--no-propagation-wait",
      "--json",
      "--human",
      "--json-stream",
      "--repo-only",
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
  const verifyEdge = parsed.includes("--verify");
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
  if (verifyEdge && (dryRun || isNonApplyingMode(mode))) {
    fail({
      code: "BAD_USAGE",
      message: "--verify can only be used when run402 up applies a deploy.",
      details: { flag: "--verify", mode: dryRun ? "dry-run" : mode },
    });
  }
  if (isApplyReviewedMode(mode) && (parsed.includes("--allow-warnings") || parsed.includes("--allow-warning"))) {
    fail({
      code: "BAD_USAGE",
      message: "--allow-warning/--allow-warnings are not used with --require-plan; the reviewed plan already binds the warning set.",
      details: { flag: "--require-plan" },
    });
  }
  const repoOnly = parsed.includes("--repo-only");
  if (repoOnly && (dryRun || isNonApplyingMode(mode) || isApplyReviewedMode(mode) || verifyEdge)) {
    fail({
      code: "BAD_USAGE",
      message: "--repo-only cannot be combined with --dry-run, --check, --print-spec, --plan, --require-plan, or --verify.",
      details: { flag: "--repo-only" },
    });
  }
  const allowWarningCodes = collectRepeatedValues(parsed, "--allow-warning");
  const updateScheduler = createUpdateCheckScheduler({
    command: ["run402", "up", ...parsed],
  });
  emitUpdateNotice(updateScheduler.cachedNotice, { jsonStream, quiet });

  // D4 (repo-first-onramp task 2.4): `up` composes git init + provision +
  // remote scaffold + first push (+ deploy unless --repo-only) — the
  // `fly launch` shape. Scoped to the plain local-directory apply path (no
  // dry-run, no non-applying mode, and no remote git-URL source — those
  // clone into somewhere ephemeral, so there is no local working tree here
  // to scaffold a remote onto).
  const composeRepo = !dryRun && mode === undefined && !looksLikeGitRemoteUrl(source);
  const workDir = flagValue(parsed, "--dir") ?? (source && !looksLikeGitRemoteUrl(source) ? source : undefined) ?? process.cwd();

  try {
    const sdk = getSdk();
    let createdRepository = false;
    if (composeRepo) {
      createdRepository = await gitInitIfNeeded(workDir);
    }

    let result;
    if (repoOnly) {
      result = await runRepoOnly({ sdk, workDir, createdRepository, opts: parsed, tier, allowWarningCodes, idempotencyKey: flagValue(parsed, "--idempotency-key") ?? undefined });
    } else {
      result = await sdk.up({
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
      // The remote scaffold + first push are best-effort ADDITIONS to an
      // already-successful deploy: a git hiccup here must never flip an
      // otherwise-successful `up` into a failure (the same non-fatal
      // discipline `projects provision`'s own fold-in follows).
      if (composeRepo && mode === undefined) {
        const projectId = result?.result?.project_id ?? result?.result?.deploy?.project_id ?? null;
        if (projectId) {
          const repoResult = await composeRepoPushStep({ sdk, workDir, projectId, createdRepository });
          if (result.result) result.result.repo = repoResult;
        }
      }
    }

    const edgeWait = verifyEdge
      ? await attachEdgeVerification(result, {
          sdk,
          timeoutSeconds: propagationBudgetSeconds ?? 120,
          jsonStream,
          quiet,
        })
      : null;
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
    if (edgeWait && !edgeWait.coherent && process.exitCode !== 1) {
      process.exitCode = 2;
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
  if (result?.action !== "up" || result?.mode !== "apply") return false;
  if (result?.result?.app_result?.status === "deployed_unverified") return true;
  // Deploy-manifest verify.http[]: a hard verify failure (not propagation)
  // mirrors the app path's deployed_unverified exit semantics.
  return result?.result?.verify?.status === "failed";
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

function isNonApplyingMode(mode) {
  return mode === "check" || mode === "printSpec" || mode === "plan";
}

async function attachEdgeVerification(result, { sdk, timeoutSeconds, jsonStream, quiet }) {
  const deploy = result?.result?.deploy;
  const operationId = deploy?.operation_id;
  const projectId = result?.result?.project_id;
  if (!operationId || !projectId || String(operationId).startsWith("core:")) {
    return null;
  }
  const scoped = await sdk.project(projectId);
  const wait = await scoped.apply.waitEdgeCoherent(operationId, {
    timeoutMs: timeoutSeconds * 1000,
    onPoll: (event) => {
      const line = {
        type: "deploy.verify.poll",
        coherent: event.report.coherent,
        attempts: event.attempts,
        elapsed_ms: event.elapsedMs,
        pending_count: event.report.pending_count,
        path_count: event.report.path_count,
        total_path_count: event.report.total_path_count,
        paths_truncated: event.report.paths_truncated,
        paths: summarizeEdgeCoherencePaths(event.report.paths),
      };
      if (jsonStream) console.log(JSON.stringify({ type: "action.event", event: line }));
      else if (!quiet) console.error(JSON.stringify(line));
    },
  });
  result.result.edge_coherence = wait;
  result.result.deploy = {
    ...deploy,
    edge_coherence: wait.report,
  };
  return wait;
}

function summarizeEdgeCoherencePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map((path) => ({
    path: path.path,
    host: path.host,
    state: path.state,
    observed_confidence: path.observed_confidence,
    expected_release_id: path.expected_release_id,
    observed_release_id: path.observed_release_id,
    expected_release_generation: path.expected_release_generation,
    observed_release_generation: path.observed_release_generation,
    status: path.status,
    x_cache: path.x_cache,
    age_seconds: path.age_seconds,
    error: path.error,
  }));
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

// ─── D4 (repo-first-onramp task 2.4): repo composition ───────────────────────
//
// `up` composes git init + provision + remote scaffold + first push
// (+ deploy unless --repo-only) — the `fly launch` shape. A remote git URL
// source clones into somewhere ephemeral (no local working tree here to
// scaffold a remote onto), so composition is scoped to the plain
// local-directory apply path.

/** A positional `up` source that names a remote repository rather than a local path. */
function looksLikeGitRemoteUrl(source) {
  if (!source || typeof source !== "string") return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^\s@]+@[^\s:]+:/.test(source);
}

/**
 * `git init` only when `dir` is not a repository yet. Returns whether it did.
 *
 * `-b main`, not whatever `init.defaultBranch` (or the pre-2.28 hardcoded
 * `master`) happens to be — the docs teach `git push origin main`, and the
 * gitvault remote helper's own dangling-HEAD hazard note (a first push of
 * any OTHER branch leaves HEAD naming a ref that does not exist yet) is
 * exactly what a mismatched default branch here would walk `up` straight
 * into. `-b` needs git 2.28+ (2020); an older git falls back to the same
 * result by a different route — `symbolic-ref` on a still-empty repository
 * has no existing ref to disturb, so it is exactly as safe as `-b main`
 * would have been. Mirrors `Gitvault.scaffoldRemote`'s identical fallback.
 */
async function gitInitIfNeeded(dir) {
  const { hardenedGit } = await import("#sdk/node");
  try {
    await hardenedGit(dir, ["rev-parse", "--git-dir"]);
    return false;
  } catch {
    try {
      await hardenedGit(dir, ["init", "-q", "-b", "main", "."]);
    } catch {
      await hardenedGit(dir, ["init", "-q", "."]);
      await hardenedGit(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    return true;
  }
}

/**
 * Remote scaffold + first push, against an already-known project. Best-effort
 * in every branch — the same non-fatal discipline `projects provision`'s own
 * fold-in follows (`gitvault-scaffold.mjs`): a git or vault hiccup here must
 * never turn an otherwise-successful `up` into a failure.
 */
async function composeRepoPushStep({ sdk, workDir, projectId, createdRepository }) {
  const { resolveOwningOrgId } = await import("./org-context.mjs");
  const { scaffoldGitvaultRemote } = await import("./gitvault-scaffold.mjs");
  const orgId = await resolveOwningOrgId(projectId);
  const scaffold = await scaffoldGitvaultRemote({ repoDir: workDir, projectId, orgId: orgId ?? undefined, createRepoIfMissing: false });
  if (createdRepository && scaffold.gitvault) scaffold.gitvault.created_repository = true;
  const out = { ...scaffold, first_push: null, first_push_error: null };
  if (!orgId) {
    out.first_push_error = { code: "GITVAULT_ORG_UNRESOLVED", message: `could not resolve the owning org for ${projectId} — the first push was skipped` };
    return out;
  }
  try {
    let vaultCreated = null;
    const pushed = await sdk.gitvault.push({
      project_id: projectId,
      org_id: orgId,
      repo_dir: workDir,
      onVaultCreated: (created) => { vaultCreated = created; },
    });
    out.first_push = { generation: pushed.generation, form: pushed.form, gitvault_commit: pushed.gitvault_commit, vault_created: vaultCreated };
  } catch (err) {
    out.first_push_error = { code: err?.body?.code ?? err?.code ?? "GITVAULT_PUSH_FAILED", message: err?.message ?? String(err) };
  }
  return out;
}

/**
 * `--repo-only`: the vault-only track composed through `up` — provision +
 * remote scaffold + first push, zero deploy ceremony. Mirrors `run402 repos
 * create`'s own shape (task 2.6); `up --repo-only` is the "I'm already
 * inside `up`'s mental model" entry point to the same outcome.
 */
async function runRepoOnly({ sdk, workDir, createdRepository, opts, tier, idempotencyKey }) {
  // `sdk.up()`'s action graph auto-approves prerequisites (allowance, tier)
  // for a cold start; calling projects.provision directly bypasses that, so
  // this mirrors the SAME gate `run402 projects provision` itself uses —
  // fail with the actionable NO_ALLOWANCE guidance rather than an opaque
  // auth error from the gateway.
  if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) allowanceAuthHeaders("/projects/v1");
  const name = flagValue(opts, "--name") ?? undefined;
  const provisioned = await sdk.projects.provision({ tier, name, idempotencyKey });
  const repo = await composeRepoPushStep({ sdk, workDir, projectId: provisioned.project_id, createdRepository });
  return {
    action: "up",
    mode: "repo-only",
    dry_run: false,
    result: { project_id: provisioned.project_id, provision: provisioned, repo },
  };
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
