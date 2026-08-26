/**
 * `run402 repos` — vault-only porcelain (repo-first-onramp design D8, task 2.6).
 *
 * CLI + OpenClaw ONLY — no MCP tool exists for this family, and none should
 * be added. documentation.md's gitvault row records the law:
 * "Mutating verbs are CLI-only by design (immutable generations with no
 * undo, the one-shot recovery receipt, ..., destructive prune, owner+step-up
 * policy)." `create` mints a vault's one-shot recovery receipt; `delete` is
 * destructive. `list` is read-only and could in principle get an MCP tool
 * later, but ships alongside its two siblings here rather than splitting a
 * three-verb family across two client surfaces on day one.
 *
 * `create` composes provision + vault ALLOCATE (not lazy — the whole point
 * of this command is a repo that exists the moment it returns) + remote
 * scaffold, with ZERO deploy ceremony: no manifest, no plan, no release.
 * This is D1 (`origin` claimed additively) and D4's `gitvault.init` primitive
 * end to end — `repos create` adds no protocol behavior of its own, only
 * argument parsing and output shaping (the architectural law every shim in
 * this repo follows).
 *
 * `list` is the org's vault-bearing projects, cross-referenced CLIENT-SIDE:
 * list the org's projects, then read each one's gitvault status. There is no
 * bulk "vaults by org" gateway read yet (rung 2 territory), so this is
 * sequential N+1 — fine for a one-shot CLI call against a person's or
 * agent's own project count, not something to build a server round-trip
 * budget around. A project whose vault status cannot be read is skipped
 * silently rather than failing the whole listing.
 *
 * `delete` refuses while the vault holds any admitted generation unless
 * --force is passed, after naming exactly what would be lost (repo id,
 * generation count, encrypted-source byte count). It then calls the SAME
 * `projects.delete` primitive `run402 projects delete` uses — --force here
 * IS the explicit confirmation; there is no second --confirm to pass.
 */
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { withAutoApprove } from "./operator.mjs";
import { allowanceAuthHeaders, isCoreApiTarget, resolveProjectId } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { resolveOrgId, resolveOwningOrgId } from "./org-context.mjs";
import { nextAction, claimOrgSlugAction, claimRepoNameAction } from "./next-actions.mjs";
import { printKeystoreLocation } from "./gitvault.mjs";
import { gitvaultRemoteUrlForRepo } from "#sdk";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

export const HELP = `run402 repos — vault-only hosted encrypted repos, zero deploy ceremony

Usage:
  run402 repos create <name> [--org <org_id>] [--dir <path>] [--tier <tier>]
  run402 repos list   [--org <org_id>]
  run402 repos delete <project_id> [--force]
  run402 repos name   <name> [--project <id>]

Subcommands:
  create  Provision a project, ALLOCATE its vault (mints key material and a
          one-shot recovery receipt), and scaffold the run402 remote —
          origin when free, run402 when taken (D1). No deploy plan, no
          release, nothing deployed: the vault-only track (design D8), for a
          project that only ever hosts encrypted source. When the owning org
          has a slug (run402 org slug), also claims the project's address-
          form repo name (best-effort — a name collision or missing slug
          never fails the command) and prints the run402::<slug>/<name>
          address (design D6).
  list    The organization's vault-bearing projects — those with an
          allocated vault, whether or not they have ever deployed. Not
          every project in the org; ones with no vault are omitted. Shows
          the run402::<slug>/<name> address for a repo that has claimed one.
  delete  Delete the project and everything in it (database, functions,
          subdomains, mailbox, secrets). REFUSES while the vault holds any
          admitted generation unless --force is passed — this is
          irreversible and destroys the vault's entire encrypted history
          along with everything else.
  name    Claim or rename the project's per-org-unique, address-form name
          (design D6) — the <name> half of run402::<org-slug>/<name>. No
          fee, unlike the org slug. Same authority as renaming the project.

Options:
  --org <org_id>    create/list: the owning organization. create resolves it
                     the same way 'projects provision' does when omitted
                     (cold-start); list requires resolving one — pass it, or
                     select an active org first with 'run402 org use <id>'.
  --dir <path>      create: the working tree to scaffold (default: cwd). Not
                     a git repository yet? One is created — 'repos create' is
                     a from-a-directory-to-a-hosted-repo verb by definition,
                     the same way 'gh repo create --source=.' is.
  --tier <tier>     create: project tier (default: prototype)
  --idempotency-key <key>
                     create: re-running with the same key resolves to the
                     same project instead of creating a second one (default:
                     derived from the name)
  --force           delete: proceed even though the vault holds generations
                     that would be permanently and irrecoverably lost
  --project <id>    name: project to claim the repo name for (default: the
                     active project)
  --json            No-op: stdout is already JSON.

There is no separate gitvault price: bytes count against the same
organization-pooled storage budget every project already has.
`;

const CREATE_VALUE_FLAGS = ["--org", "--dir", "--tier", "--idempotency-key"];
const LIST_VALUE_FLAGS = ["--org"];
const DELETE_VALUE_FLAGS = ["--project"];
const NAME_VALUE_FLAGS = ["--project"];

function validateProjectName(name) {
  if (name === "") {
    fail({
      code: "BAD_PROJECT_NAME",
      message: "the repo name must not be empty.",
      details: { field: "name" },
    });
  }
  if (name.length > 128) {
    fail({
      code: "BAD_PROJECT_NAME",
      message: `the repo name must be 1-128 characters, got ${name.length}.`,
      details: { field: "name", length: name.length, max: 128 },
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    fail({
      code: "BAD_PROJECT_NAME",
      message: "the repo name contains control characters (newline, tab, etc).",
      details: { field: "name" },
    });
  }
}

/**
 * Best-effort slugify for the address-form repo name (design D6's grammar:
 * lowercase [a-z0-9-], no leading/trailing/double hyphen, <=63 chars). The
 * free-text project display name (`repos create <name>`'s positional) is
 * NOT already in this charset, so `create` derives a candidate rather than
 * sending the raw name straight to the claim route and failing on the first
 * space or capital letter.
 */
function slugifyRepoName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--help", "-h"], CREATE_VALUE_FLAGS);
  const positionals = requirePositionalCount(a, CREATE_VALUE_FLAGS, {
    min: 1, max: 1, command: "run402 repos create <name>", missing: "run402 repos create <name>: a repo name is required",
  });
  const name = positionals[0];
  validateProjectName(name);

  const dir = flagValue(a, "--dir") ?? process.cwd();
  const tier = flagValue(a, "--tier") ?? "prototype";
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? `repos-create:${name}`;
  // `optional: true` — a fresh wallet with no org yet is the cold-start path
  // `projects provision` itself supports; `--org` targets an existing one.
  const orgId = await resolveOrgId(a, { cmd: "repos", optional: true });

  // Same NO_ALLOWANCE gate `projects provision` and `up --repo-only` use:
  // provisioning bypasses no action-graph here (there is none to bypass —
  // this command never touches sdk.up()), so surface the actionable guidance
  // directly rather than an opaque auth error from the gateway.
  if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) allowanceAuthHeaders("/projects/v1");

  let provisioned;
  try {
    provisioned = await withAutoApprove(() =>
      getSdk().projects.provision({ tier, name, ...(orgId ? { orgId } : {}), idempotencyKey }),
    );
  } catch (err) {
    reportSdkError(err);
    return;
  }

  const effectiveOrgId = orgId ?? (await resolveOwningOrgId(provisioned.project_id));
  if (!effectiveOrgId) {
    fail({
      code: "GITVAULT_ORG_UNRESOLVED",
      message: `Provisioned project ${provisioned.project_id}, but could not resolve its owning organization to allocate the vault.`,
      hint: `Pass --org <org_id> next time, or finish by hand: run402 gitvault init --project ${provisioned.project_id} --org <org_id>`,
      details: { project_id: provisioned.project_id },
      next_actions: [
        nextAction("edit_request", {
          command: `run402 gitvault init --project ${provisioned.project_id} --org <org_id>`,
          why: "the owning org could not be resolved automatically after provisioning",
        }),
      ],
    });
  }

  try {
    const vault = await getSdk().gitvault.init({
      org_id: effectiveOrgId,
      project_id: provisioned.project_id,
      repo_dir: dir,
    });
    // Best-effort address-form name claim (design D6): when the owning org
    // has a slug, name this repo so it is reachable as
    // run402::<slug>/<name> too — never fails `create` itself. A collision,
    // a missing slug, or any other refusal just means no address this time;
    // `run402 repos name <name>` claims it explicitly later.
    let address = null;
    let orgSlug = null;
    try {
      const orgRecord = await getSdk().org(effectiveOrgId).get();
      orgSlug = orgRecord.slug ?? null;
      if (orgSlug) {
        const candidate = slugifyRepoName(name);
        if (candidate) {
          const named = await getSdk().projects.setRepoName(provisioned.project_id, candidate);
          address = gitvaultRemoteUrlForRepo(orgSlug, named.repo_name);
        }
      }
    } catch (err) {
      console.error(`repo name not claimed (non-fatal): ${err?.message ?? String(err)}`);
    }

    // `address: null` used to have no pointer to WHY, or to the
    // named-addressing feature at all (kychee-com/run402#560): an agent
    // reading the output had no path from "address is null" to
    // `run402 org slug`/`run402 repos name`. One typed next_actions entry,
    // pointing at whichever half is actually missing.
    const nextActions = address
      ? []
      : orgSlug
        ? [claimRepoNameAction(provisioned.project_id)]
        : [claimOrgSlugAction()];

    const out = {
      project_id: provisioned.project_id,
      repo_id: vault.repo_id,
      address,
      remote: vault.remote,
      deduplicated: vault.deduplicated,
      genesis_sha256: vault.genesis_sha256,
      recovery_receipt: vault.recovery_receipt,
      terminal_loss_statement: vault.terminal_loss_statement,
      deployed: false,
      next_actions: nextActions,
    };
    console.log(JSON.stringify(out, null, 2));
    console.error(
      `project ${provisioned.project_id} provisioned; vault ${vault.repo_id} ` +
      (vault.deduplicated ? "already existed — nothing was re-allocated" : `allocated (genesis ${vault.genesis_sha256})`),
    );
    if (address) console.error(`address: ${address}`);
    else if (!orgSlug) {
      console.error(
        "no named address yet — claim an org slug (run402 org slug <slug>, one-time $1) to get run402::<slug>/<name> addresses",
      );
    } else {
      console.error(`no address claimed — run 'run402 repos name <name> --project ${provisioned.project_id}' to claim one`);
    }
    if (vault.remote) console.error(`remote '${vault.remote.name}' -> ${vault.remote.url} (${vault.remote.reason})`);
    console.error("");
    console.error(vault.terminal_loss_statement);
    await printKeystoreLocation();
    console.error("");
    console.error("nothing was deployed — this is a vault-only repo. Deploy later with `run402 deploy apply`, or never.");
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...LIST_VALUE_FLAGS, "--help", "-h"], LIST_VALUE_FLAGS);
  requirePositionalCount(a, LIST_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 repos list", missing: "",
  });
  const orgId = await resolveOrgId(a, { cmd: "repos" });

  let projects;
  try {
    const result = await getSdk().projects.list({ org: orgId });
    projects = Array.isArray(result.projects) ? result.projects : [];
  } catch (err) {
    reportSdkError(err);
    return;
  }

  // N+1 by necessity (see module doc): no bulk vault-by-org read exists yet.
  // A project whose vault status cannot be read (unreachable gateway for
  // THIS project, revoked keys, ...) is skipped rather than failing the
  // whole listing — the same "read, never fail the batch" discipline other
  // best-effort list augmentations in this CLI follow.
  const repos = [];
  for (const p of projects) {
    let status;
    try {
      status = await getSdk().gitvault.status({ project_id: p.id });
    } catch {
      continue;
    }
    if (!status.vault) continue;
    repos.push({
      project_id: p.id,
      name: p.name,
      repo_id: status.repo_id,
      gitvault_policy: status.vault.gitvault_policy,
      admitted_generations: Number(status.vault.admitted_generations ?? "0"),
      source_bytes: Number(status.vault.storage?.source_bytes ?? "0"),
      genesis_admitted_at: status.vault.genesis_admitted_at,
    });
  }
  // The org's slug, when claimed (design D6) — printed so a human/agent can
  // construct run402::<slug>/<name> addresses by hand. There is deliberately
  // no per-project `address` field here yet: the gateway has no bulk (or
  // even single) READ for a project's claimed repo_name today, only the
  // WRITE route (`POST /projects/v1/:id/repo-name`) — adding one is gateway
  // work, out of scope for this client-only change (see the final report).
  let orgSlug = null;
  try {
    orgSlug = (await getSdk().org(orgId).get()).slug;
  } catch {
    // Best-effort — `list` must not fail over an org-slug lookup.
  }
  console.log(JSON.stringify({ org_id: orgId, org_slug: orgSlug, repos }, null, 2));
  console.error(`${repos.length} vault-bearing project(s) of ${projects.length} total in this organization`);
  if (orgSlug) console.error(`org slug: ${orgSlug} — a repo with a claimed address-form name is reachable at run402::${orgSlug}/<name>`);
}

async function del(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...DELETE_VALUE_FLAGS, "--force", "--help", "-h"], DELETE_VALUE_FLAGS);
  const { projectId, rest } = resolveProjectSelector(a, { rejectBareFirst: true });
  requirePositionalCount(rest, [], { min: 0, max: 0, command: "run402 repos delete <project_id>", missing: "" });
  const force = a.includes("--force");

  let status;
  try {
    status = await getSdk().gitvault.status({ project_id: projectId });
  } catch (err) {
    reportSdkError(err);
    return;
  }
  const vault = status.vault;
  const admittedGenerations = vault ? Number(vault.admitted_generations ?? "0") : 0;
  const sourceBytes = vault ? Number(vault.storage?.source_bytes ?? "0") : 0;

  if (vault && admittedGenerations > 0 && !force) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message:
        `vault ${status.repo_id} for project ${projectId} holds ${admittedGenerations} admitted generation(s) ` +
        `(${sourceBytes} bytes of encrypted source, genesis ${vault.genesis_admitted_at ?? "unknown"}) — ` +
        "deleting the project destroys its entire encrypted history irrecoverably, along with its database, " +
        "functions, subdomains, mailbox, and secrets. Re-run with --force to proceed.",
      details: {
        project_id: projectId,
        repo_id: status.repo_id,
        admitted_generations: admittedGenerations,
        source_bytes: sourceBytes,
        genesis_admitted_at: vault.genesis_admitted_at,
        destroys: ["vault_history", "schemas", "functions", "subdomains", "mailbox", "blobs", "secrets"],
      },
    });
  }

  try {
    await getSdk().projects.delete(projectId);
    console.log(JSON.stringify({
      project_id: projectId,
      deleted: true,
      vault: vault ? { repo_id: status.repo_id, admitted_generations: admittedGenerations, source_bytes: sourceBytes } : null,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos name <name> [--project <id>]` — the explicit address-form
 * claim (design D6, task 4.2): a project gets its per-org-unique `<name>`
 * half of `run402::<org-slug>/<name>` either at push-to-create time or here.
 */
async function name(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...NAME_VALUE_FLAGS, "--help", "-h"], NAME_VALUE_FLAGS);
  const [repoName] = requirePositionalCount(a, NAME_VALUE_FLAGS, {
    min: 1, max: 1, command: "run402 repos name <name> [--project <id>]", missing: "run402 repos name <name>: a name is required",
  });
  const projectId = resolveProjectId(flagValue(a, "--project"));
  try {
    const result = await getSdk().projects.setRepoName(projectId, repoName);
    let address = null;
    try {
      const owningOrg = await resolveOwningOrgId(projectId);
      const orgSlug = owningOrg ? (await getSdk().org(owningOrg).get()).slug : null;
      if (orgSlug) address = gitvaultRemoteUrlForRepo(orgSlug, result.repo_name);
    } catch {
      // The claim itself already succeeded — a failed address-preview lookup is never fatal.
    }
    console.log(JSON.stringify({ ...result, address }, null, 2));
    console.error(
      result.previous_repo_name && result.previous_repo_name !== result.repo_name
        ? `renamed from "${result.previous_repo_name}" to "${result.repo_name}"`
        : `name "${result.repo_name}" claimed for ${projectId}`,
    );
    if (address) console.error(`address: ${address}`);
    else console.error("this org has no slug yet — claim one with `run402 org slug <slug>` to get a full run402::<slug>/<name> address");
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "create": {
      await create(argv);
      break;
    }
    case "list": {
      await list(argv);
      break;
    }
    case "delete": {
      await del(argv);
      break;
    }
    case "name": {
      await name(argv);
      break;
    }
    default:
      failUnknownSubcommand("repos", sub, {
        hint: "Run `run402 repos --help` for usage.",
      });
  }
}
