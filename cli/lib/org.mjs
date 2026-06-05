import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
} from "./argparse.mjs";

const HELP = `run402 org — org-owned control plane: identity, membership, roles

Usage:
  run402 org <subcommand> [args...]

Subcommands:
  whoami                                       Resolved principal + org memberships (GET /agent/v1/whoami)
  list                                         Orgs you are a member of
  members <billing_account>                    Members + roles of an org
  add-member <billing_account> <wallet> [--role <role>]
                                               Add a member by wallet (owner-gated; role defaults to developer)
  set-role <billing_account> <principal_id> <role>
                                               Change a member's role (owner-gated)
  remove-member <billing_account> <principal_id>
                                               Remove a member (owner-gated)

Notes:
  - A wallet AUTHENTICATES; the org (billing account) owns projects. Membership/role authorizes.
  - Roles: owner > admin > developer > billing > viewer. Member changes need an active owner.
  - "add-member" is by WALLET (email-first invite is a separate, not-yet-shipped flow).
  - Removing/demoting the org's only active owner fails with 409 LAST_OWNER.
  - JSON in, JSON out.

Examples:
  run402 org whoami
  run402 org list
  run402 org members ba_abc
  run402 org add-member ba_abc 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --role admin
  run402 org set-role ba_abc prn_xyz owner
  run402 org remove-member ba_abc prn_xyz
`;

const SUB_HELP = {
  whoami: `run402 org whoami — resolved principal + org memberships

Usage:
  run402 org whoami

Calls GET /agent/v1/whoami. Returns the control-plane principal (id/type/display_name),
authenticator_id, and every org membership with role + status. This is the REMOTE
identity; for local wallet/profile state use \`run402 status\`.
`,
  list: `run402 org list — orgs you are a member of

Usage:
  run402 org list

Returns each org (billing account) you belong to with your role and membership status.
`,
  members: `run402 org members — members + roles of an org

Usage:
  run402 org members <billing_account>

Arguments:
  <billing_account>   Org (billing account) id, e.g. ba_...
`,
  "add-member": `run402 org add-member — add a member by wallet (owner-gated)

Usage:
  run402 org add-member <billing_account> <wallet> [--role <role>]

Arguments:
  <billing_account>   Org (billing account) id
  <wallet>            EVM address or named wallet (a new wallet is provisioned as a human principal)

Options:
  --role <role>       owner | admin | developer | billing | viewer (default: developer)
`,
  "set-role": `run402 org set-role — change a member's role (owner-gated)

Usage:
  run402 org set-role <billing_account> <principal_id> <role>

Arguments:
  <billing_account>   Org (billing account) id
  <principal_id>      Member principal id (prn_..., from \`run402 org members\`)
  <role>              owner | admin | developer | billing | viewer

Demoting the org's only active owner fails with 409 LAST_OWNER.
`,
  "remove-member": `run402 org remove-member — remove a member (owner-gated)

Usage:
  run402 org remove-member <billing_account> <principal_id>

Removing the org's only active owner fails with 409 LAST_OWNER.
`,
};

async function whoami(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org whoami" });
  try {
    console.log(JSON.stringify(await getSdk().org.whoami(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org list" });
  try {
    console.log(JSON.stringify({ orgs: await getSdk().org.list() }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function members(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [ba] = requirePositionalCount(a, [], {
    min: 1,
    max: 1,
    command: "run402 org members <billing_account>",
    missing: "Missing <billing_account>.",
  });
  try {
    console.log(JSON.stringify({ members: await getSdk().org.members(ba) }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function addMember(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--role", "--help", "-h"], ["--role"]);
  const role = flagValue(a, "--role");
  const [ba, wallet] = requirePositionalCount(a, ["--role"], {
    min: 2,
    max: 2,
    command: "run402 org add-member <billing_account> <wallet> [--role <role>]",
    missing: "Missing <billing_account> and/or <wallet>.",
  });
  try {
    const res = await getSdk().org.addMember(ba, { wallet, role: role || undefined });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setRole(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [ba, principalId, role] = requirePositionalCount(a, [], {
    min: 3,
    max: 3,
    command: "run402 org set-role <billing_account> <principal_id> <role>",
    missing: "Missing <billing_account>, <principal_id>, and/or <role>.",
  });
  try {
    console.log(JSON.stringify(await getSdk().org.setRole(ba, principalId, role), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function removeMember(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [ba, principalId] = requirePositionalCount(a, [], {
    min: 2,
    max: 2,
    command: "run402 org remove-member <billing_account> <principal_id>",
    missing: "Missing <billing_account> and/or <principal_id>.",
  });
  try {
    console.log(JSON.stringify(await getSdk().org.removeMember(ba, principalId), null, 2));
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
    case "whoami": await whoami(args); break;
    case "list": await list(args); break;
    case "members": await members(args); break;
    case "add-member": await addMember(args); break;
    case "set-role": await setRole(args); break;
    case "remove-member": await removeMember(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
