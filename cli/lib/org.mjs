import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { readBindingFile, updateBindingFile } from "./wallet-context.mjs";
import { nextAction } from "./next-actions.mjs";
import {
  requireOrgIdShape,
  resolveOrg,
  takeOrgPositional,
  requireRest,
  orgProvenance,
  getSelectedOrgId,
  setSelectedOrgId,
  clearSelectedOrgId,
} from "./org-context.mjs";
import {
  normalizeArgv,
  assertKnownFlags,
  flagValue,
  positionalArgs,
  parseIntegerFlag,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";

const ROLE_LIST = "owner | admin | developer | billing | viewer";

const HELP = `run402 org — organizations: create, label, membership, invites

Usage:
  run402 org create [--name <label>]
  run402 org list
  run402 org get    [<org_id>]
  run402 org rename [<org_id>] --name <display_name>   (or: --clear to remove the label)
  run402 org payout-wallet [<org_id>] <wallet_address>  (or: --clear to remove the explicit default)
  run402 org slug   <slug> [--org <org_id>]
  run402 org whoami
  run402 org use     <org_id>
  run402 org current
  run402 org clear
  run402 org bind   [--org <org_id>] [--room <key>]
  run402 org unbind
  run402 org audit  [<org_id>] [--limit N] [--after <cursor>] [--before <cursor>]
  run402 org member list [<org_id>]
  run402 org member add  [<org_id>] <wallet_address> [--role <role>]
  run402 org member role [<org_id>] --principal <principal_id> --role <role>
  run402 org member rm   [<org_id>] --principal <principal_id>
  run402 org member revoke-key [<org_id>] --principal <principal_id> [--reason <why>]   (owner + step-up; revokes the member's gitvault encryption key — its next gitvault operation enrolls afresh)
  run402 org invite list   [<org_id>]
  run402 org invite create [<org_id>] --email <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     [<org_id>] --principal <principal_id>

<org_id> is optional everywhere: a leading UUID positional addresses that org;
omit it and the org comes from --org, then RUN402_ORG, then the .run402.json
binding, then 'run402 org use'. Inside a bound checkout two agents add each
other with nothing to look up: run402 org member add <wallet_address> --role developer.
A developer-or-above add REFUSES (GITVAULT_WRITER_NOT_ADMITTED) unless this session's key is an admitted writer on every vault of the org, so the new member can push at once; a current writer admits your key with run402 repos access sync.
The second attribute may also be passed positionally (run402 org member add <wallet_address>).

Subcommands:
  create      Create an empty org on the prototype tier (you become owner)
  list        Orgs you are a member of
  get         Read one org (label + tier/lease + your role)
  rename      Set or clear an org's display label (owner-only)
  slug        Claim or rename the org's globally-unique, address-form slug
              (owner-only). A genesis claim spends a one-time claim fee; a
              rename releases the old slug into a ~90-day cooldown.
  use         Select the current org for this wallet profile
  current     Report the resolved current org and where it came from
  clear       Clear this wallet profile's org selection
  bind        Write this checkout's org (+room) into .run402.json — commit it
  unbind      Remove the org/room keys from .run402.json
  payout-wallet  Set or clear the tenant route payout wallet (admin+)
  whoami      Resolved principal + org memberships (GET /agent/v1/whoami)
  member      Manage members (list, add, role, rm) — mutations require owner
  invite      Manage email invites (list, create, rm) — mutations require owner
  audit       Control-plane audit trail for an org (admin+)

Notes:
  - A wallet AUTHENTICATES; an org owns projects. Membership/role authorizes.
  - Roles: ${ROLE_LIST}. Member/invite changes need an active owner.
  - create/rename/payout-wallet/member/invite are step-up gated for control-plane sessions.
  - Removing/demoting the org's only active owner fails with 409 LAST_OWNER.
  - JSON in, JSON out.

Examples:
  run402 org create --name "Kychee"
  run402 org list
  run402 org get                      # the current org (binding / org use)
  run402 org get 8f14e45f-ceea-4b7a-9d3c-0b2a6e6f1c2d
  run402 org rename --name "New Name"
  run402 org rename --clear
  run402 org payout-wallet 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  run402 org payout-wallet --clear
  run402 org member add 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --role admin
  run402 org member add 8f14e45f-ceea-4b7a-9d3c-0b2a6e6f1c2d 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --role admin
  run402 org invite create dev@example.com --role developer
  run402 org audit --limit 50
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
  run402 org get [<org_id>]

Any active member may read. A non-member (including a guessed id) gets the same
non-revealing 403.
`,
  rename: `run402 org rename — set or clear an org's display label (owner-only)

Usage:
  run402 org rename [<org_id>] --name <display_name>
  run402 org rename [<org_id>] --clear

Legacy (still supported):
  run402 org rename [<org_id>] <display_name>

Owner-only + step-up gated. Pass --clear (or an empty display_name) to remove
the label. Output includes the updated tier and lease timestamps.
`,
  slug: `run402 org slug — claim or rename the org's address-form slug

Usage:
  run402 org slug <slug> [--org <org_id>] [--idempotency-key <key>]

The slug is a globally-unique, claimable, address-form handle for the org
(repo-first-onramp design D6) — the <org-slug> half of a named repo address
run402::<org-slug>/<name>. Grammar: lowercase [a-z0-9-], no leading/trailing/
double hyphen, max 39 chars. Owner-only.

A genesis claim (the org had no prior slug) spends a one-time claim fee off
the org's balance. A rename is free but releases the OLD slug into a ~90-day
cooldown: it stops resolving, with a typed SLUG_RELEASED refusal naming the
new slug as successor — there is no redirect, so update every remote and
address that still names the old one.

This is a paid, side-effecting mutation and requires Idempotency-Key; the SDK
generates one automatically unless --idempotency-key is passed, so a retried
call after a dropped response can never double-bill.
`,
  "payout-wallet": `run402 org payout-wallet — set or clear the tenant route payout wallet

Usage:
  run402 org payout-wallet [<org_id>] <wallet_address>
  run402 org payout-wallet [<org_id>] --clear

Legacy (still supported):
  run402 org payout-wallet [<org_id>] <wallet_address>

Admin/owner-only + step-up gated. The wallet must already be active and linked
to the same org. This wallet receives x402 settlement for function web routes
that declare pricing.pay_to = "org_default_payout". Pass --clear to remove the
explicit default; a single active org wallet may still resolve automatically.

The JSON response includes recovery.status, active_wallet_count, and
next_actions for PAYOUT_WALLET_REQUIRED / PAYOUT_WALLET_AMBIGUOUS setup.
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
  run402 org member list [<org_id>]
  run402 org member add  [<org_id>] <wallet_address> [--role <role>]
  run402 org member role [<org_id>] --principal <principal_id> --role <role>
  run402 org member rm   [<org_id>] --principal <principal_id>
  run402 org member revoke-key [<org_id>] --principal <principal_id> [--reason <why>]   (owner + step-up; revokes the member's gitvault encryption key — its next gitvault operation enrolls afresh)

Roles: ${ROLE_LIST} (add defaults to developer). Mutations require an active owner.
Demoting/removing the org's only active owner fails with 409 LAST_OWNER.
`,
  invite: `run402 org invite — manage email invites

Usage:
  run402 org invite list   [<org_id>]
  run402 org invite create [<org_id>] --email <email> [--role <role>] [--ttl-hours N]
  run402 org invite rm     [<org_id>] --principal <principal_id>

<org_id> is optional everywhere: a leading UUID positional addresses that org;
omit it and the org comes from --org, then RUN402_ORG, then the .run402.json
binding, then 'run402 org use'. Inside a bound checkout two agents add each
other with nothing to look up: run402 org member add <wallet_address> --role developer.
A developer-or-above add REFUSES (GITVAULT_WRITER_NOT_ADMITTED) unless this session's key is an admitted writer on every vault of the org, so the new member can push at once; a current writer admits your key with run402 repos access sync.
The second attribute may also be passed positionally (run402 org member add <wallet_address>).

An invite is claimed at the recipient's first login. Mutations require an active owner
(plus step-up when driven by a control-plane session).
`,
  audit: `run402 org audit — control-plane audit trail

Usage:
  run402 org audit [<org_id>] [--limit N] [--after <cursor>] [--before <cursor>]

Requires an admin+ membership on the org. Newest-first. Page forward with --after
(next_cursor from a prior page); --before is the legacy cursor. Returns
{ events, has_more, next_cursor }.
`,
};

// ── Top-level: create / list / get / rename / whoami / audit ────────────────────


/**
 * gitvault-multi-writer (rev 47) task 6.3 / design D3 — decided 2026-09-03
 * (Tal): `org member add` REFUSES a writer-eligible add (developer or
 * above) when this session's own key is not an admitted writer on EVERY
 * vault of the org, because a developer who cannot push is not the member
 * the caller meant, and a half-usable membership is exactly the silent
 * failure the multi-writer change exists to end. No warn path, no escape
 * flag: the fix is for a current writer of the named vault(s) to admit this
 * key (`run402 repos access sync`, or any push) and re-run — or to run
 * the add themselves. Viewer/billing adds never reach this gate; an org
 * with no vaults has nothing to admit; a vault in the read-only terminal
 * state (its last writer gone) is skipped, since nobody can admit there.
 * Every read failure REFUSES too (an unverifiable gate is not a passed one).
 */
async function assertCallerCanAdmitWritersEverywhere(sdk, orgId, effectiveRole) {
  const listing = await sdk.gitvault.listByOrg(orgId);
  const vaults = listing?.vaults ?? [];
  const blocked = [];
  for (const v of vaults) {
    const st = await sdk.gitvault.status({ repo_id: v.repo_id, reconcile: "forbidden" });
    const vault = st?.vault ?? null;
    if (!vault || vault.read_only_terminal) continue;
    const me = st?.keystore?.identity_fingerprint ?? null;
    const writers = vault.writer_set?.writers ?? [];
    if (!me || !writers.some((w) => w.writer_key_id === me)) blocked.push({ repo_id: v.repo_id, repo_name: v.repo_name ?? null, project_id: v.project_id ?? null });
  }
  if (blocked.length > 0) {
    fail({
      code: "GITVAULT_WRITER_NOT_ADMITTED",
      message: `refusing to add a ${effectiveRole}: this session's key is not an admitted writer on ${blocked.length} of this org's ${vaults.length} vault(s), so the new member could not push there`,
      details: { role: effectiveRole, vaults: blocked, checked: vaults.length },
      next_actions: [
        {
          type: "request_writer_sync",
          why: "A current writer of the named vault(s) admits YOUR key by running `run402 repos access sync` there (any push does it too); then re-run this command — or have that writer run it.",
          safe_to_auto_execute: false,
        },
      ],
    });
  }
  return { checked: vaults.length };
}

/**
 * `org member rm`'s inline epoch rotation (gitvault-multi-writer D6, the
 * kygit-handoff member-removal decision): for every vault of the org where
 * this session's key is an admitted writer, drive
 * `rotateEpochForKeyRevocation(principalId)` — the one self-contained
 * rotation entry point — so the removed member is out of the next epoch and
 * the survivors' pushes are admissible again. Returns null when the org holds
 * no vault (nothing to rotate, nothing to report).
 */
async function rotateOrgVaultsAfterRemoval(sdk, orgId, principalId) {
  const listing = await sdk.gitvault.listByOrg(orgId);
  const vaults = listing?.vaults ?? [];
  if (vaults.length === 0) return null;
  const rotated = [];
  const notWriter = [];
  const errors = [];
  for (const v of vaults) {
    let st;
    try {
      st = await sdk.gitvault.status({ repo_id: v.repo_id, reconcile: "forbidden" });
    } catch (err) {
      errors.push({ repo_id: v.repo_id, code: err?.code ?? null, error: err?.message ?? String(err) });
      continue;
    }
    const vault = st?.vault ?? null;
    if (!vault || vault.read_only_terminal) continue;
    const me = st?.keystore?.identity_fingerprint ?? null;
    const writers = vault.writer_set?.writers ?? [];
    if (!me || !writers.some((w) => w.writer_key_id === me)) {
      notWriter.push(v.repo_id);
      continue;
    }
    try {
      // reason:"member_removed" — writer-capable (no owner step-up); the
      // removal itself advanced the counters this rotation is fenced on.
      const r = await sdk.gitvault.rotateEpochForMemberRemoval({ repo_id: v.repo_id });
      rotated.push({ repo_id: v.repo_id, new_epoch: r.new_epoch, generation: r.generation, included: r.included.length, writers_removed: r.writers_removed?.length ?? 0, self_check: r.self_check });
    } catch (err) {
      errors.push({ repo_id: v.repo_id, code: err?.code ?? null, error: err?.message ?? String(err) });
    }
  }
  return { attempted: vaults.length, rotated, not_writer: notWriter, errors };
}

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

// ── Current organization (add-cli-current-org) ─────────────────────────────────
//
// The selection is per WALLET PROFILE, not global: the chain is
// wallet -> principal -> memberships, so a global selection survives
// `wallets use other` and then either 403s or silently resolves to a
// valid-but-wrong org when both principals are members.

async function use(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], {
    min: 1, max: 1, command: "run402 org use <org_id>", missing: "<org_id>",
  });
  const orgId = positionalArgs(a, [])[0];
  setSelectedOrgId(orgId);
  console.log(JSON.stringify({ org_id: orgId, selected: true, scope: "wallet_profile" }, null, 2));
}

async function clear(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org clear" });
  const previous = getSelectedOrgId();
  clearSelectedOrgId();
  console.log(JSON.stringify({ org_id: null, selected: false, previous_org_id: previous ?? null }, null, 2));
}

/**
 * Slugify a directory name into a legal room key.
 * Room keys match /^[a-z0-9][a-z0-9._-]{0,63}$/ (the DB CHECK on every
 * agent-messaging table), so the repo's own name has to be coerced, not trusted.
 */
function roomKeyFromDir(dir) {
  const base = dir.split("/").filter(Boolean).pop() ?? "";
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 64);
  return /^[a-z0-9]/.test(slug) ? slug : null;
}

/**
 * Write this checkout's org (and room) into `.run402.json`.
 *
 * WHY THIS PICKS FOR YOU WHEN YOU OWN EXACTLY ONE ORG, while the resolution
 * chain never does: they are different acts. The chain runs on EVERY command
 * and must not change meaning the day you are invited to a second org — so it
 * refuses to infer. This runs ONCE, because you asked it to, and it WRITES THE
 * ANSWER DOWN. Nothing is inferred afterwards; the file is read verbatim
 * forever after. An explicit act with a recorded result is not a heuristic.
 *
 * With two or more orgs there is nothing to pick, so it lists them and stops.
 */
async function bind(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--org", "--room"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, { min: 0, max: 0, command: "run402 org bind [--org <org_id>] [--room <key>]" });

  let orgId = flagValue(a, "--org");
  let picked = "flag";
  if (!orgId) {
    let orgs;
    try {
      orgs = await getSdk().orgs.list();
    } catch (err) {
      reportSdkError(err);
      return;
    }
    const rows = Array.isArray(orgs) ? orgs : (orgs?.orgs ?? []);
    if (rows.length === 0) {
      fail({
        code: "NO_ORGS",
        message: "This wallet is a member of no organization yet.",
        hint: "Run 'run402 init' to provision one, or ask an owner to add you with 'run402 org member add'.",
        next_actions: [nextAction("initialize_wallet", { command: "run402 init", why: "Provision this wallet's organization, then retry." })],
      });
    }
    if (rows.length > 1) {
      fail({
        code: "AMBIGUOUS_ORG",
        message: `This wallet belongs to ${rows.length} organizations — name the one to bind.`,
        hint: "run402 org bind --org <org_id>",
        details: { orgs: rows.map((o) => ({ org_id: o.org_id, display_name: o.display_name ?? null, role: o.role ?? null })) },
        next_actions: [nextAction("edit_request", { command: "run402 org bind --org <org_id>", why: "Name which organization this checkout coordinates in." })],
      });
    }
    orgId = rows[0].org_id;
    picked = "sole_membership";
  }

  const room = flagValue(a, "--room") ?? roomKeyFromDir(process.cwd());
  const { contents, file } = updateBindingFile(process.cwd(), {
    org: requireOrgIdShape(orgId, picked === "flag" ? "--org" : "org list"),
    ...(room ? { room } : {}),
  });
  console.log(JSON.stringify({
    org_id: orgId,
    room_key: room ?? null,
    org_source: picked,
    file: ".run402.json",
    path: file,
    bound: true,
    safe_to_commit: true,
    note: "Safe to commit — an org id is an identifier, not a credential; authorization stays server-side.",
    binding: contents,
  }, null, 2));
}

async function unbind(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org unbind" });
  const previous = readBindingFile(process.cwd());
  const { contents, removed } = updateBindingFile(process.cwd(), { org: null, room: null });
  console.log(JSON.stringify({
    file: ".run402.json",
    unbound: previous.org !== undefined || previous.room !== undefined,
    removed,
    binding: contents,
  }, null, 2));
}

async function current(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 org current" });
  try {
    // `cmd: "org"` exempts this from the ambiguity error on purpose: the
    // command that reports the selection must stay usable while it is ambiguous.
    // `optional` keeps an empty selection an explicit null state rather than a
    // failure — reporting is not acting.
    const resolved = await resolveOrg([], { cmd: "org", optional: true });
    console.log(JSON.stringify({
      ...orgProvenance(resolved),
      selected_org_id: getSelectedOrgId() ?? null,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function get(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
  const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org"], { cmd: "org" });
  requireRest(pos, { max: 0, command: "run402 org get [<org_id>]" });
  try {
    console.log(JSON.stringify(await getSdk().org(org).get(), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rename(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--name", "--clear", "--help", "-h"], ["--org", "--name"]);
  const clear = a.includes("--clear");
  const nameFlag = flagValue(a, "--name");
  const single = clear || nameFlag !== null;
  const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--name"], { cmd: "org" });
  requireRest(pos, {
    min: single ? 0 : 1,
    max: single ? 0 : 1,
    command: "run402 org rename [<org_id>] --name <display_name>",
    missing: "Missing <display_name> (use --name, or pass --clear).",
  });
  const displayName = clear ? null : (nameFlag ?? pos[0]);
  try {
    console.log(JSON.stringify(await getSdk().org(org).rename(displayName), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function payoutWallet(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--address", "--clear", "--help", "-h"], ["--org", "--address"]);
  const clear = a.includes("--clear");
  const walletFlag = flagValue(a, "--address");
  const single = clear || walletFlag !== null;
  const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--address"], { cmd: "org" });
  requireRest(pos, {
    min: single ? 0 : 1,
    max: single ? 0 : 1,
    command: "run402 org payout-wallet [<org_id>] --address <wallet_address>",
    missing: "Missing <wallet_address> (use --address, or pass --clear).",
  });
  const walletAddress = clear ? null : (walletFlag ?? pos[0]);
  try {
    console.log(JSON.stringify(await getSdk().org(org).setPayoutWallet({ walletAddress }), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 org slug <slug>` — claim or rename the org's address-form slug.
 * Owner-only, and a genesis claim spends a one-time claim fee — this is a
 * PAID, side-effecting mutation, so it
 * requires `Idempotency-Key`; the SDK generates one client-side when
 * `--idempotency-key` is omitted, so a retried call after a dropped response
 * can never double-bill.
 */
async function slug(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--org", "--idempotency-key"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const [newSlug] = requirePositionalCount(a, valueFlags, {
    min: 1,
    max: 1,
    command: "run402 org slug <slug> [--org <org_id>]",
    missing: "Missing <slug>.",
  });
  const org = await resolveOrg(a, { cmd: "org" });
  if (!org) {
    fail({
      code: "ORG_UNRESOLVED",
      message: "Could not resolve which organization to claim this slug for.",
      hint: "Pass --org <org_id>, or select one first with `run402 org use <id>`.",
    });
  }
  const idempotencyKey = flagValue(a, "--idempotency-key");
  try {
    const result = await getSdk().org(org.orgId).claimSlug(newSlug, idempotencyKey != null ? { idempotencyKey } : {});
    console.log(JSON.stringify(result, null, 2));
    if (result.created) {
      console.error(`slug "${result.slug}" claimed for ${org.orgId} — a one-time claim fee was debited from the org's balance.`);
    } else if (result.previous_slug && result.previous_slug !== result.slug) {
      console.error(
        `org ${org.orgId} renamed from "${result.previous_slug}" to "${result.slug}" — no fee. ` +
        `"${result.previous_slug}" now enters its ~90-day release cooldown: it stops resolving with a typed SLUG_RELEASED refusal (naming "${result.slug}" as the successor), never a redirect. Update every remote and address that still names it.`,
      );
    } else {
      console.error(`"${result.slug}" was already ${org.orgId}'s current slug — nothing changed, no fee.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function audit(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--org", "--limit", "--after", "--before"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const { orgId: org, rest: pos } = await takeOrgPositional(a, valueFlags, { cmd: "org" });
  requireRest(pos, { max: 0, command: "run402 org audit [<org_id>]" });
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
    assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org"], { cmd: "org" });
    requireRest(pos, { max: 0, command: "run402 org member list [<org_id>]" });
    try {
      console.log(JSON.stringify({ members: await getSdk().org(org).members.list() }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "add") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org", "--role", "--address", "--help", "-h"], ["--org", "--role", "--address"]);
    const role = flagValue(a, "--role");
    const walletFlag = flagValue(a, "--address");
    const count = walletFlag ? 0 : 1;
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--role", "--address"], { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org member add [<org_id>] <wallet_address> [--role <role>]",
      missing: "Missing <wallet_address> (positional, or --address).",
    });
    const wallet = walletFlag ?? pos[0];
    try {
      const sdk = getSdk();
      // The gateway's own default role for a wallet add is developer — a
      // writer-eligible role — so an add with no --role is gated too.
      const effectiveRole = role || "developer";
      if (["owner", "admin", "developer"].includes(effectiveRole)) {
        await assertCallerCanAdmitWritersEverywhere(sdk, org, effectiveRole);
      }
      const res = await sdk.org(org).members.add({ wallet, role: role || undefined });
      // gitvault-multi-writer (rev 47) task 6.3 — the gateway names which of
      // this org's vaults now have a pending writer candidate (D3: there is
      // no server-side writer admission — the client holds the keys) via a
      // `sync_writers` next_action carrying `vault_ids[]`. Run the ACTUAL
      // reconcile against each one now, so a single `org member add` finishes
      // the whole job when the caller can. `reconcile()` is ALREADY a
      // fast, network-free no-op per vault when this session's own key
      // isn't a writer there (task 5.7's own `eligible` gate). For a
      // writer-eligible add the gate above already proved this session IS
      // a writer on every vault, so `not_eligible` here can only name a
      // vault that changed under us in the meantime — reported, never
      // silently dropped.
      const syncTarget = res.next_actions?.find((n) => n?.type === "sync_writers");
      let writerSync = null;
      if (syncTarget?.vault_ids?.length > 0) {
        const admitted = [];
        const notEligible = [];
        const errors = [];
        for (const vaultId of syncTarget.vault_ids) {
          try {
            const r = await sdk.gitvault.reconcile({ repo_id: vaultId });
            if (!r.eligible) notEligible.push(vaultId);
            else if (r.admitted.length > 0) admitted.push({ repo_id: vaultId, admitted: r.admitted });
          } catch (err) {
            errors.push({ repo_id: vaultId, error: err?.message ?? String(err) });
          }
        }
        writerSync = { attempted: syncTarget.vault_ids.length, admitted, not_eligible: notEligible, errors };
      }
      console.log(JSON.stringify(writerSync ? { ...res, writer_sync: writerSync } : res, null, 2));
      if (writerSync?.not_eligible.length > 0) {
        console.error(`writer sync: this session is not (yet) a writer on ${writerSync.not_eligible.length} vault(s) — the new member is a pending writer candidate there until a CURRENT writer's next gitvault operation admits them.`);
      }
      if (writerSync?.errors.length > 0) {
        for (const e of writerSync.errors) console.error(`writer sync: ${e.repo_id} — ${e.error}`);
      }
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "revoke-key") {
    // gitvault-agent-envelopes D3: owner + step-up revokes a member's current
    // gitvault encryption key — the ONLY rotation path for a member that shares
    // an org with another custodian (a lost/rebuilt keystore fails
    // GITVAULT_KEY_ROTATION_REQUIRED and points here). Adapter only.
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org", "--principal", "--reason", "--help", "-h"], ["--org", "--principal", "--reason"]);
    const principalFlag = flagValue(a, "--principal");
    const reason = flagValue(a, "--reason");
    const count = principalFlag ? 0 : 1;
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--principal", "--reason"], { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org member revoke-key [<org_id>] --principal <principal_id> [--reason <why>]",
      missing: "Missing <principal_id> (--principal).",
    });
    const principalId = principalFlag ?? pos[0];
    try {
      console.log(JSON.stringify(await getSdk().org(org).members.revokeEncryptionKey(principalId, reason ? { reason } : {}), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "role") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org", "--principal", "--role", "--help", "-h"], ["--org", "--principal", "--role"]);
    const principalFlag = flagValue(a, "--principal");
    const roleFlag = flagValue(a, "--role");
    const count = 2 - (principalFlag ? 1 : 0) - (roleFlag ? 1 : 0);
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--principal", "--role"], { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org member role [<org_id>] --principal <principal_id> --role <role>",
      missing: "Missing <principal_id> (--principal) and/or <role> (--role).",
    });
    const principalId = principalFlag ?? pos[0];
    const role = roleFlag ?? (principalFlag ? pos[0] : pos[1]);
    try {
      console.log(JSON.stringify(await getSdk().org(org).members.setRole(principalId, { role }), null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (memberAction === "rm") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org", "--principal", "--help", "-h"], ["--org", "--principal"]);
    const principalFlag = flagValue(a, "--principal");
    const count = principalFlag ? 0 : 1;
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--principal"], { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org member rm [<org_id>] --principal <principal_id>",
      missing: "Missing <principal_id> (use --principal).",
    });
    const principalId = principalFlag ?? pos[0];
    try {
      const sdk = getSdk();
      const res = await sdk.org(org).members.revoke(principalId);
      // gitvault-multi-writer D6 — a removal rides `rotate_epoch`: the gateway
      // has just blocked the principal's writer keys and flipped its desired
      // row to pending_removal, so every ordinary push on every vault of this
      // org now refuses EPOCH_ROTATION_REQUIRED until a surviving writer
      // rotates. Do that HERE, on every vault where this session's key IS a
      // writer (the same "one command finishes the job" shape `member add`'s
      // inline writer sync has), so the survivors keep pushing. A vault this
      // session cannot rotate is named; a writer there runs
      // `run402 repos access revoke-key <principal_id>` (the next push names it).
      const rotation = await rotateOrgVaultsAfterRemoval(sdk, org, principalId);
      console.log(JSON.stringify(rotation ? { ...res, epoch_rotation: rotation } : res, null, 2));
      if (rotation) {
        for (const r of rotation.rotated) console.error(`rotated ${r.repo_id} to epoch ${r.new_epoch} at generation ${r.generation}: ${r.included} recipient(s) included, ${r.writers_removed} writer key(s) removed.`);
        if (rotation.not_writer.length > 0) console.error(`epoch rotation: this session's key is not a writer on ${rotation.not_writer.length} vault(s) (${rotation.not_writer.join(", ")}) — pushes there refuse EPOCH_ROTATION_REQUIRED until a writer runs \`run402 repos access revoke-key ${principalId}\` in that checkout.`);
        for (const e of rotation.errors) console.error(`epoch rotation: ${e.repo_id} — ${e.code ? `${e.code}: ` : ""}${e.error}`);
      }
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
    assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org"], { cmd: "org" });
    requireRest(pos, { max: 0, command: "run402 org invite list [<org_id>]" });
    try {
      console.log(JSON.stringify({ invites: await getSdk().org(org).invites.list() }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  if (inviteAction === "create") {
    const a = normalizeArgv(rest);
    const valueFlags = ["--org", "--role", "--ttl-hours", "--email"];
    assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
    const role = flagValue(a, "--role");
    const ttlFlag = flagValue(a, "--ttl-hours");
    const emailFlag = flagValue(a, "--email");
    const count = emailFlag ? 0 : 1;
    const { orgId: org, rest: pos } = await takeOrgPositional(a, valueFlags, { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org invite create [<org_id>] --email <email> [--role <role>]",
      missing: "Missing <email> (use --email).",
    });
    const email = emailFlag ?? pos[0];
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
    assertKnownFlags(a, ["--org", "--principal", "--help", "-h"], ["--org", "--principal"]);
    const principalFlag = flagValue(a, "--principal");
    const count = principalFlag ? 0 : 1;
    const { orgId: org, rest: pos } = await takeOrgPositional(a, ["--org", "--principal"], { cmd: "org" });
    requireRest(pos, {
      min: count, max: count, command: "run402 org invite rm [<org_id>] --principal <principal_id>",
      missing: "Missing <principal_id> (use --principal).",
    });
    const principalId = principalFlag ?? pos[0];
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
    case "payout-wallet": await payoutWallet(args); break;
    case "slug": await slug(args); break;
    case "whoami": await whoami(args); break;
    case "use": await use(args); break;
    case "current": await current(args); break;
    case "clear": await clear(args); break;
    case "bind": await bind(args); break;
    case "unbind": await unbind(args); break;
    case "audit": await audit(args); break;
    default:
      failUnknownSubcommand("org", sub);
  }
}
