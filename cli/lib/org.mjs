import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  parseIntegerFlag,
  requirePositionalCount,
} from "./argparse.mjs";

const ROLE_LIST = "owner | admin | developer | billing | viewer";

const HELP = `run402 org — org-owned control plane: identity, membership, invites

Usage:
  run402 org whoami
  run402 org list
  run402 org audit <billing_account> [--limit N] [--before <cursor>]
  run402 org member list <billing_account>
  run402 org member add  <billing_account> <wallet> [--role <role>]
  run402 org member role <billing_account> <principal_id> <role>
  run402 org member rm   <billing_account> <principal_id>
  run402 org invite list   <billing_account>
  run402 org invite create <billing_account> <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     <billing_account> <principal_id>

Subcommands:
  whoami      Resolved principal + org memberships (GET /agent/v1/whoami)
  list        Orgs you are a member of
  member      Manage members (list, add, role, rm) — mutations require owner
  invite      Manage email invites (list, create, rm) — mutations require owner
  audit       Control-plane audit trail for an org (admin+)

Notes:
  - A wallet AUTHENTICATES; the org (billing account) owns projects. Membership/role authorizes.
  - Roles: ${ROLE_LIST}. Member/invite changes need an active owner.
  - Removing/demoting the org's only active owner fails with 409 LAST_OWNER.
  - JSON in, JSON out.

Examples:
  run402 org whoami
  run402 org member list ba_abc
  run402 org member add ba_abc 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --role admin
  run402 org member role ba_abc prn_xyz owner
  run402 org invite create ba_abc dev@example.com --role developer
  run402 org audit ba_abc --limit 50
`;

const SUB_HELP = {
  whoami: `run402 org whoami — resolved principal + org memberships

Usage:
  run402 org whoami

Calls GET /agent/v1/whoami. Returns the control-plane principal (id/type/displayName/createdAt),
authenticator_id, and every org membership with role + status. REMOTE identity; for local
wallet/profile state use 'run402 status'.
`,
  list: `run402 org list — orgs you are a member of

Usage:
  run402 org list
`,
  member: `run402 org member — manage org members

Usage:
  run402 org member list <billing_account>
  run402 org member add  <billing_account> <wallet> [--role <role>]
  run402 org member role <billing_account> <principal_id> <role>
  run402 org member rm   <billing_account> <principal_id>

Roles: ${ROLE_LIST} (add defaults to developer). Mutations require an active owner.
Demoting/removing the org's only active owner fails with 409 LAST_OWNER.
`,
  invite: `run402 org invite — manage email invites

Usage:
  run402 org invite list   <billing_account>
  run402 org invite create <billing_account> <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     <billing_account> <principal_id>

An invite is claimed at the recipient's first login. Mutations require an active owner
(plus step-up when driven by a control-plane session).
`,
  audit: `run402 org audit — control-plane audit trail

Usage:
  run402 org audit <billing_account> [--limit N] [--before <cursor>]

Requires an admin+ membership on the org. Newest-first; page with --before.
`,
};

// ── Top-level: whoami / list / audit ───────────────────────────────────────────

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

async function audit(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--limit", "--before"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const [ba] = requirePositionalCount(a, valueFlags, {
    min: 1,
    max: 1,
    command: "run402 org audit <billing_account>",
    missing: "Missing <billing_account>.",
  });
  const limitFlag = flagValue(a, "--limit");
  const before = flagValue(a, "--before");
  const limit = limitFlag === null ? undefined : parseIntegerFlag("--limit", limitFlag, { min: 1, max: 1000 });
  try {
    const events = await getSdk().org.audit(ba, { limit, before: before ?? undefined });
    console.log(JSON.stringify({ events }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ── Member group ───────────────────────────────────────────────────────────────

async function runMember(args) {
  const memberAction = args[0];
  const rest = args.slice(1);
  if (!memberAction || memberAction === "--help" || memberAction === "-h") {
    console.log(SUB_HELP.member);
    process.exit(memberAction ? 0 : 1);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SUB_HELP.member);
    process.exit(0);
  }

  if (memberAction === "list") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [ba] = requirePositionalCount(a, [], {
      min: 1, max: 1, command: "run402 org member list <billing_account>", missing: "Missing <billing_account>.",
    });
    try {
      console.log(JSON.stringify({ members: await getSdk().org.members.list(ba) }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "add") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--role", "--help", "-h"], ["--role"]);
    const role = flagValue(a, "--role");
    const [ba, wallet] = requirePositionalCount(a, ["--role"], {
      min: 2, max: 2, command: "run402 org member add <billing_account> <wallet> [--role <role>]",
      missing: "Missing <billing_account> and/or <wallet>.",
    });
    try {
      const res = await getSdk().org.members.add(ba, { wallet, role: role || undefined });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "role") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [ba, principalId, role] = requirePositionalCount(a, [], {
      min: 3, max: 3, command: "run402 org member role <billing_account> <principal_id> <role>",
      missing: "Missing <billing_account>, <principal_id>, and/or <role>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org.members.setRole(ba, principalId, role), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "rm") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [ba, principalId] = requirePositionalCount(a, [], {
      min: 2, max: 2, command: "run402 org member rm <billing_account> <principal_id>",
      missing: "Missing <billing_account> and/or <principal_id>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org.members.revoke(ba, principalId), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  fail({ code: "BAD_USAGE", message: `Unknown 'org member' action: ${memberAction}. Try list | add | role | rm.` });
}

// ── Invite group ─────────────────────────────────────────────────────────────────

async function runInvite(args) {
  const inviteAction = args[0];
  const rest = args.slice(1);
  if (!inviteAction || inviteAction === "--help" || inviteAction === "-h") {
    console.log(SUB_HELP.invite);
    process.exit(inviteAction ? 0 : 1);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SUB_HELP.invite);
    process.exit(0);
  }

  if (inviteAction === "list") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [ba] = requirePositionalCount(a, [], {
      min: 1, max: 1, command: "run402 org invite list <billing_account>", missing: "Missing <billing_account>.",
    });
    try {
      console.log(JSON.stringify({ invites: await getSdk().org.invites.list(ba) }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (inviteAction === "create") {
    const a = normalizeArgv(rest);
    const valueFlags = ["--role", "--ttl-hours"];
    assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
    const role = flagValue(a, "--role");
    const ttlFlag = flagValue(a, "--ttl-hours");
    const [ba, email] = requirePositionalCount(a, valueFlags, {
      min: 2, max: 2, command: "run402 org invite create <billing_account> <email> [--role <role>]",
      missing: "Missing <billing_account> and/or <email>.",
    });
    const inviteTtlHours = ttlFlag === null ? undefined : parseIntegerFlag("--ttl-hours", ttlFlag, { min: 1, max: 8760 });
    try {
      const res = await getSdk().org.invites.create(ba, { email, role: role || "developer", inviteTtlHours });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (inviteAction === "rm") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [ba, principalId] = requirePositionalCount(a, [], {
      min: 2, max: 2, command: "run402 org invite rm <billing_account> <principal_id>",
      missing: "Missing <billing_account> and/or <principal_id>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org.invites.revoke(ba, principalId), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  fail({ code: "BAD_USAGE", message: `Unknown 'org invite' action: ${inviteAction}. Try list | create | rm.` });
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  // Nested groups use `if (sub === ...)` (not `case`) so the sync test extracts
  // their leaf actions via the dedicated memberAction/inviteAction parsers.
  if (sub === "member" || sub === "members") {
    await runMember(args ?? []);
    return;
  }
  if (sub === "invite" || sub === "invites") {
    await runInvite(args ?? []);
    return;
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h")) && SUB_HELP[sub]) {
    console.log(SUB_HELP[sub]);
    process.exit(0);
  }
  switch (sub) {
    case "whoami": await whoami(args); break;
    case "list": await list(args); break;
    case "audit": await audit(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
