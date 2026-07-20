import { getSdk } from "./sdk.mjs";
import { reportSdkError, parseFlagJson } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 grants — per-project capability grants (agent/CI principals)

Usage:
  run402 grants <subcommand> [args...]

Subcommands:
  create <wallet> --capability <cap> [--project <id>] [--policy <json>] [--expires <iso8601>]
                                 Issue a capability grant (owner of the project's org)
  revoke <grant_id> [--project <id>]
                                 Revoke a capability grant

Legacy (still supported):
  run402 grants create <project_id> <wallet> <capability> [...]
  run402 grants revoke <project_id> <grant_id>

Notes:
  - Grants let a non-member wallet (an agent or CI principal) act on ONE project,
    without making it a broad org member. Mutations require owner of the project's org.
  - capability examples: deploy, functions:write.
  - JSON in, JSON out.

Examples:
  run402 grants create 0xf39Fd6...92266 --capability deploy --project prj_abc
  run402 grants create 0xf39Fd6...92266 --capability functions:write --expires 2026-12-31T00:00:00Z
  run402 grants revoke grt_xyz --project prj_abc
`;

const SUB_HELP = {
  create: `run402 grants create — issue a per-project capability grant

Usage:
  run402 grants create <wallet> --capability <cap> [--project <id>] [--policy <json>] [--expires <iso8601>]

Legacy (still supported):
  run402 grants create <project_id> <wallet> <capability> [options]

Arguments:
  <wallet>       EVM address or named wallet the grant is issued to

Options:
  --project <id>      Project to grant access to (defaults to the active project)
  --capability <cap>  e.g. deploy, functions:write (alternative to the legacy positional)
  --policy <json>     Capability-scoping policy object (gateway-interpreted)
  --expires <iso8601> Expiry timestamp; omit for a non-expiring grant

Requires you to be an owner of the project's org.
`,
  revoke: `run402 grants revoke — revoke a per-project capability grant

Usage:
  run402 grants revoke <grant_id> [--project <id>]

Legacy (still supported):
  run402 grants revoke <project_id> <grant_id>

Requires you to be an owner of the project's org.
`,
};

const CREATE_VALUE_FLAGS = ["--project", "--capability", "--policy", "--expires"];

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--help", "-h"], CREATE_VALUE_FLAGS);
  const policyRaw = flagValue(a, "--policy");
  const expiresAt = flagValue(a, "--expires");
  const capabilityFlag = flagValue(a, "--capability");
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: CREATE_VALUE_FLAGS });
  const expected = capabilityFlag ? 1 : 2;
  const pos = requirePositionalCount(rest, CREATE_VALUE_FLAGS, {
    min: expected,
    max: expected,
    command: "run402 grants create <wallet> --capability <cap> [--project <id>] [--policy <json>] [--expires <iso8601>]",
    missing: capabilityFlag ? "Missing <wallet>." : "Missing <wallet> and/or <capability>.",
  });
  const wallet = pos[0];
  const capability = capabilityFlag ?? pos[1];
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
  assertKnownFlags(a, ["--project", "--help", "-h"], ["--project"]);
  const { projectId, rest } = resolveProjectSelector(a, { valueFlags: ["--project"] });
  const [grantId] = requirePositionalCount(rest, ["--project"], {
    min: 1,
    max: 1,
    command: "run402 grants revoke <grant_id> [--project <id>]",
    missing: "Missing <grant_id>.",
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
      failUnknownSubcommand("grants", sub);
  }
}
