import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 up — Provision/link/deploy the current app

Usage:
  run402 up [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <tier>] [-y|--yes] [--dry-run] [--quiet]

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
  --dry-run           Plan the recursive action graph without gateway mutations,
                      uploads, or local writes.
  --allow-warning <code>
                      Acknowledge a reviewed deploy warning code (repeatable).
  --allow-warnings    Acknowledge all reviewed deploy warnings.
  --quiet             Suppress action progress events on stderr.

Project resolution:
  explicit --project > .run402/project.json > manifest project_id > approved
  project creation from --name > approved active-project fallback.

Examples:
  run402 up --name my-app -y
  run402 up --dry-run
  run402 up --manifest run402.deploy.json --project prj_...
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
    ["--help", "-h", "-y", "--yes", "--dry-run", "--quiet", "--final-only", "--allow-warnings"],
    ["--name", "--project", "--manifest", "--dir", "--tier", "--idempotency-key", "--allow-warning"],
  );
  const extras = positionalArgs(parsed, [
    "--name",
    "--project",
    "--manifest",
    "--dir",
    "--tier",
    "--idempotency-key",
    "--allow-warning",
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
  const dryRun = parsed.includes("--dry-run");
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
      dryRun,
      approval: makeApproval(yes),
      onEvent: quiet ? undefined : (event) => {
        console.error(JSON.stringify(event));
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
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
