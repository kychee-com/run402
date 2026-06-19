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

const HELP = `run402 org — organizations: create, label, membership, invites

Usage:
  run402 org create [--name <label>]
  run402 org list
  run402 org get    <org>
  run402 org rename <org> <display_name>   (or: --clear to remove the label)
  run402 org whoami
  run402 org audit  <org> [--limit N] [--after <cursor>] [--before <cursor>]
  run402 org member list <org>
  run402 org member add  <org> <wallet> [--role <role>]
  run402 org member role <org> <principal_id> <role>
  run402 org member rm   <org> <principal_id>
  run402 org invite list   <org>
  run402 org invite create <org> <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     <org> <principal_id>

Subcommands:
  create      Create an empty org on the prototype tier (you become owner)
  list        Orgs you are a member of
  get         Read one org (label + tier/lease + your role)
  rename      Set or clear an org's display label (owner-only)
  whoami      Resolved principal + org memberships (GET /agent/v1/whoami)
  member      Manage members (list, add, role, rm) — mutations require owner
  invite      Manage email invites (list, create, rm) — mutations require owner
  audit       Control-plane audit trail for an org (admin+)

Notes:
  - A wallet AUTHENTICATES; an org owns projects. Membership/role authorizes.
  - Roles: ${ROLE_LIST}. Member/invite changes need an active owner.
  - create/rename/member/invite are step-up gated for control-plane sessions.
  - Removing/demoting the org's only active owner fails with 409 LAST_OWNER.
  - JSON in, JSON out.

Examples:
  run402 org create --name "Kychee"
  run402 org list
  run402 org get org_abc
  run402 org rename org_abc "New Name"
  run402 org rename org_abc --clear
  run402 org member add org_abc 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --role admin
  run402 org invite create org_abc dev@example.com --role developer
  run402 org audit org_abc --limit 50
`;

const SUB_HELP = {
  create: `run402 org create — create an empty org (prototype tier; you become owner)

Usage:
  run402 org create [--name <label>]

The label is an optional free-text name (non-unique, not an id). Omit for an
unlabeled org. There is no tier input at create; the response reports the
created org's prototype tier plus lease_started_at / lease_expires_at. Paid
tiers are a separate flow. Step-up gated for control-plane sessions; the
free-org cap may apply.
`,
  list: `run402 org list — orgs you are a member of

Usage:
  run402 org list
`,
  get: `run402 org get — read one org (label + tier/lease + your role)

Usage:
  run402 org get <org>

Any active member may read. A non-member (including a guessed id) gets the same
non-revealing 403.
`,
  rename: `run402 org rename — set or clear an org's display label (owner-only)

Usage:
  run402 org rename <org> <display_name>
  run402 org rename <org> --clear

Owner-only + step-up gated. Pass --clear (or an empty display_name) to remove
the label. Output includes the updated tier and lease timestamps.
`,
  whoami: `run402 org whoami — resolved principal + org memberships

Usage:
  run402 org whoami

Calls GET /agent/v1/whoami. Returns the control-plane principal (id/type/display_name/created_at),
authenticator_id, and every org membership (org_id, display_name, role, status). REMOTE identity;
for local wallet/profile state use 'run402 status'.
`,
  member: `run402 org member — manage org members

Usage:
  run402 org member list <org>
  run402 org member add  <org> <wallet> [--role <role>]
  run402 org member role <org> <principal_id> <role>
  run402 org member rm   <org> <principal_id>

Roles: ${ROLE_LIST} (add defaults to developer). Mutations require an active owner.
Demoting/removing the org's only active owner fails with 409 LAST_OWNER.
`,
  invite: `run402 org invite — manage email invites

Usage:
  run402 org invite list   <org>
  run402 org invite create <org> <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     <org> <principal_id>

An invite is claimed at the recipient's first login. Mutations require an active owner
(plus step-up when driven by a control-plane session).
`,
  audit: `run402 org audit — control-plane audit trail

Usage:
  run402 org audit <org> [--limit N] [--after <cursor>] [--before <cursor>]

Requires an admin+ membership on the org. Newest-first. Page forward with --after
(next_cursor from a prior page); --before is the legacy cursor. Returns
{ events, has_more, next_cursor }.
`,
};

// ── Top-level: create / list / get / rename / whoami / audit ────────────────────

async function create(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--name"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, { min: 0, max: 0, command: "run402 org create [--name <label>]" });
  const name = flagValue(a, "--name");
  try {
    console.log(JSON.stringify(await getSdk().orgs.create({ displayName: name ?? undefined }), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org list" });
  try {
    console.log(JSON.stringify({ orgs: await getSdk().orgs.list() }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function whoami(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org whoami" });
  try {
    console.log(JSON.stringify(await getSdk().orgs.whoami(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  const [org] = requirePositionalCount(a, [], {
    min: 1, max: 1, command: "run402 org get <org>", missing: "Missing <org>.",
  });
  try {
    console.log(JSON.stringify(await getSdk().org(org).get(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rename(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--clear", "--help", "-h"]);
  const clear = a.includes("--clear");
  const positionals = requirePositionalCount(a, [], {
    min: clear ? 1 : 2,
    max: clear ? 1 : 2,
    command: "run402 org rename <org> <display_name>",
    missing: clear ? "Missing <org>." : "Missing <org> and/or <display_name> (or pass --clear).",
  });
  const org = positionals[0];
  const displayName = clear ? null : positionals[1];
  try {
    console.log(JSON.stringify(await getSdk().org(org).rename(displayName), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function audit(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--limit", "--after", "--before"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const [org] = requirePositionalCount(a, valueFlags, {
    min: 1,
    max: 1,
    command: "run402 org audit <org>",
    missing: "Missing <org>.",
  });
  const limitFlag = flagValue(a, "--limit");
  const after = flagValue(a, "--after");
  const before = flagValue(a, "--before");
  const limit = limitFlag === null ? undefined : parseIntegerFlag("--limit", limitFlag, { min: 1, max: 1000 });
  try {
    const result = await getSdk().org(org).audit({
      limit,
      after: after ?? undefined,
      before: before ?? undefined,
    });
    console.log(JSON.stringify(result, null, 2));
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
    const [org] = requirePositionalCount(a, [], {
      min: 1, max: 1, command: "run402 org member list <org>", missing: "Missing <org>.",
    });
    try {
      console.log(JSON.stringify({ members: await getSdk().org(org).members.list() }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "add") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--role", "--help", "-h"], ["--role"]);
    const role = flagValue(a, "--role");
    const [org, wallet] = requirePositionalCount(a, ["--role"], {
      min: 2, max: 2, command: "run402 org member add <org> <wallet> [--role <role>]",
      missing: "Missing <org> and/or <wallet>.",
    });
    try {
      const res = await getSdk().org(org).members.add({ wallet, role: role || undefined });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "role") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [org, principalId, role] = requirePositionalCount(a, [], {
      min: 3, max: 3, command: "run402 org member role <org> <principal_id> <role>",
      missing: "Missing <org>, <principal_id>, and/or <role>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org(org).members.setRole(principalId, role), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "rm") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [org, principalId] = requirePositionalCount(a, [], {
      min: 2, max: 2, command: "run402 org member rm <org> <principal_id>",
      missing: "Missing <org> and/or <principal_id>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org(org).members.revoke(principalId), null, 2));
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
    const [org] = requirePositionalCount(a, [], {
      min: 1, max: 1, command: "run402 org invite list <org>", missing: "Missing <org>.",
    });
    try {
      console.log(JSON.stringify({ invites: await getSdk().org(org).invites.list() }, null, 2));
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
    const [org, email] = requirePositionalCount(a, valueFlags, {
      min: 2, max: 2, command: "run402 org invite create <org> <email> [--role <role>]",
      missing: "Missing <org> and/or <email>.",
    });
    const inviteTtlHours = ttlFlag === null ? undefined : parseIntegerFlag("--ttl-hours", ttlFlag, { min: 1, max: 8760 });
    try {
      const res = await getSdk().org(org).invites.create({ email, role: role || "developer", inviteTtlHours });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (inviteAction === "rm") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--help", "-h"]);
    const [org, principalId] = requirePositionalCount(a, [], {
      min: 2, max: 2, command: "run402 org invite rm <org> <principal_id>",
      missing: "Missing <org> and/or <principal_id>.",
    });
    try {
      console.log(JSON.stringify(await getSdk().org(org).invites.revoke(principalId), null, 2));
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
    case "create": await create(args); break;
    case "list": await list(args); break;
    case "get": await get(args); break;
    case "rename": await rename(args); break;
    case "whoami": await whoami(args); break;
    case "audit": await audit(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
