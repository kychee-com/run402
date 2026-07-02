import { getSdk } from "./sdk.mjs";
import { reportSdkError, parseFlagJson, fail } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
} from "./argparse.mjs";

const HELP = `run402 grants — per-project capability grants (agent/CI principals)

Usage:
  run402 grants <subcommand> [args...]

Subcommands:
  create <project_id> <wallet> <capability> [--policy <json>] [--expires <iso8601>]
                                 Issue a capability grant (owner of the project's org)
  revoke <project_id> <grant_id>
                                 Revoke a capability grant

Notes:
  - Grants let a non-member wallet (an agent or CI principal) act on ONE project,
    without making it a broad org member. Mutations require owner of the project's org.
  - capability examples: deploy, functions:write.
  - JSON in, JSON out.

Examples:
  run402 grants create prj_abc 0xf39Fd6...92266 deploy
  run402 grants create prj_abc 0xf39Fd6...92266 functions:write --expires 2026-12-31T00:00:00Z
  run402 grants revoke prj_abc grt_xyz
`;

const SUB_HELP = {
  create: `run402 grants create — issue a per-project capability grant

Usage:
  run402 grants create <project_id> <wallet> <capability> [--policy <json>] [--expires <iso8601>]

Arguments:
  <project_id>   Project to grant access to
  <wallet>       EVM address or named wallet the grant is issued to
  <capability>   e.g. deploy, functions:write

Options:
  --policy <json>     Capability-scoping policy object (gateway-interpreted)
  --expires <iso8601> Expiry timestamp; omit for a non-expiring grant

Requires you to be an owner of the project's org.
`,
  revoke: `run402 grants revoke — revoke a per-project capability grant

Usage:
  run402 grants revoke <project_id> <grant_id>

Requires you to be an owner of the project's org.
`,
};

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--policy", "--expires", "--help", "-h"], ["--policy", "--expires"]);
  const policyRaw = flagValue(a, "--policy");
  const expiresAt = flagValue(a, "--expires");
  const [projectId, wallet, capability] = requirePositionalCount(a, ["--policy", "--expires"], {
    min: 3,
    max: 3,
    command: "run402 grants create <project_id> <wallet> <capability> [--policy <json>] [--expires <iso8601>]",
    missing: "Missing <project_id>, <wallet>, and/or <capability>.",
  });
  const policy = policyRaw != null ? parseFlagJson("--policy", policyRaw) : undefined;
  try {
    const res = await getSdk().grants.create(projectId, {
      wallet,
      capability,
      policy,
      expiresAt: expiresAt || undefined,
    });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function revoke(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [projectId, grantId] = requirePositionalCount(a, [], {
    min: 2,
    max: 2,
    command: "run402 grants revoke <project_id> <grant_id>",
    missing: "Missing <project_id> and/or <grant_id>.",
  });
  try {
    console.log(JSON.stringify(await getSdk().grants.revoke(projectId, grantId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "create": await create(args); break;
    case "revoke": await revoke(args); break;
    default:
      fail({ code: "UNKNOWN_SUBCOMMAND", message: `Unknown grants subcommand: ${sub}`, hint: "Run `run402 grants --help` for usage.", details: { command: "grants", subcommand: sub } });
  }
}
