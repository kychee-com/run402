import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 up — Provision/link/deploy the current app

Usage:
  run402 up [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <tier>] [-y|--yes] [--check|--print-spec|--plan|--require-plan <id>] [--quiet]

Options:
  --name <name>       Project display name when up needs to create a project.
                      Not a deploy manifest field and never renames a project.
  --project <id>      Explicit project id. Highest-priority project selector.
  --manifest <path>   Deploy manifest path. Defaults to run402.deploy.json,
                      then app.json in --dir/current directory.
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
  --quiet             Suppress action progress events on stderr.

Project resolution:
  explicit --project > .run402/project.json > manifest project_id > approved
  project creation from --name > approved active-project fallback.

Examples:
  run402 up --name my-app -y
  run402 up --manifest run402.deploy.ts --check
  run402 up --manifest run402.deploy.ts --plan
  run402 up --manifest run402.deploy.ts --require-plan pln_...
`;

const TIERS = new Set(["prototype", "hobby", "team"]);

export async function run(args = []) {
  const parsed = normalizeArgv(args);
  if (parsed.includes("--help") || parsed.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(
    parsed,
    ["--help", "-h", "-y", "--yes", "--dry-run", "--check", "--print-spec", "--plan", "--quiet", "--final-only", "--allow-warnings"],
    ["--name", "--project", "--manifest", "--dir", "--tier", "--idempotency-key", "--allow-warning", "--require-plan", "--plan-fingerprint"],
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
  ]);
  if (extras.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for up: ${extras[0]}`,
      hint: "Use `run402 up --help`.",
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

  const yes = parsed.includes("-y") || parsed.includes("--yes");
  const quiet = parsed.includes("--quiet") || parsed.includes("--final-only");
  const mode = parseExecutionMode(parsed);
  const dryRun = parsed.includes("--dry-run");
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

  try {
    const sdk = getSdk();
    const result = await sdk.up({
      name: flagValue(parsed, "--name") ?? undefined,
      projectId: flagValue(parsed, "--project") ?? undefined,
      manifest: flagValue(parsed, "--manifest") ?? undefined,
      dir: flagValue(parsed, "--dir") ?? undefined,
      tier,
      idempotencyKey: flagValue(parsed, "--idempotency-key") ?? undefined,
      allowWarnings: parsed.includes("--allow-warnings") ? true : undefined,
      allowWarningCodes,
    }, {
      ...(mode !== undefined ? { mode } : {}),
      dryRun,
      approval: makeApproval(yes),
      onEvent: quiet ? undefined : (event) => {
        console.error(JSON.stringify(event));
      },
    });
    if (mode === "printSpec") {
      console.log(JSON.stringify(result.result?.spec ?? null, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    reportSdkError(err);
  }
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
