/**
 * `run402 repos` — the consolidated encrypted-repository family. One noun,
 * twelve verbs, each one either a `gh repo` verb, a `git` verb meaning what
 * it means in git, or a plain-English verb for an operation with no analog.
 * `repo` singular resolves identically (`cli.mjs` dispatches both spellings
 * here).
 *
 * ARCHITECTURAL LAW: every piece of protocol behavior — crypto core,
 * keystore, creation journal, snapshot + capture, publication state
 * machines, ref transactions, verification budget, repair — lives ONCE in
 * `@run402/sdk` under `r.gitvault` (the SDK keeps that name; it is
 * infrastructure language). This module is a THIN ADAPTER: argument
 * parsing, TTY output, exit codes, local file I/O. It adds zero protocol
 * behavior of its own.
 *
 * Pipe contract (docs/style.md): the payload is JSON on stdout; every human
 * line (progress, the terminal-loss statement, advisories) goes to stderr,
 * so `run402 repos view | jq` stays clean.
 *
 * `cli/lib/gitvault.mjs` is a tombstone that answers every `gitvault <verb>`
 * spelling with a typed `COMMAND_MOVED` (naming its `repos` successor) or
 * `COMMAND_REMOVED` (for `reconcile`, which has none) error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { withAutoApprove } from "./operator.mjs";
import { allowanceAuthHeaders, isCoreApiTarget, resolveProjectId } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { resolveOrgId, resolveOwningOrgId } from "./org-context.mjs";
import { resolveGitvaultTarget } from "./gitvault-target.mjs";
import { nextAction, claimOrgSlugAction, claimRepoNameAction } from "./next-actions.mjs";
import { printKeystoreLocation } from "./gitvault.mjs";
import { gitvaultRemoteUrlForRepo } from "#sdk";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  parseIntegerFlag,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
} from "./argparse.mjs";

/** Value-taking flags every vault-targeting subcommand accepts. */
const COMMON_VALUE_FLAGS = ["--project", "--repo"];

export const HELP = `run402 repos — your source, encrypted before it leaves the machine

Usage:
  run402 repos <verb> [options] — twelve verbs, tiered by how often you reach for them:

Common:
  run402 repos create [name]  [--org <org_id>] [--dir <path>] [--tier <tier>] [--project <id>]
  run402 repos view           [--project <id>] [--repo <repo_id>] [--human]
  run402 repos list           [--org <org_id>]

Then plain git, forever:
  git push
  git clone run402::<org>/<repo>

Occasional:
  run402 repos snapshot [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint] [--dry-run]
  run402 repos mirror   [<destination>] [--off] [--backfill] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>] [--project <id>] [--repo <repo_id>]
  run402 repos recover  <source> --out <dir> [--repo <repo_id>] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>]

Lifecycle:
  run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]
  run402 repos delete [--project <id>] [--repo <repo_id>] [--force]

Maintenance:
  run402 repos fsck   [--project <id>] [--repo <repo_id>] [--mirror] [--budget <n>] [--no-write]
  run402 repos gc     [--project <id>] [--repo <repo_id>] [--submit --intent-core <path> --verifier-receipt <path> [--wait]]
  run402 repos access [--project <id>] [--repo <repo_id>]
  run402 repos access repair [--project <id>] [--repo <repo_id>]
  run402 repos policy <required|grandfathered> [--project <id>] [--repo <repo_id>] [--reason <why>]

Subcommands:
  create   Provision (or, with --project, ADOPT an existing project), ALLOCATE
           its vault (mints key material and, on first allocation, a one-shot
           recovery receipt), and scaffold the git remote — origin when free,
           run402 when taken. \`--project <id>\` allocates for a project that already exists,
           nothing is provisioned. \`[name]\` is inferred from an existing git
           remote's basename or the directory name when unambiguous — NEVER a
           prompt; if the directory and an existing remote disagree, or
           nothing usable can be derived, this is a structured error naming
           exactly one next_action, never a guess. The response's next_action
           is the exact \`git push\` to run. Nothing is deployed, ever, unless
           you separately choose to.
  view     Side-effect-free: what this machine and the control plane each
           believe about the repo — allocation, policy, whether this keystore
           can sign, the authenticated and materialized pins, the mirror
           summary (when one is configured), and where the keystore lives.
           NEVER materializes refs or advances any local pin —
           that belongs to \`fsck\`, which is why \`refs\` reports
           {known:false, reason:"not_materialized"} with a next_action
           pointing there. \`--human\` renders a short summary instead of JSON.
  list     The organization's vault-bearing repos, via the bulk
           vaults-by-org read when the gateway has it (one round trip);
           gracefully falls back to the older per-project walk when it
           404s. Not every project in the org — ones with no vault are
           omitted.
  rename   Claim or rename the repo's per-org-unique, address-form name
           (the <name> half of run402::<org-slug>/<name>). Address by
           --repo or --project (not both).
  delete   Deletes a REPO-ONLY project — database, functions, subdomains,
           mailbox, and secrets must all be absent. When any of
           them is materialized, this REFUSES with
           PROJECT_HAS_NON_REPO_RESOURCES, enumerates refused_resources, and
           points at \`run402 projects delete\` — the verb whose name says
           what it destroys. \`--force\` overrides ONLY the vault-history
           confirmation below it (the repo holds admitted generations); it
           NEVER overrides the non-repo-infra refusal. Success enumerates
           deleted_resources.
  snapshot Capture the working tree and publish it. Not gated on a deploy —
           a vault-only repo snapshots for months without one. Against a
           project with no vault yet, this ALLOCATES one inline before
           publishing. Push-to-creates through a slug-form remote
           (run402::<org-slug>/<name>) the same way \`git push\` does.
           \`--dry-run\` previews the real local pipeline without publishing.
  mirror   ONE flag-driven verb for the client-side, customer-
           owned ciphertext mirror — run402 never holds a credential to it.
           No argument: READ the configured destination + a keyless
           freshness check against the live vault. \`<destination>\`:
           configure (idempotent upsert). \`--off\`: remove the config only —
           never touches the mirror's own bytes. \`--backfill\`: copy every
           object the mirror is missing (every publish already dual-pushes
           automatically; backfill exists for a pre-existing vault or a
           mirror that fell behind). Exactly one of these per call. Mirror
           state also renders inside \`repos view\`; mirror INTEGRITY inside
           \`repos fsck --mirror\`.
  recover  \`r402s-recover\`: rebuild a working git repository straight from
           a mirrored prefix, with NO SERVER INVOLVED — the offline disaster
           path (normal retrieval is plain \`git clone run402::<org>/<repo>\`,
           no \`repos clone\` verb exists). Proves this mirror's validity,
           never freshness — read both honesty statements before relying on
           the result.
  fsck     Walks the head chain AND materializes
           the ref map, advancing BOTH
           local trust pins — reported EXPLICITLY as local_state_changed +
           pin_before + pin_after, never implied. \`--no-write\` is a genuine
           audit mode: the same real walk and decrypt, computing the same
           real answer, but persisting neither pin. \`--budget <n>\` caps
           heads verified per call (the verified prefix persists under
           normal writing mode, so a budget-exceeded run resumes). \`--mirror\`
           additionally runs the keyless mirror integrity probe — it proves
           the mirror's VALIDITY, never its FRESHNESS, and says so.
  gc       \`git gc\`'s own two halves — checkpoint publication (compact) and
           prune planning — in one verb, NOT described as "exactly git gc":
           the deletion ceremony is stricter. Plans and checkpoints by
           default; nothing is deleted until \`--submit --intent-core <path>
           --verifier-receipt <path>\` supplies BOTH receipts the two-phase
           protocol requires (this CLI's own + an independent one from
           r402s-verify — ships as prebuilt release binaries, not a
           build-from-source errand). The plan response's submit next_action
           carries destructive:true / requires_approval:true /
           safe_to_auto_execute:false as ADDITIVE fields.
  access   READ-ONLY: the org's directory of encryption-key-holding members,
           which of the vault's current envelope-recipient fingerprints are
           covered, and (best-effort, this machine only) each principal's
           local TOFU pin. Reports an HONEST gap rather than inventing:
           per-recipient envelope_state (converged/pending) and
           history_scope are not yet exposed by the gateway — that lands
           with gitvault-human-envelopes' epoch-rotation work.
  access repair
           NOT YET AVAILABLE — gated on the epoch-rotation mechanism above
           landing. \`reconcile\`, the workaround it replaces, is REMOVED:
           it never wrapped a key correctly-scoped to "from
           here forward," and a temporary mechanism does not get a
           permanent verb. This refuses cleanly and points at \`repos
           access\` for what IS available today.
  policy   Set the activation policy — \`required\` (a deploy must present a
           vaulted capture) or \`grandfathered\` (it need not). Owner +
           step-up, audited. \`grandfathered\` is the documented way out of a
           deploy the vault gate refused, and needs \`--reason\`; returning to
           \`required\` does not. Allocating a repo never sets this.

Options:
  --project <id>    Project whose repo to act on (defaults to the active project)
  --repo <repo_id>  Address the repo directly by id, skipping project lookup
  --org <org_id>    create/list: the owning organization (create resolves it
                    the same way \`projects provision\` does when omitted)
  --dir <path>      create: the working tree to scaffold (default: cwd). Not
                    a git repository yet? One is created — \`repos create\` is
                    a from-a-directory-to-a-hosted-repo verb by definition.
  --tier <tier>     create: project tier (default: prototype) — new projects only
  --idempotency-key <key>
                    create: re-running with the same key resolves to the
                    same project instead of creating a second one — new
                    projects only (default: derived from the name)
  --human           view: a short summary on stdout instead of the JSON dump.
                    Rejected together with --json.
  --force           delete: proceed even though the repo holds generations
                    that would be permanently and irrecoverably lost. Never
                    overrides the non-repo-infrastructure refusal.
  --message <text>  snapshot: commit message for the synthetic commit a dirty
                    tree produces (a clean tree pushes HEAD itself, unused)
  --checkpoint      snapshot: force the checkpoint-bearing form regardless of delta size
  --dry-run         snapshot: a REAL preview — runs the actual local pipeline
                    and reports what would publish. Publishes nothing.
  --off             mirror: remove the configured destination (config only)
  --backfill        mirror: copy every object the configured mirror is missing
  --profile <name>  mirror / recover: the AWS credential profile name for an
                    s3:// destination (read from ~/.aws/credentials at USE
                    time — never stored). Mutually exclusive with --ambient.
  --ambient         mirror / recover: use the ambient AWS_ACCESS_KEY_ID /
                    AWS_SECRET_ACCESS_KEY environment chain instead of a profile.
  --region <r>      mirror / recover: AWS region for an s3:// destination
  --endpoint <url>  mirror / recover: an S3-compatible endpoint override
  --out <dir>       recover: where to materialize the recovered repository
  --budget <n>      fsck: heads walked in this call (write mode persists the
                    verified prefix, so a budget-exceeded run resumes; a
                    --no-write run does not, since nothing was persisted)
  --mirror          fsck: also run the keyless mirror integrity probe
  --no-write        fsck: audit mode — compute and report the real answer,
                    persist neither local trust pin
  --submit          gc: submit the planned prune intent. Requires
                    --intent-core and --verifier-receipt.
  --intent-core <path>
                    gc: the plan's intent_core, saved verbatim from a prior
                    planning run. A rebuilt core carries a different nonce,
                    so a receipt over it would no longer bind.
  --verifier-receipt <path>
                    gc: r402s-verify's verifier_receipt over that same core.
  --wait            gc: poll the submitted intent until the control-plane-
                    signed completion appears, instead of returning immediately
  --reason <why>    policy: why the policy is changing — recorded in the
                    audit event. REQUIRED for \`grandfathered\`.
  --json            No-op: stdout is already JSON.

Terminal loss (protocol §0):
  In V0-A, whole-machine or whole-keystore loss is terminal for repo history
  until human envelopes ship. \`view\` prints the full statement verbatim on
  stderr and carries it in its JSON — read it before you rely on it.

Examples:
  run402 repos create                       # name inferred from cwd/remote
  run402 repos create my-notes
  run402 repos create --project prj_1a2b3c  # allocate for an existing project
  git push -u origin HEAD                   # the printed next_action, verbatim
  run402 repos view --human
  run402 repos list --org org_1a2b3c
  run402 repos rename my-notes --project prj_1a2b3c
  run402 repos snapshot --dry-run
  run402 repos mirror s3://acme-vault-mirror --profile acme
  run402 repos mirror --backfill
  run402 repos fsck --mirror
  run402 repos gc
  run402 repos access
  run402 repos recover s3://acme-vault-mirror --out ./restored
  run402 repos delete --project prj_xyz --force
`;

// ─── shared targeting + printing ────

/**
 * Resolve which repo to act on, plus the local git tree. Resolution order:
 * explicit `--repo`/`--project` > the repo's own pin/remote
 * > RUN402_PROJECT_ID > the active project.
 */
async function vaultTarget(a) {
  const repoId = flagValue(a, "--repo");
  const project = flagValue(a, "--project");
  const repoDir = process.cwd();
  const resolved = await resolveGitvaultTarget({
    repoDir,
    explicitProjectId: project ?? undefined,
    explicitRepoId: repoId ?? undefined,
  });
  const target = { repo_dir: repoDir };
  if (repoId != null) target.repo_id = repoId;
  if (repoId == null || project != null) {
    if ("repo_id" in resolved && project == null) target.repo_id = resolved.repo_id;
    if ("project_id" in resolved) target.project_id = resolved.project_id ?? resolveProjectId(project);
  }
  return target;
}

/** Print the protocol §0 terminal-loss statement, verbatim, from the SDK's own constants — never paraphrased here. */
function printTerminalLoss(status) {
  console.error("");
  console.error(status.terminal_loss_statement);
  console.error(status.terminal_loss_detail);
  console.error(`Back up this directory: ${status.keystore.root}`);
  console.error("");
}

const LARGE_OUTPUT_THRESHOLD_BYTES = 100 * 1024;

/**
 * docs/agent-response-design.md's CLI pipe-contract row: stdout ALWAYS keeps
 * the full JSON (never truncated); when a result is large it is ALSO written
 * to a private 0600 file with a one-line stderr breadcrumb naming the path.
 * Best-effort. Deliberately NEVER called on `create`'s result — that JSON
 * carries the one-shot recovery receipt, and a secret-bearing response is
 * never spilled into any cache path (agent-response-design's secrets rule).
 */
async function spillIfLarge(repoId, verb, payload) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, "utf8") <= LARGE_OUTPUT_THRESHOLD_BYTES) return;
  try {
    const { getGitvaultKeystoreRoot } = await import("#sdk/node");
    const dir = join(getGitvaultKeystoreRoot(), "reports");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${verb}-${repoId ?? "unknown"}-${Date.now()}.json`);
    writeFileSync(path, json, { mode: 0o600 });
    console.error(`(this result is large — the full JSON was also written to ${path})`);
  } catch {
    // best-effort only; stdout already carries the full result regardless
  }
}

/** Both mirror honesty statements, verbatim, wherever a mirror/recover result is shown. */
function printMirrorHonesty(result) {
  if (result?.validity_not_freshness) console.error(result.validity_not_freshness);
  if (result?.keystore_still_required) console.error(result.keystore_still_required);
}

function resolveMirrorCredential(a) {
  const profile = flagValue(a, "--profile");
  const ambient = a.includes("--ambient");
  if (profile != null && ambient) {
    fail({ code: "BAD_USAGE", message: "--profile and --ambient contradict each other.", hint: "Pick one credential source for the s3:// destination." });
  }
  if (profile != null) return { kind: "profile", profile };
  if (ambient) return { kind: "ambient" };
  return undefined;
}

function formatMirrorDestination(destination) {
  if (!destination) return "(none)";
  return destination.kind === "s3" ? `s3://${destination.bucket}/${destination.prefix}` : destination.path;
}

function readJsonFile(flag, path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail({ code: "BAD_USAGE", message: `${flag} ${path} could not be read: ${err?.message ?? String(err)}`, hint: "Point it at the file a prior `run402 repos gc` (or r402s-verify) wrote." });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail({ code: "BAD_USAGE", message: `${flag} ${path} is not valid JSON: ${err?.message ?? String(err)}`, hint: "Pass the file verbatim; do not reformat or re-serialize it." });
  }
}

function formatRepoAddress(s) {
  if (s.pinned?.resolved_from) return `run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name}`;
  const orgId = s.vault?.org_id ?? null;
  const projectId = s.project_id ?? s.vault?.project_id ?? null;
  if (orgId && projectId) return `run402::${orgId}/${projectId}`;
  if (projectId) return projectId;
  if (s.repo_id) return `repo ${s.repo_id}`;
  return "(unresolved)";
}

async function formatRepoHuman(s, mirror) {
  const lines = [];
  const remotePart = s.remote ? ` (remote '${s.remote.name}'${s.remote.matches ? "" : " — points at a DIFFERENT project"})` : " (no local remote)";
  lines.push(`Address: ${formatRepoAddress(s)}${remotePart}`);

  if (!s.vault) {
    lines.push("Repo: not allocated yet for this project — run 'run402 repos create --project <id>' to allocate one.");
    if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);
    return lines.join("\n");
  }

  lines.push("HEAD: (not materialized — run 'run402 repos fsck' to see HEAD/ref count; view never does)");

  const { generationToBigInt } = await import("#sdk/node");
  const decimal = (g) => (g ? generationToBigInt(g).toString() : "none");
  lines.push(`Generations: authenticated ${decimal(s.pins.highest_authenticated)}, materialized ${decimal(s.pins.highest_materialized)}`);

  const storage = s.vault.storage;
  const objectCount = storage?.objects ? Object.values(storage.objects).reduce((sum, n) => sum + Number(n), 0) : null;
  lines.push(storage ? `Storage: ${storage.source_bytes} byte(s)${objectCount != null ? ` across ${objectCount} object(s)` : ""}` : "Storage: unknown");

  const decryptPart = !s.keystore.holds_repo_key
    ? "CANNOT decrypt (no key in this machine's keystore)"
    : s.keystore.can_sign
      ? "can decrypt and publish"
      : "can decrypt (read-only — no signing key)";
  lines.push(`This machine: ${decryptPart}. Policy: ${s.gitvault_policy ?? "(none)"}`);

  if (mirror?.configured) {
    const currency = mirror.is_current === true ? "current" : mirror.is_current === false ? "STALE" : "unknown";
    lines.push(`Mirror: ${mirror.destination} (${currency})`);
  }

  if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);
  return lines.join("\n");
}

// ─── name inference ──────────────────

function validateProjectName(name) {
  if (name === "") {
    fail({ code: "BAD_PROJECT_NAME", message: "the repo name must not be empty.", details: { field: "name" } });
  }
  if (name.length > 128) {
    fail({ code: "BAD_PROJECT_NAME", message: `the repo name must be 1-128 characters, got ${name.length}.`, details: { field: "name", length: name.length, max: 128 } });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    fail({ code: "BAD_PROJECT_NAME", message: "the repo name contains control characters (newline, tab, etc).", details: { field: "name" } });
  }
}

/**
 * Best-effort slugify for the address-form repo name (the address-form
 * grammar: lowercase [a-z0-9-], no leading/trailing/double hyphen, <=63 chars).
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

/** The basename of an existing `run402`/`origin` remote's URL, or `null` when there is no repository or no such remote. Any remote — a GitHub URL parses fine too, not only a gitvault address. */
async function remoteBasenameCandidate(dir) {
  try {
    const { hardenedGit } = await import("#sdk/node");
    await hardenedGit(dir, ["rev-parse", "--git-dir"]);
    for (const name of ["run402", "origin"]) {
      let url;
      try {
        url = (await hardenedGit(dir, ["remote", "get-url", name])).text().trim();
      } catch {
        continue;
      }
      if (!url) continue;
      const stripped = url.replace(/\.git$/, "");
      const seg = stripped.split(/[/:]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch {
    // not a repository — no candidate
  }
  return null;
}

function dirBasenameCandidate(dir) {
  const base = basename(dir);
  return base && base !== "/" ? base : null;
}

/**
 * `repos create [name]`'s inference: the directory or an
 * existing git remote's basename, when unambiguous. NEVER a prompt —
 * ambiguity (the two candidates disagree) or a dead end (neither yields a
 * usable slug) is a structured error naming exactly one next_action.
 */
async function inferRepoName(dir) {
  const remoteCand = await remoteBasenameCandidate(dir);
  const dirCand = dirBasenameCandidate(dir);
  const remoteSlug = remoteCand ? slugifyRepoName(remoteCand) : null;
  const dirSlug = dirCand ? slugifyRepoName(dirCand) : null;

  if (remoteSlug && dirSlug && remoteSlug !== dirSlug) {
    fail({
      code: "REPOS_NAME_AMBIGUOUS",
      message: `Could not infer a repo name: the directory ("${dirCand}") and the existing git remote ("${remoteCand}") disagree.`,
      hint: "Pass the name explicitly.",
      details: { directory_candidate: dirSlug, remote_candidate: remoteSlug },
      next_actions: [nextAction("edit_request", { command: "run402 repos create <name>", why: "Inference could not pick between the directory and the existing remote — say which name you want." })],
    });
  }
  const picked = remoteSlug ?? dirSlug;
  if (!picked) {
    fail({
      code: "REPOS_NAME_REQUIRED",
      message: "Could not infer a repo name from the directory or an existing git remote.",
      hint: "Pass one explicitly.",
      next_actions: [nextAction("edit_request", { command: "run402 repos create <name>", why: "No usable name could be derived from cwd or a remote." })],
    });
  }
  return picked;
}

// ─── create ─────────────────────────────────────────────────────────────────

const CREATE_VALUE_FLAGS = ["--org", "--dir", "--tier", "--idempotency-key", "--project"];

async function printCreateResult({ projectId, vault, adopted, name }) {
  let address = null;
  let orgSlug = null;
  try {
    const owningOrg = await resolveOwningOrgId(projectId);
    const orgRecord = owningOrg ? await getSdk().org(owningOrg).get() : null;
    orgSlug = orgRecord?.slug ?? null;
    if (orgSlug && name) {
      const candidate = slugifyRepoName(name);
      if (candidate) {
        const named = await getSdk().projects.setRepoName(projectId, candidate);
        address = gitvaultRemoteUrlForRepo(orgSlug, named.repo_name);
      }
    }
  } catch (err) {
    if (name) console.error(`repo name not claimed (non-fatal): ${err?.message ?? String(err)}`);
  }

  const pushAction = vault.remote
    ? nextAction("push_repo", { command: `git push -u ${vault.remote.name} HEAD`, why: "Publish the current branch to the encrypted Run402 remote." })
    : null;
  const claimAction = address ? null : orgSlug ? claimRepoNameAction(projectId) : claimOrgSlugAction();
  const nextActions = [pushAction, claimAction].filter(Boolean);

  // Secret-bearing (recovery_receipt): built fresh every call, printed once,
  // and never spilled into any cache path — see spillIfLarge's own doc
  // comment for why this function never calls it.
  const out = {
    project_id: projectId,
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
    `project ${projectId} ${adopted ? "adopted" : "provisioned"}; repo ${vault.repo_id} ` +
    (vault.deduplicated ? "already existed — nothing was re-allocated" : `allocated (genesis ${vault.genesis_sha256})`),
  );
  if (address) console.error(`address: ${address}`);
  else if (!orgSlug) console.error("no named address yet — claim an org slug (run402 org slug <slug>, one-time $1) to get run402::<slug>/<name> addresses");
  else console.error(`no address claimed — run 'run402 repos rename <name> --project ${projectId}' to claim one`);
  if (vault.remote) console.error(`remote '${vault.remote.name}' -> ${vault.remote.url} (${vault.remote.reason})`);
  if (pushAction) console.error(`next: ${pushAction.command}`);
  console.error("");
  console.error(vault.terminal_loss_statement);
  await printKeystoreLocation();
  console.error("");
  console.error("nothing was deployed — this is a vault-only repo. Deploy later with `run402 deploy apply`, or never.");
}

async function createAdopt(projectId, dir, a) {
  const orgId = flagValue(a, "--org") ?? await resolveOwningOrgId(projectId);
  if (!orgId) {
    fail({
      code: "GITVAULT_ORG_UNRESOLVED",
      message: `Could not resolve the organization that owns ${projectId}.`,
      hint: "Pass --org <org_id>, or check that this wallet can see the project (`run402 projects list`).",
      details: { project_id: projectId },
    });
  }
  try {
    const vault = await getSdk().gitvault.init({ org_id: orgId, project_id: projectId, repo_dir: dir });
    await printCreateResult({ projectId, vault, adopted: true, name: null });
  } catch (err) {
    reportSdkError(err);
  }
}

async function createProvision(name, dir, a) {
  const tier = flagValue(a, "--tier") ?? "prototype";
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? `repos-create:${name}`;
  // `optional: true` — a fresh wallet with no org yet is the cold-start path
  // `projects provision` itself supports; `--org` targets an existing one.
  const orgId = await resolveOrgId(a, { cmd: "repos", optional: true });

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
      message: `Provisioned project ${provisioned.project_id}, but could not resolve its owning organization to allocate the repo.`,
      hint: `Pass --org <org_id> next time, or finish by hand: run402 repos create --project ${provisioned.project_id} --org <org_id>`,
      details: { project_id: provisioned.project_id },
      next_actions: [nextAction("edit_request", { command: `run402 repos create --project ${provisioned.project_id} --org <org_id>`, why: "the owning org could not be resolved automatically after provisioning" })],
    });
  }

  try {
    const vault = await getSdk().gitvault.init({ org_id: effectiveOrgId, project_id: provisioned.project_id, repo_dir: dir });
    await printCreateResult({ projectId: provisioned.project_id, vault, adopted: false, name });
  } catch (err) {
    reportSdkError(err);
  }
}

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--help", "-h"], CREATE_VALUE_FLAGS);
  const positionals = requirePositionalCount(a, CREATE_VALUE_FLAGS, {
    min: 0, max: 1, command: "run402 repos create [name]", missing: "",
  });
  let name = positionals[0] ?? null;
  const dir = flagValue(a, "--dir") ?? process.cwd();
  const adoptProjectId = flagValue(a, "--project");

  if (adoptProjectId != null) {
    if (name != null) {
      fail({
        code: "BAD_USAGE",
        message: "a name positional and --project are mutually exclusive — --project adopts an EXISTING project.",
        hint: "run402 repos create --project <id> to adopt, or run402 repos create <name> to provision a new one. Name it afterward with `run402 repos rename`.",
      });
    }
    if (flagValue(a, "--tier") != null || flagValue(a, "--idempotency-key") != null) {
      fail({
        code: "BAD_USAGE",
        message: "--tier / --idempotency-key only apply when provisioning a NEW project — they do not apply with --project.",
        hint: "Drop --project to provision a new project, or drop --tier/--idempotency-key to adopt the existing one.",
      });
    }
    return createAdopt(adoptProjectId, dir, a);
  }

  if (name == null) name = await inferRepoName(dir);
  validateProjectName(name);
  return createProvision(name, dir, a);
}

// ─── list ───────────────────────────────────────────────────────────────────

/** The FROZEN bulk-read shape (task 2.4) — one round trip. */
async function listViaBulkRead(orgId) {
  const result = await getSdk().gitvault.listByOrg(orgId);
  return Array.isArray(result.vaults) ? result.vaults : [];
}

/**
 * DEPRECATED fallback, kept only until every deployed gateway answers
 * `GET /gitvault/v1/vaults?org_id=`: the old client-side N+1 (list the
 * org's projects, then read each one's gitvault status). Delete this
 * function once the bulk route has shipped long enough that no gateway
 * still 404s it.
 */
async function listViaFallback(orgId) {
  const result = await getSdk().projects.list({ org: orgId });
  const projects = Array.isArray(result.projects) ? result.projects : [];
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
      repo_id: status.repo_id,
      project_id: p.id,
      project_name: p.name ?? null,
      repo_name: null,
      org_slug: null,
      gitvault_policy: status.vault.gitvault_policy,
      newest_generation: status.vault.newest_generation ?? null,
      source_bytes: String(status.vault.storage?.source_bytes ?? "0"),
      genesis_admitted_at: status.vault.genesis_admitted_at,
      created_at: null,
    });
  }
  return repos;
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--help", "-h"], ["--org"]);
  requirePositionalCount(a, ["--org"], { min: 0, max: 0, command: "run402 repos list", missing: "" });
  const orgId = await resolveOrgId(a, { cmd: "repos" });

  let repos;
  let usedFallback = false;
  try {
    repos = await listViaBulkRead(orgId);
  } catch (err) {
    if (err?.status === 404) {
      usedFallback = true;
      try {
        repos = await listViaFallback(orgId);
      } catch (fallbackErr) {
        reportSdkError(fallbackErr);
        return;
      }
    } else {
      reportSdkError(err);
      return;
    }
  }

  let orgSlug = repos.find((r) => r.org_slug)?.org_slug ?? null;
  if (orgSlug == null) {
    try {
      orgSlug = (await getSdk().org(orgId).get()).slug;
    } catch {
      // best-effort — `list` must not fail over an org-slug lookup
    }
  }

  console.log(JSON.stringify({ org_id: orgId, org_slug: orgSlug, repos }, null, 2));
  console.error(`${repos.length} vault-bearing project(s) in this organization${usedFallback ? " (per-project fallback read — the bulk vaults-by-org route is not live on this gateway yet)" : ""}`);
  if (orgSlug) console.error(`org slug: ${orgSlug} — a repo with a claimed address-form name is reachable at run402::${orgSlug}/<name>`);
}

// ─── view ───────────────────────────────────────────────────────────────────

async function view(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos view", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const target = await vaultTarget(a);
  try {
    // Design D3: `view` NEVER passes `refs: true` — it is side-effect-free
    // by construction, not by convention. Materialization belongs to `fsck`.
    const s = await getSdk().gitvault.status(target);
    let mirror = null;
    if (s.repo_id) {
      try {
        mirror = await getSdk().gitvault.mirrorStatus({ ...target, repo_id: s.repo_id });
      } catch {
        // best-effort — a mirror read failure never fails `view`
      }
    }
    if (human) {
      console.log(await formatRepoHuman(s, mirror));
      return;
    }
    const verifyRefsAction = nextAction("verify_refs", { command: "run402 repos fsck", why: "Walk the signed chain and materialize verified refs." });
    const combinedNextActions = s.vault ? [verifyRefsAction, ...(s.next_actions ?? [])] : (s.next_actions ?? []);
    const out = {
      ...s,
      refs: { known: false, reason: "not_materialized" },
      mirror,
      next_actions: combinedNextActions,
    };
    console.log(JSON.stringify(out, null, 2));
    printTerminalLoss(s);
    if (s.remote) {
      const suffix =
        s.remote.matches === false ? "  ← points at a DIFFERENT project than this view"
        : s.remote.matches === null ? `  (${s.remote.reason})`
        : "";
      console.error(`remote '${s.remote.name}': ${s.remote.url}${suffix}`);
    }
    if (s.pinned) {
      console.error(`pinned: repo_id ${s.pinned.repo_id}` + (s.pinned.resolved_from ? ` (resolved from run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name})` : ""));
    }
    if (mirror?.configured) {
      const currency = mirror.is_current === true ? "current" : mirror.is_current === false ? `STALE — ${mirror.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${mirror.destination}: mirrored generation ${mirror.mirrored_generation ?? "(none)"}, vault newest ${mirror.newest_generation ?? "(none)"} — ${currency}`);
    }
    for (const w of s.warnings) console.error(`warning (${w.kind}): ${w.message}`);
    for (const n of combinedNextActions) console.error(`next: ${n.why ?? n.action ?? n.type}${n.command ? ` — ${n.command}` : ""}`);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── rename ─────────────────────────────────────────────────────────────────

async function rename(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  const [repoName] = requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 1, max: 1, command: "run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]",
    missing: "run402 repos rename <new_name>: a new name is required",
  });
  const repoFlag = flagValue(a, "--repo");
  const projectFlag = flagValue(a, "--project");
  if (repoFlag != null && projectFlag != null) {
    fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both.", hint: "They address the same repo two different ways." });
  }
  let projectId;
  if (repoFlag != null) {
    try {
      projectId = (await getSdk().gitvault.get(repoFlag)).project_id;
    } catch (err) {
      reportSdkError(err);
      return;
    }
  } else {
    projectId = resolveProjectId(projectFlag);
  }
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

// ─── delete ─────────────────────────────────────────────────────

/** One non-repo-resource read, `null` when absent (including a clean 404), an entry when present or genuinely unverifiable. */
async function checkResource(read, resourceName, countOf) {
  try {
    const result = await read();
    const count = countOf(result);
    return count > 0 ? { resource: resourceName, status: "present", count } : null;
  } catch (err) {
    if (err?.status === 404) return null; // genuinely absent, not a check failure
    return { resource: resourceName, status: "unknown", reason: err?.message ?? String(err) };
  }
}

/**
 * D9's guard: a repo-only project has no materialized database schema, no
 * functions, no secrets, no subdomains, no mailbox, no custom domains. Every
 * read here uses the SAME service-key credential `projects.delete` itself
 * requires, so a credential that would make `delete` fail also makes this
 * guard fail the same way — never a silent pass on missing auth. A read
 * that fails for a reason OTHER than "genuinely absent" (404) is reported
 * `unknown` and REFUSES delete too — D9 never guesses its way to yes.
 */
async function checkNonRepoResources(projectId) {
  const refused = [];
  try {
    const detail = await getSdk().projects.get(projectId);
    if (Array.isArray(detail.mailbox) && detail.mailbox.length > 0) refused.push({ resource: "mailbox", status: "present", count: detail.mailbox.length });
    if (Array.isArray(detail.custom_domains) && detail.custom_domains.length > 0) refused.push({ resource: "custom_domains", status: "present", count: detail.custom_domains.length });
  } catch (err) {
    refused.push({ resource: "project_detail", status: "unknown", reason: err?.message ?? String(err) });
  }
  const schema = await checkResource(() => getSdk().projects.getSchema(projectId), "database_schema", (s) => (Array.isArray(s?.tables) ? s.tables.length : 0));
  if (schema) refused.push(schema);
  const functions = await checkResource(() => getSdk().functions.list(projectId), "functions", (r) => (Array.isArray(r?.functions) ? r.functions.length : 0));
  if (functions) refused.push(functions);
  const secrets = await checkResource(() => getSdk().secrets.list(projectId), "secrets", (r) => (Array.isArray(r?.secrets) ? r.secrets.length : 0));
  if (secrets) refused.push(secrets);
  const subdomains = await checkResource(() => getSdk().subdomains.list(projectId), "subdomains", (r) => (Array.isArray(r) ? r.length : 0));
  if (subdomains) refused.push(subdomains);
  return refused;
}

function stripFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return args;
  const copy = [...args];
  copy.splice(idx, 2);
  return copy;
}

async function del(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--repo", "--force", "--help", "-h"], ["--project", "--repo"]);
  const repoFlag = flagValue(a, "--repo");
  let projectId;
  let rest;
  if (repoFlag != null) {
    if (flagValue(a, "--project") != null) {
      fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both." });
    }
    try {
      projectId = (await getSdk().gitvault.get(repoFlag)).project_id;
    } catch (err) {
      reportSdkError(err);
      return;
    }
    rest = stripFlag(a, "--repo");
  } else {
    ({ projectId, rest } = resolveProjectSelector(a, { rejectBareFirst: true }));
  }
  requirePositionalCount(rest.filter((x) => x !== "--force"), [], { min: 0, max: 0, command: "run402 repos delete [--project <id>] [--repo <repo_id>] [--force]", missing: "" });
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

  // D9, checked FIRST and unconditionally: --force below overrides only the
  // vault-history confirmation, never this refusal.
  const refusedResources = await checkNonRepoResources(projectId);
  if (refusedResources.length > 0) {
    fail({
      code: "PROJECT_HAS_NON_REPO_RESOURCES",
      message: `project ${projectId} holds non-repo infrastructure; \`repos delete\` only destroys a repo-only project.`,
      hint: "Use `run402 projects delete <project_id>` to destroy the whole project, including what is listed below. --force does NOT override this refusal.",
      details: { project_id: projectId, refused_resources: refusedResources },
      next_actions: [nextAction("edit_request", { command: `run402 projects delete ${projectId}`, why: "Destroys the whole project, including the non-repo resources listed above." })],
    });
  }

  if (vault && admittedGenerations > 0 && !force) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message:
        `repo ${status.repo_id} for project ${projectId} holds ${admittedGenerations} admitted generation(s) ` +
        `(${sourceBytes} bytes of encrypted source, genesis ${vault.genesis_admitted_at ?? "unknown"}) — ` +
        "deleting the project destroys its entire encrypted history irrecoverably. Re-run with --force to proceed.",
      details: {
        project_id: projectId,
        repo_id: status.repo_id,
        admitted_generations: admittedGenerations,
        source_bytes: sourceBytes,
        genesis_admitted_at: vault.genesis_admitted_at,
        destroys: ["vault_history"],
      },
    });
  }

  try {
    await getSdk().projects.delete(projectId);
    console.log(JSON.stringify({
      project_id: projectId,
      deleted: true,
      deleted_resources: ["project", ...(vault ? ["vault_history"] : [])],
      vault: vault ? { repo_id: status.repo_id, admitted_generations: admittedGenerations, source_bytes: sourceBytes } : null,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── snapshot ───────────────────────────────────────────────────────────────

const SNAPSHOT_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--message"];

/**
 * When neither `--repo` nor `--project` was given explicitly, look at the
 * local `run402`/`origin` remote and, if it is a SLUG-form address
 * (`run402::<org-slug>/<name>`), return the parsed address so `snapshot`
 * can push-to-create through it — the same address-form resolution
 * `git push` drives via the remote helper.
 */
async function detectSlugFormRemote(a, repoDir) {
  if (flagValue(a, "--repo") != null || flagValue(a, "--project") != null) return null;
  const { hardenedGit } = await import("#sdk/node");
  const { parseGitvaultRemoteUrl, gitvaultRemoteAddressForm } = await import("#sdk");
  for (const name of ["run402", "origin"]) {
    let url;
    try {
      url = (await hardenedGit(repoDir, ["remote", "get-url", name])).text().trim();
    } catch {
      continue;
    }
    if (!url) continue;
    const address = parseGitvaultRemoteUrl(url);
    if (address && gitvaultRemoteAddressForm(address) === "slug") return address;
  }
  return null;
}

async function snapshot(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...SNAPSHOT_VALUE_FLAGS, "--checkpoint", "--dry-run", "--help", "-h"], SNAPSHOT_VALUE_FLAGS);
  requirePositionalCount(a, SNAPSHOT_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos snapshot", missing: "" });
  const dryRun = a.includes("--dry-run");
  const message = flagValue(a, "--message");
  const repoDir = process.cwd();
  const address = await detectSlugFormRemote(a, repoDir);
  const target = address ? { repo_dir: repoDir } : await vaultTarget(a);
  const orgId = !address && !dryRun && target.project_id ? await resolveOwningOrgId(target.project_id) : null;
  const opts = {
    ...target,
    ...(address ? { address } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    onCommitLine: (line) => console.error(line),
    onVaultCreated: async (created) => {
      console.error("");
      console.error(`repo allocated (genesis ${created.genesis_sha256}) — one-shot recovery receipt, keep many copies:`);
      console.error(JSON.stringify(created.recovery_receipt));
      await printKeystoreLocation();
      console.error("");
    },
  };
  if (message != null) opts.snapshot = { message };
  if (a.includes("--checkpoint")) opts.checkpoint = true;
  try {
    if (dryRun) {
      const plan = await getSdk().gitvault.planPush(opts);
      console.log(JSON.stringify(plan, null, 2));
      if (plan.allocation_needed) {
        console.error("dry-run: no repo allocated for this project yet — a real snapshot would allocate one first; object/byte sizing is not knowable until then");
      } else {
        console.error(
          `dry-run: would publish generation ${plan.would_admit_generation} (${plan.would_admit_generation_decimal}, ${plan.form}) — ` +
          `${plan.object_count} object(s), ${plan.encrypted_bytes} encrypted byte(s) (${plan.raw_bytes} raw)`,
        );
      }
      return;
    }
    const result = await getSdk().gitvault.push(opts);
    console.log(JSON.stringify(result, null, 2));
    console.error(`published generation ${result.generation} (${result.form})`);
    if (result.mirror_push?.outcome === "pushed") {
      console.error(`mirror: pushed generation ${result.generation} (${result.mirror_push.summary?.objects_copied ?? 0} object(s) copied)`);
    } else if (result.mirror_push?.outcome === "failed") {
      console.error(`mirror: dual-push FAILED (deploy is unaffected) — ${result.mirror_push.error ?? "see mirror_push.summary.errors"}`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── policy ─────────────────────────────────────────────────────────────────

async function policy(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--reason"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const [requested] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 repos policy <required|grandfathered>",
    missing: "Missing <policy>. Expected `required` or `grandfathered`.",
  });
  if (requested !== "required" && requested !== "grandfathered") {
    fail({
      code: "BAD_USAGE",
      message: `Unknown policy: ${requested}.`,
      hint: "Expected `required` (a deploy must present a vaulted capture) or `grandfathered` (it need not).",
      details: { policy: requested, known_policies: ["required", "grandfathered"] },
    });
  }
  const reason = flagValue(a, "--reason");
  if (requested === "grandfathered" && (reason == null || reason.trim() === "")) {
    fail({
      code: "BAD_USAGE",
      message: "`grandfathered` needs --reason <why>.",
      hint: "It weakens the activation guarantee for this project and is recorded in the audit event. Say why, e.g. --reason \"migrating CI to a vaulted client\".",
      details: { policy: requested },
    });
  }

  const target = await vaultTarget(a);
  try {
    const sdk = getSdk();
    const repoId = target.repo_id ?? (await sdk.gitvault.forProject(target.project_id)).repo_id;
    const result = await sdk.gitvault.setPolicy(repoId, { gitvault_policy: requested, ...(reason != null ? { reason } : {}) });
    console.log(JSON.stringify({ repo_id: repoId, ...result }, null, 2));
    console.error(
      result.changed
        ? `gitvault_policy is now ${result.gitvault_policy} (version ${result.gitvault_policy_version})`
        : `gitvault_policy was already ${result.gitvault_policy} — nothing changed`,
    );
    for (const w of result.warnings ?? []) console.error(`warning (${w.kind}): ${w.message}`);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── mirror (ONE flag-driven verb) ─────────────────────────────

const MIRROR_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--profile", "--region", "--endpoint"];

async function mirrorRead(target) {
  try {
    const result = await getSdk().gitvault.mirrorStatus(target);
    console.log(JSON.stringify(result, null, 2));
    if (!result.configured) {
      console.error(`no mirror configured for ${result.repo_id}. Configure one: run402 repos mirror <destination>`);
    } else {
      const currency = result.is_current === true ? "current" : result.is_current === false ? `STALE — ${result.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${result.destination}: mirrored generation ${result.mirrored_generation ?? "(none)"}, vault newest ${result.newest_generation ?? "(none)"} — ${currency}`);
    }
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorSet(target, destination, a) {
  const credential = resolveMirrorCredential(a);
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  try {
    const result = await getSdk().gitvault.mirrorSet({
      ...target,
      destination_url: destination,
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    console.error(`mirror configured for ${result.repo_id} -> ${formatMirrorDestination(result.destination)}`);
    console.error("run `run402 repos mirror --backfill` to catch it up now, then every publish dual-pushes automatically.");
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorOff(target) {
  try {
    const result = await getSdk().gitvault.mirrorRemove(target);
    console.log(JSON.stringify(result, null, 2));
    console.error(
      result.removed
        ? `mirror config removed for ${result.repo_id} — the mirror's OWN bytes were not touched`
        : `no mirror was configured for ${result.repo_id} — nothing to remove`,
    );
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorBackfill(target) {
  try {
    const result = await getSdk().gitvault.mirrorSync(target);
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "mirror-backfill", result);
    console.error(
      `mirror backfill for ${result.repo_id}: ${result.objects_copied} copied, ${result.objects_already_present} already present` +
      `${result.objects_skipped_foreign_recipient > 0 ? `, ${result.objects_skipped_foreign_recipient} skipped (envelopes for other recipients — expected)` : ""}` +
      `${result.objects_failed > 0 ? `, ${result.objects_failed} FAILED` : ""} (${result.bytes_copied} byte(s) copied this run).`,
    );
    for (const e of result.errors) console.error(`  failed: ${e.key} — ${e.error}`);
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirror(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...MIRROR_VALUE_FLAGS, "--off", "--backfill", "--ambient", "--help", "-h"], MIRROR_VALUE_FLAGS);
  const positionals = requirePositionalCount(a, MIRROR_VALUE_FLAGS, {
    min: 0, max: 1, command: "run402 repos mirror [<destination>]", missing: "",
  });
  const destination = positionals[0] ?? null;
  const off = a.includes("--off");
  const backfill = a.includes("--backfill");
  const modeCount = [destination != null, off, backfill].filter(Boolean).length;
  if (modeCount > 1) {
    fail({
      code: "BAD_USAGE",
      message: "pass at most one of: <destination>, --off, --backfill.",
      hint: "run402 repos mirror (read) | run402 repos mirror <destination> (configure) | run402 repos mirror --off (remove) | run402 repos mirror --backfill (catch up)",
    });
  }
  const target = await vaultTarget(a);
  if (destination != null) return mirrorSet(target, destination, a);
  if (off) return mirrorOff(target);
  if (backfill) return mirrorBackfill(target);
  return mirrorRead(target);
}

// ─── fsck (verify the head chain + materialize refs) ──────────────────

async function fsck(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--budget"];
  assertKnownFlags(a, [...valueFlags, "--mirror", "--no-write", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, { min: 0, max: 0, command: "run402 repos fsck", missing: "" });
  const target = await vaultTarget(a);
  const budget = flagValue(a, "--budget");
  if (budget != null) target.verification_budget = parseIntegerFlag("--budget", budget, { min: 1 });
  const write = !a.includes("--no-write");
  const mirrorRequested = a.includes("--mirror");
  try {
    const result = await getSdk().gitvault.fsck({ ...target, write, mirror: mirrorRequested });
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "fsck", result);
    if (!write) {
      console.error(`--no-write: verified through generation ${result.verified_to_generation} — nothing local was persisted (pin_before === pin_after).`);
    } else if (result.local_state_changed) {
      console.error(`verified through generation ${result.verified_to_generation} — local pin advanced from ${result.pin_before.highest_authenticated ?? "genesis"} to ${result.pin_after.highest_authenticated}.`);
    } else {
      console.error(`verified through generation ${result.verified_to_generation} — already at the newest verified generation, nothing changed.`);
    }
    if (mirrorRequested && result.mirror) {
      console.error(`mirror: recoverable generation ${result.mirror.recovered_generation}${result.mirror.chain_break ? ` (chain break at ${result.mirror.chain_break.generation}: ${result.mirror.chain_break.reason})` : ""}.`);
      if (result.mirror.data_loss_detected) {
        console.error(`DATA LOSS DETECTED: ${result.mirror.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences.`);
      }
      printMirrorHonesty(result.mirror);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── gc (checkpoint + prune) ──────────────────────────────

const GC_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--intent-core", "--verifier-receipt"];

async function gc(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...GC_VALUE_FLAGS, "--submit", "--wait", "--help", "-h"], GC_VALUE_FLAGS);
  requirePositionalCount(a, GC_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos gc", missing: "" });
  const submitting = a.includes("--submit");
  const corePath = flagValue(a, "--intent-core");
  const receiptPath = flagValue(a, "--verifier-receipt");
  if (submitting && (corePath == null || receiptPath == null)) {
    fail({
      code: "BAD_USAGE",
      message: "run402 repos gc --submit needs both --intent-core and --verifier-receipt.",
      hint: "Plan first (`run402 repos gc`), save prune.intent_core, run r402s-verify (prebuilt release binaries) against it, then submit both.",
    });
  }
  if (!submitting && (corePath != null || receiptPath != null)) {
    fail({ code: "BAD_USAGE", message: "--intent-core / --verifier-receipt only apply with --submit.", hint: "Add --submit, or drop the flags to plan." });
  }
  const target = await vaultTarget(a);

  try {
    if (submitting) {
      const opts = { ...target, submit: { core: readJsonFile("--intent-core", corePath), verifier_receipt: readJsonFile("--verifier-receipt", receiptPath) } };
      if (a.includes("--wait")) opts.submit.wait = {};
      const prune = await getSdk().gitvault.prune(opts);
      const out = { phase: "submitted", prune };
      console.log(JSON.stringify(out, null, 2));
      if (prune.confirmation?.outcome) {
        console.error(
          `submitted — the signed completion reports ${prune.confirmation.deleted.length} deleted, ` +
          `${prune.confirmation.present.length} still present` +
          `${prune.confirmation.unadjudicated.length > 0 ? `, ${prune.confirmation.unadjudicated.length} unadjudicated` : ""}.`,
        );
      } else {
        console.error("submitted — no completion yet. Nothing is deleted until the control-plane-signed completion says so; re-run with --wait or poll the intent.");
      }
      console.error(prune.note);
      return;
    }

    const checkpoint = await getSdk().gitvault.compact(target);
    const prune = await getSdk().gitvault.prune(target);
    const nextActions = [];
    if (!prune.blocked_reason && prune.object_candidates.length > 0) {
      // Additive fields beyond the CLI's usual {type, command, why}: the
      // `gc` is never described as "exactly git gc," and its submit
      // next_action must say so structurally, not just in prose.
      nextActions.push({
        type: "submit_gc",
        command: "run402 repos gc --submit --intent-core <core.json> --verifier-receipt <receipt.json>",
        why: "Submit the signed prune intent after independent verification with r402s-verify.",
        safe_to_auto_execute: false,
        requires_approval: true,
        destructive: true,
      });
    }
    const out = { phase: "planned", checkpoint, prune, next_actions: nextActions };
    console.log(JSON.stringify(out, null, 2));
    console.error(`checkpoint published at generation ${checkpoint.generation}: ${checkpoint.covered_refs} ref(s), ${checkpoint.covered_roots} retention root(s).`);
    if (!checkpoint.cutoff_bound) {
      console.error("no retention-cutoff ticket was obtained, so roots were RETAINED — expiry is permissive. The checkpoint published, but no expired root left the map.");
    }
    if (prune.blocked_reason) {
      console.error(`prune: nothing to submit — ${prune.blocked_reason}`);
    } else {
      console.error(
        `prune: ${prune.object_candidates.length} object(s) proposed for deletion` +
        `${prune.deferred_object_count > 0 ? ` (${prune.deferred_object_count} more deferred to a later intent)` : ""}` +
        `; ${prune.eligible_count} retention root(s) past their window, ${prune.retained_count} retained.`,
      );
      if (prune.intent_core_sha256) {
        console.error(`intent_core_sha256: ${prune.intent_core_sha256} — run r402s-verify (ships as prebuilt release binaries) against this core, then re-run with --submit.`);
      }
    }
    console.error("`gc` is NOT \"exactly git gc\" — the deletion ceremony is stricter: nothing is removed until a control-plane-signed completion confirms it.");
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── access (read-only; repair gated) ──────────────────────

async function accessRead(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access", missing: "" });
  const target = await vaultTarget(a);
  try {
    const result = await getSdk().gitvault.access(target);
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "access", result);
    console.error(`${result.recipients.length} directory recipient(s), ${result.recipients.filter((r) => r.covered).length} covered on this repo.`);
    if (result.unmatched_covered_fingerprints.length > 0) {
      console.error(`${result.unmatched_covered_fingerprints.length} covering fingerprint(s) match no directory entry (orphaned/external): ${result.unmatched_covered_fingerprints.join(", ")}`);
    }
    console.error(result.gap);
  } catch (err) {
    reportSdkError(err);
  }
}

async function accessRepair(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access repair", missing: "" });
  fail({
    code: "ACCESS_REPAIR_NOT_AVAILABLE",
    message: "`run402 repos access repair` is not available yet — it is gated on gitvault-human-envelopes' real epoch-rotation work landing.",
    hint: "Use `run402 repos access` to see what the read surface reports today. Repair is a NAMED, deliberate action for genuine drift once the mechanism ships — never a routine workaround (the `reconcile` verb it replaces was removed for exactly that reason).",
    next_actions: [nextAction("access_repair_pending", { command: "run402 repos access", why: "See recipients, coverage, and this machine's own TOFU pins today; repair lands once epoch rotation ships." })],
  });
}

async function access(args) {
  const a = normalizeArgv(args);
  if (a[0] === "repair") return accessRepair(a.slice(1));
  return accessRead(a);
}

// ─── recover ─────────────────────

async function recover(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--out", "--repo", "--profile", "--region", "--endpoint"];
  assertKnownFlags(a, [...valueFlags, "--ambient", "--help", "-h"], valueFlags);
  const [source] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 repos recover <source> --out <dir>",
    missing: "Missing <source>. Expected s3://<bucket>[/<prefix>] or a directory path.",
  });
  const outDir = flagValue(a, "--out");
  if (outDir == null) {
    fail({ code: "BAD_USAGE", message: "run402 repos recover needs --out <dir>.", hint: "Where to materialize the recovered repository, e.g. --out ./restored" });
  }
  const credential = resolveMirrorCredential(a);
  const repoId = flagValue(a, "--repo");
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  try {
    const result = await getSdk().gitvault.recover({
      source, out_dir: outDir,
      ...(repoId != null ? { repo_id: repoId } : {}),
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "recover", result);
    console.error(`recovered generation ${result.recovered_generation} for ${result.repo_id} into ${outDir}` + (result.chain_break ? ` (chain break at ${result.chain_break.generation} — fell back to the newest fully-verified generation)` : "") + ".");
    if (result.data_loss_detected) {
      console.error(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences — see "absences" in the result above.`);
    }
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── dispatch ───────────────────────────────────────────────────────────────

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
    case "view": {
      await view(argv);
      break;
    }
    case "rename": {
      await rename(argv);
      break;
    }
    case "delete": {
      await del(argv);
      break;
    }
    case "snapshot": {
      await snapshot(argv);
      break;
    }
    case "policy": {
      await policy(argv);
      break;
    }
    case "mirror": {
      await mirror(argv);
      break;
    }
    case "fsck": {
      await fsck(argv);
      break;
    }
    case "gc": {
      await gc(argv);
      break;
    }
    case "access": {
      await access(argv);
      break;
    }
    case "recover": {
      await recover(argv);
      break;
    }
    default:
      failUnknownSubcommand("repos", sub, {
        hint: "Run `run402 repos --help` for usage.",
      });
  }
}
