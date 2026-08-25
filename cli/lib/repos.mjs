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
import { allowanceAuthHeaders, isCoreApiTarget } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { resolveOrgId, resolveOwningOrgId } from "./org-context.mjs";
import { nextAction } from "./next-actions.mjs";
import { printKeystoreLocation } from "./gitvault.mjs";
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

Subcommands:
  create  Provision a project, ALLOCATE its vault (mints key material and a
          one-shot recovery receipt), and scaffold the run402 remote —
          origin when free, run402 when taken (D1). No deploy plan, no
          release, nothing deployed: the vault-only track (design D8), for a
          project that only ever hosts encrypted source.
  list    The organization's vault-bearing projects — those with an
          allocated vault, whether or not they have ever deployed. Not
          every project in the org; ones with no vault are omitted.
  delete  Delete the project and everything in it (database, functions,
          subdomains, mailbox, secrets). REFUSES while the vault holds any
          admitted generation unless --force is passed — this is
          irreversible and destroys the vault's entire encrypted history
          along with everything else.

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
  --json            No-op: stdout is already JSON.

There is no separate gitvault price: bytes count against the same
organization-pooled storage budget every project already has.
`;

const CREATE_VALUE_FLAGS = ["--org", "--dir", "--tier", "--idempotency-key"];
const LIST_VALUE_FLAGS = ["--org"];
const DELETE_VALUE_FLAGS = ["--project"];

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
    const out = {
      project_id: provisioned.project_id,
      repo_id: vault.repo_id,
      remote: vault.remote,
      deduplicated: vault.deduplicated,
      genesis_sha256: vault.genesis_sha256,
      recovery_receipt: vault.recovery_receipt,
      terminal_loss_statement: vault.terminal_loss_statement,
      deployed: false,
    };
    console.log(JSON.stringify(out, null, 2));
    console.error(
      `project ${provisioned.project_id} provisioned; vault ${vault.repo_id} ` +
      (vault.deduplicated ? "already existed — nothing was re-allocated" : `allocated (genesis ${vault.genesis_sha256})`),
    );
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
  console.log(JSON.stringify({ org_id: orgId, repos }, null, 2));
  console.error(`${repos.length} vault-bearing project(s) of ${projects.length} total in this organization`);
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
    default:
      failUnknownSubcommand("repos", sub, {
        hint: "Run `run402 repos --help` for usage.",
      });
  }
}
