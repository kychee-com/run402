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
import { sdkStats, printVerboseStats } from "./stats.mjs";
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
  run402 repos list           [--org <org_id>] [--human]

Then plain git, forever:
  git push
  git clone run402::<org>/<repo>

Occasional:
  run402 repos snapshot [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint] [--dry-run] [--allow-dirty]
  run402 repos mirror   [<destination>] [--off] [--backfill] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>] [--project <id>] [--repo <repo_id>]
  run402 repos recover  <source> --out <dir> [--repo <repo_id>] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>] [--human]

Lifecycle:
  run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]
  run402 repos delete [--project <id>] [--repo <repo_id>] [--force]

Maintenance:
  run402 repos fsck   [--project <id>] [--repo <repo_id>] [--mirror] [--budget <n>] [--no-write] [--human]
  run402 repos gc     [--project <id>] [--repo <repo_id>] [--submit --intent-core <path> --verifier-receipt <path> [--wait]]
  run402 repos access [--project <id>] [--repo <repo_id>] [--human]
  run402 repos access repair [--project <id>] [--repo <repo_id>] --recipient-state-version <n> --recipient-revocation-version <n>
  run402 repos access revoke-key <principal_id> [--project <id>] [--repo <repo_id>]
  run402 repos access declare-exposure [--project <id>] [--repo <repo_id>]
  run402 repos policy <required|grandfathered> [--project <id>] [--repo <repo_id>] [--reason <why>]

Every verb above also accepts -v/--verbose (a stderr summary line of request
stats — round trips, wire time, bytes — coexists with --human) and always
carries a \`stats\` block in its JSON result.

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
           omitted. \`--human\` renders a compact roster (address,
           generation, bytes, policy) instead of JSON.
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
           A DIRTY tree (modified/staged tracked paths, or untracked-not-
           ignored paths) REFUSES by default (SNAPSHOT_DIRTY_TREE, before any
           object is created) — commit and retry, or pass \`--allow-dirty\` to
           capture it as-is; the result then discloses exactly what was
           swept in (modified_captured / untracked_captured), printed to
           stderr too. \`--dry-run\` surfaces the same refusal.
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
           the result. \`--human\` renders a short summary instead of JSON.
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
           \`--human\` renders a short summary instead of JSON.
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
           covered, per-recipient envelope_state (converged/pending/
           pending_removal, from the gateway's desired-recipient-state
           substrate), and (best-effort, this machine only) each principal's
           local TOFU pin. stale_access names removed members whose access
           has NOT yet been rotated away — pending_removal is honest
           bookkeeping, not enforcement, until \`access repair\`/\`revoke-key\`
           actually rotates. history_scope (which epochs each recipient can
           read) is not reported by this read — see the \`gap\` field.
           \`--human\` renders a compact roster instead of JSON (the read
           form only — repair/revoke-key/declare-exposure stay JSON-only).
  access repair
           Epoch rotation (D193-D203, rev 42) with reason:"elective_rekey" —
           re-keys this vault's CURRENT epoch away from every stale_access
           principal at once, and clears a pre-existing vault's one-time
           migration requirement. \`reconcile\`, the workaround this
           replaces, is REMOVED (it never wrapped a key correctly-scoped to
           "from here forward" — this does). Needs
           --recipient-state-version and --recipient-revocation-version:
           the gateway exposes no read route for these two counters outside
           \`revoke-key\`'s own response, so this verb needs them supplied
           explicitly today — refuses cleanly, naming exactly this, when
           omitted. Owner + step-up.
  access revoke-key <principal_id>
           The ONE fully self-contained rotation entry point: declares
           reason:"recipient_key_revoked" for one principal and rotates off
           that declaration's OWN returned counters — no flags needed.
           Owner + step-up. The rekey remedy for "this specific principal's
           key should no longer be trusted."
  access declare-exposure
           Declares reason:"epoch_secret_exposed" for THIS vault
           (vault-scoped, not org-wide) — the rekey remedy for a leaked
           K_repo/K_e. The declaration itself lands immediately; the
           follow-up rotation it authorizes is not auto-run (same counter
           gap as \`access repair\`) — this prints exactly what to do next.
           Owner + step-up.
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
                    projects only (default: derived from the name).
                    access repair/revoke-key: the rotation attempt's OWN
                    client_idempotency_key (32-hex) — default: a fresh
                    CSPRNG value each call, never resumed across processes.
  --recipient-state-version <n>
  --recipient-revocation-version <n>
                    access repair: the D194 frozen watermark pair this
                    rotation attempt is fenced against. Required — see
                    \`run402 repos access repair --help\` for why.
  --human           view/list/access/fsck/recover: a short summary on stdout
                    instead of the JSON dump. Rejected together with --json.
  --force           delete: proceed even though the repo holds generations
                    that would be permanently and irrecoverably lost. Never
                    overrides the non-repo-infrastructure refusal.
  --message <text>  snapshot: commit message for the synthetic commit a dirty
                    tree produces (a clean tree pushes HEAD itself, unused)
  --checkpoint      snapshot: force the checkpoint-bearing form regardless of delta size
  --dry-run         snapshot: a REAL preview — runs the actual local pipeline
                    and reports what would publish. Publishes nothing. A
                    dirty tree still refuses SNAPSHOT_DIRTY_TREE here (a
                    preview that hid the refusal would lie).
  --allow-dirty     snapshot: capture a dirty tree as-is instead of refusing.
                    The result discloses exactly what was swept in
                    (modified_captured / untracked_captured) — even this
                    override never captures silently.
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
  -v, --verbose     Print one stderr summary line of this call's request
                    stats (round trips, wire time, bytes). Coexists with
                    --human. The JSON result always carries a \`stats\` block
                    regardless of this flag.
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
  run402 repos list --org org_1a2b3c --human
  run402 repos rename my-notes --project prj_1a2b3c
  run402 repos snapshot --dry-run
  run402 repos snapshot --allow-dirty
  run402 repos mirror s3://acme-vault-mirror --profile acme
  run402 repos mirror --backfill
  run402 repos fsck --mirror --human
  run402 repos gc
  run402 repos access --human
  run402 repos recover s3://acme-vault-mirror --out ./restored --human
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

/**
 * Print the protocol §0 terminal-loss statement, verbatim, from the SDK's own
 * constants — never paraphrased here. The SDK's `status()` already downgrades
 * this to the durability sentence when it has locally proven the vault has
 * >= 2 covering recipients (dogfood item 2: the single-principal terminal-loss
 * claim is false for that vault) — this function only renders whichever
 * statement the SDK selected, it never chooses between them itself.
 */
function printTerminalLoss(status) {
  console.error("");
  if (status.terminal_loss_statement) {
    console.error(status.terminal_loss_statement);
    console.error(status.terminal_loss_detail);
  } else if (status.durability_statement) {
    console.error(status.durability_statement);
    if (status.covering_recipients != null) console.error(`covering_recipients: ${status.covering_recipients}`);
  }
  console.error(`Back up this directory: ${status.keystore.root}`);
  console.error("");
}

/**
 * Print a verb's JSON result with the always-on `stats` block (Observability:
 * RUN402_TRACE + always-on stats + -v). `sdk.stats()` reflects only calls
 * made through THIS `sdk` instance — every verb below resolves one `sdk =
 * getSdk()` and reuses it for its own direct calls so the count is accurate
 * for the work this function did; calls a shared cross-cutting helper
 * (org/wallet resolution) makes through its own internal instance are not
 * reflected (see `cli/lib/stats.mjs`'s doc comment).
 */
function printJson(sdk, payload) {
  console.log(JSON.stringify({ ...payload, stats: sdkStats(sdk) }, null, 2));
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

async function printCreateResult({ sdk, projectId, vault, adopted, name, verboseArgv }) {
  let address = null;
  let orgSlug = null;
  try {
    const owningOrg = await resolveOwningOrgId(projectId);
    const orgRecord = owningOrg ? await sdk.org(owningOrg).get() : null;
    orgSlug = orgRecord?.slug ?? null;
    if (orgSlug && name) {
      const candidate = slugifyRepoName(name);
      if (candidate) {
        const named = await sdk.projects.setRepoName(projectId, candidate);
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
  printJson(sdk, out);
  console.error(
    `project ${projectId} ${adopted ? "adopted" : "provisioned"}; repo ${vault.repo_id} ` +
    (vault.deduplicated ? "already existed — nothing was re-allocated" : `allocated (genesis ${vault.genesis_sha256})`),
  );
  if (address) console.error(`address: ${address}`);
  else if (!orgSlug) console.error("no named address yet — claim an org slug (run402 org slug <slug>) to get run402::<slug>/<name> addresses");
  else console.error(`no address claimed — run 'run402 repos rename <name> --project ${projectId}' to claim one`);
  if (vault.remote) console.error(`remote '${vault.remote.name}' -> ${vault.remote.url} (${vault.remote.reason})`);
  if (pushAction) console.error(`next: ${pushAction.command}`);
  console.error("");
  console.error(vault.terminal_loss_statement);
  await printKeystoreLocation();
  console.error("");
  console.error("nothing was deployed — this is a vault-only repo. Deploy later with `run402 deploy apply`, or never.");
  printVerboseStats(verboseArgv, sdk);
}

async function createAdopt(projectId, dir, a) {
  const sdk = getSdk();
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
    const vault = await sdk.gitvault.init({ org_id: orgId, project_id: projectId, repo_dir: dir });
    await printCreateResult({ sdk, projectId, vault, adopted: true, name: null, verboseArgv: a });
  } catch (err) {
    reportSdkError(err);
  }
}

async function createProvision(name, dir, a) {
  const sdk = getSdk();
  const tier = flagValue(a, "--tier") ?? "prototype";
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? `repos-create:${name}`;
  // `optional: true` — a fresh wallet with no org yet is the cold-start path
  // `projects provision` itself supports; `--org` targets an existing one.
  const orgId = await resolveOrgId(a, { cmd: "repos", optional: true });

  if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) allowanceAuthHeaders("/projects/v1");

  let provisioned;
  try {
    provisioned = await withAutoApprove(() =>
      sdk.projects.provision({ tier, name, ...(orgId ? { orgId } : {}), idempotencyKey }),
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
    const vault = await sdk.gitvault.init({ org_id: effectiveOrgId, project_id: provisioned.project_id, repo_dir: dir });
    await printCreateResult({ sdk, projectId: provisioned.project_id, vault, adopted: false, name, verboseArgv: a });
  } catch (err) {
    reportSdkError(err);
  }
}

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--help", "-h", "-v", "--verbose"], CREATE_VALUE_FLAGS);
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
async function listViaBulkRead(sdk, orgId) {
  const result = await sdk.gitvault.listByOrg(orgId);
  return Array.isArray(result.vaults) ? result.vaults : [];
}

/**
 * DEPRECATED fallback, kept only until every deployed gateway answers
 * `GET /gitvault/v1/vaults?org_id=`: the old client-side N+1 (list the
 * org's projects, then read each one's gitvault status). Delete this
 * function once the bulk route has shipped long enough that no gateway
 * still 404s it.
 */
async function listViaFallback(sdk, orgId) {
  const result = await sdk.projects.list({ org: orgId });
  const projects = Array.isArray(result.projects) ? result.projects : [];
  const repos = [];
  for (const p of projects) {
    let status;
    try {
      status = await sdk.gitvault.status({ project_id: p.id });
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

/** `repos list --human`: a compact roster — one line per repo (address, generation, bytes, policy). */
async function formatRepoListHuman(orgSlug, repos) {
  if (repos.length === 0) return "(no vault-bearing repos in this organization)";
  const { generationToBigInt } = await import("#sdk/node");
  const decimal = (g) => (g ? generationToBigInt(g).toString() : "none");
  const lines = repos.map((r) => {
    const address = orgSlug && r.repo_name ? `run402::${orgSlug}/${r.repo_name}` : (r.repo_name ?? r.project_id);
    return `${address}  gen=${decimal(r.newest_generation)}  ${r.source_bytes} byte(s)  policy=${r.gitvault_policy ?? "(none)"}  (${r.repo_id})`;
  });
  return lines.join("\n");
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--human", "-v", "--verbose", "--help", "-h"], ["--org"]);
  requirePositionalCount(a, ["--org"], { min: 0, max: 0, command: "run402 repos list", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const orgId = await resolveOrgId(a, { cmd: "repos" });

  let repos;
  let usedFallback = false;
  try {
    repos = await listViaBulkRead(sdk, orgId);
  } catch (err) {
    if (err?.status === 404) {
      usedFallback = true;
      try {
        repos = await listViaFallback(sdk, orgId);
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
      orgSlug = (await sdk.org(orgId).get()).slug;
    } catch {
      // best-effort — `list` must not fail over an org-slug lookup
    }
  }

  if (human) {
    console.log(await formatRepoListHuman(orgSlug, repos));
    printVerboseStats(a, sdk);
    return;
  }
  printJson(sdk, { org_id: orgId, org_slug: orgSlug, repos });
  console.error(`${repos.length} vault-bearing project(s) in this organization${usedFallback ? " (per-project fallback read — the bulk vaults-by-org route is not live on this gateway yet)" : ""}`);
  if (orgSlug) console.error(`org slug: ${orgSlug} — a repo with a claimed address-form name is reachable at run402::${orgSlug}/<name>`);
  printVerboseStats(a, sdk);
}

// ─── view ───────────────────────────────────────────────────────────────────

async function view(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos view", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    // Design D3: `view` NEVER passes `refs: true` — it is side-effect-free
    // by construction, not by convention. Materialization belongs to `fsck`.
    const s = await sdk.gitvault.status(target);
    let mirror = null;
    if (s.repo_id) {
      try {
        mirror = await sdk.gitvault.mirrorStatus({ ...target, repo_id: s.repo_id });
      } catch {
        // best-effort — a mirror read failure never fails `view`
      }
    }
    if (human) {
      console.log(await formatRepoHuman(s, mirror));
      printVerboseStats(a, sdk);
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
    printJson(sdk, out);
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
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── rename ─────────────────────────────────────────────────────────────────

async function rename(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  const [repoName] = requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 1, max: 1, command: "run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]",
    missing: "run402 repos rename <new_name>: a new name is required",
  });
  const sdk = getSdk();
  const repoFlag = flagValue(a, "--repo");
  const projectFlag = flagValue(a, "--project");
  if (repoFlag != null && projectFlag != null) {
    fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both.", hint: "They address the same repo two different ways." });
  }
  let projectId;
  if (repoFlag != null) {
    try {
      projectId = (await sdk.gitvault.get(repoFlag)).project_id;
    } catch (err) {
      reportSdkError(err);
      return;
    }
  } else {
    projectId = resolveProjectId(projectFlag);
  }
  try {
    const result = await sdk.projects.setRepoName(projectId, repoName);
    let address = null;
    try {
      const owningOrg = await resolveOwningOrgId(projectId);
      const orgSlug = owningOrg ? (await sdk.org(owningOrg).get()).slug : null;
      if (orgSlug) address = gitvaultRemoteUrlForRepo(orgSlug, result.repo_name);
    } catch {
      // The claim itself already succeeded — a failed address-preview lookup is never fatal.
    }
    printJson(sdk, { ...result, address });
    console.error(
      result.previous_repo_name && result.previous_repo_name !== result.repo_name
        ? `renamed from "${result.previous_repo_name}" to "${result.repo_name}"`
        : `name "${result.repo_name}" claimed for ${projectId}`,
    );
    if (address) console.error(`address: ${address}`);
    else console.error("this org has no slug yet — claim one with `run402 org slug <slug>` to get a full run402::<slug>/<name> address");
    printVerboseStats(a, sdk);
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
async function checkNonRepoResources(sdk, projectId) {
  const refused = [];
  try {
    const detail = await sdk.projects.get(projectId);
    if (Array.isArray(detail.mailbox) && detail.mailbox.length > 0) refused.push({ resource: "mailbox", status: "present", count: detail.mailbox.length });
    if (Array.isArray(detail.custom_domains) && detail.custom_domains.length > 0) refused.push({ resource: "custom_domains", status: "present", count: detail.custom_domains.length });
  } catch (err) {
    refused.push({ resource: "project_detail", status: "unknown", reason: err?.message ?? String(err) });
  }
  const schema = await checkResource(() => sdk.projects.getSchema(projectId), "database_schema", (s) => (Array.isArray(s?.tables) ? s.tables.length : 0));
  if (schema) refused.push(schema);
  const functions = await checkResource(() => sdk.functions.list(projectId), "functions", (r) => (Array.isArray(r?.functions) ? r.functions.length : 0));
  if (functions) refused.push(functions);
  const secrets = await checkResource(() => sdk.secrets.list(projectId), "secrets", (r) => (Array.isArray(r?.secrets) ? r.secrets.length : 0));
  if (secrets) refused.push(secrets);
  const subdomains = await checkResource(() => sdk.subdomains.list(projectId), "subdomains", (r) => (Array.isArray(r) ? r.length : 0));
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
  assertKnownFlags(a, ["--project", "--repo", "--force", "-v", "--verbose", "--help", "-h"], ["--project", "--repo"]);
  const sdk = getSdk();
  const repoFlag = flagValue(a, "--repo");
  let projectId;
  let rest;
  if (repoFlag != null) {
    if (flagValue(a, "--project") != null) {
      fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both." });
    }
    try {
      projectId = (await sdk.gitvault.get(repoFlag)).project_id;
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
    status = await sdk.gitvault.status({ project_id: projectId });
  } catch (err) {
    reportSdkError(err);
    return;
  }
  const vault = status.vault;
  const admittedGenerations = vault ? Number(vault.admitted_generations ?? "0") : 0;
  const sourceBytes = vault ? Number(vault.storage?.source_bytes ?? "0") : 0;

  // D9, checked FIRST and unconditionally: --force below overrides only the
  // vault-history confirmation, never this refusal.
  const refusedResources = await checkNonRepoResources(sdk, projectId);
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
    await sdk.projects.delete(projectId);
    printJson(sdk, {
      project_id: projectId,
      deleted: true,
      deleted_resources: ["project", ...(vault ? ["vault_history"] : [])],
      vault: vault ? { repo_id: status.repo_id, admitted_generations: admittedGenerations, source_bytes: sourceBytes } : null,
    });
    printVerboseStats(a, sdk);
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

/**
 * Dirty-tree disclosure (help people not make mistakes): even an explicit
 * `--allow-dirty` override never captures silently — every modified/staged
 * tracked path and every untracked-not-ignored path that got swept into the
 * capture is named on stderr, one per line.
 */
function printDirtyDisclosure(snapshot) {
  if (!snapshot) return;
  for (const p of snapshot.modified_captured ?? []) console.error(`captured (modified): ${p}`);
  for (const p of snapshot.untracked_captured ?? []) console.error(`captured (untracked): ${p}`);
}

async function snapshot(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...SNAPSHOT_VALUE_FLAGS, "--checkpoint", "--dry-run", "--allow-dirty", "-v", "--verbose", "--help", "-h"], SNAPSHOT_VALUE_FLAGS);
  requirePositionalCount(a, SNAPSHOT_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos snapshot", missing: "" });
  const sdk = getSdk();
  const dryRun = a.includes("--dry-run");
  const message = flagValue(a, "--message");
  const allowDirty = a.includes("--allow-dirty");
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
  const snapshotOpts = {};
  if (message != null) snapshotOpts.message = message;
  if (allowDirty) snapshotOpts.allowDirty = true;
  if (Object.keys(snapshotOpts).length > 0) opts.snapshot = snapshotOpts;
  if (a.includes("--checkpoint")) opts.checkpoint = true;
  try {
    if (dryRun) {
      const plan = await sdk.gitvault.planPush(opts);
      printJson(sdk, plan);
      if (plan.allocation_needed) {
        console.error("dry-run: no repo allocated for this project yet — a real snapshot would allocate one first; object/byte sizing is not knowable until then");
      } else {
        console.error(
          `dry-run: would publish generation ${plan.would_admit_generation} (${plan.would_admit_generation_decimal}, ${plan.form}) — ` +
          `${plan.object_count} object(s), ${plan.encrypted_bytes} encrypted byte(s) (${plan.raw_bytes} raw)`,
        );
      }
      printDirtyDisclosure(plan.snapshot);
      printVerboseStats(a, sdk);
      return;
    }
    const result = await sdk.gitvault.push(opts);
    printJson(sdk, result);
    console.error(`published generation ${result.generation} (${result.form})`);
    if (result.mirror_push?.outcome === "pushed") {
      console.error(`mirror: pushed generation ${result.generation} (${result.mirror_push.summary?.objects_copied ?? 0} object(s) copied)`);
    } else if (result.mirror_push?.outcome === "failed") {
      console.error(`mirror: dual-push FAILED (deploy is unaffected) — ${result.mirror_push.error ?? "see mirror_push.summary.errors"}`);
    }
    printDirtyDisclosure(result.snapshot);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── policy ─────────────────────────────────────────────────────────────────

async function policy(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--reason"];
  assertKnownFlags(a, [...valueFlags, "-v", "--verbose", "--help", "-h"], valueFlags);
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
    printJson(sdk, { repo_id: repoId, ...result });
    console.error(
      result.changed
        ? `gitvault_policy is now ${result.gitvault_policy} (version ${result.gitvault_policy_version})`
        : `gitvault_policy was already ${result.gitvault_policy} — nothing changed`,
    );
    for (const w of result.warnings ?? []) console.error(`warning (${w.kind}): ${w.message}`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── mirror (ONE flag-driven verb) ─────────────────────────────

const MIRROR_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--profile", "--region", "--endpoint"];

async function mirrorRead(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorStatus(target);
    printJson(sdk, result);
    if (!result.configured) {
      console.error(`no mirror configured for ${result.repo_id}. Configure one: run402 repos mirror <destination>`);
    } else {
      const currency = result.is_current === true ? "current" : result.is_current === false ? `STALE — ${result.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${result.destination}: mirrored generation ${result.mirrored_generation ?? "(none)"}, vault newest ${result.newest_generation ?? "(none)"} — ${currency}`);
    }
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorSet(target, destination, a) {
  const sdk = getSdk();
  const credential = resolveMirrorCredential(a);
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  try {
    const result = await sdk.gitvault.mirrorSet({
      ...target,
      destination_url: destination,
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
    });
    printJson(sdk, result);
    console.error(`mirror configured for ${result.repo_id} -> ${formatMirrorDestination(result.destination)}`);
    console.error("run `run402 repos mirror --backfill` to catch it up now, then every publish dual-pushes automatically.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorOff(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorRemove(target);
    printJson(sdk, result);
    console.error(
      result.removed
        ? `mirror config removed for ${result.repo_id} — the mirror's OWN bytes were not touched`
        : `no mirror was configured for ${result.repo_id} — nothing to remove`,
    );
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorBackfill(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorSync(target);
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "mirror-backfill", result);
    console.error(
      `mirror backfill for ${result.repo_id}: ${result.objects_copied} copied, ${result.objects_already_present} already present` +
      `${result.objects_skipped_foreign_recipient > 0 ? `, ${result.objects_skipped_foreign_recipient} skipped (envelopes for other recipients — expected)` : ""}` +
      `${result.objects_failed > 0 ? `, ${result.objects_failed} FAILED` : ""} (${result.bytes_copied} byte(s) copied this run).`,
    );
    for (const e of result.errors) console.error(`  failed: ${e.key} — ${e.error}`);
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirror(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...MIRROR_VALUE_FLAGS, "--off", "--backfill", "--ambient", "-v", "--verbose", "--help", "-h"], MIRROR_VALUE_FLAGS);
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
  if (off) return mirrorOff(target, a);
  if (backfill) return mirrorBackfill(target, a);
  return mirrorRead(target, a);
}

// ─── fsck (verify the head chain + materialize refs) ──────────────────

/** `repos fsck --human`: the same verdict the stderr lines already carry, condensed into one block. */
function formatFsckHuman(result, mirrorRequested) {
  const lines = [`Repo: ${result.repo_id}`];
  lines.push(
    !result.write
      ? `Verified through generation ${result.verified_to_generation} — audit mode, nothing local was persisted.`
      : result.local_state_changed
        ? `Verified through generation ${result.verified_to_generation} — local pin advanced from ${result.pin_before.highest_authenticated ?? "genesis"} to ${result.pin_after.highest_authenticated}.`
        : `Verified through generation ${result.verified_to_generation} — already at the newest verified generation.`,
  );
  if (mirrorRequested && result.mirror) {
    lines.push(
      `Mirror: recoverable generation ${result.mirror.recovered_generation}` +
      (result.mirror.chain_break ? ` (chain break at ${result.mirror.chain_break.generation}: ${result.mirror.chain_break.reason})` : "") +
      (result.mirror.data_loss_detected ? ` — DATA LOSS DETECTED (${result.mirror.absences.filter((x) => x.adjudication === "unexplained_absence").length} unexplained absence(s))` : ""),
    );
  }
  return lines.join("\n");
}

async function fsck(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--budget"];
  assertKnownFlags(a, [...valueFlags, "--mirror", "--no-write", "--human", "-v", "--verbose", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, { min: 0, max: 0, command: "run402 repos fsck", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  const budget = flagValue(a, "--budget");
  if (budget != null) target.verification_budget = parseIntegerFlag("--budget", budget, { min: 1 });
  const write = !a.includes("--no-write");
  const mirrorRequested = a.includes("--mirror");
  try {
    const result = await sdk.gitvault.fsck({ ...target, write, mirror: mirrorRequested });
    if (human) {
      console.log(formatFsckHuman(result, mirrorRequested));
      if (mirrorRequested && result.mirror) printMirrorHonesty(result.mirror);
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
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
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── gc (checkpoint + prune) ──────────────────────────────

const GC_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--intent-core", "--verifier-receipt"];

async function gc(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...GC_VALUE_FLAGS, "--submit", "--wait", "-v", "--verbose", "--help", "-h"], GC_VALUE_FLAGS);
  requirePositionalCount(a, GC_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos gc", missing: "" });
  const sdk = getSdk();
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
      const prune = await sdk.gitvault.prune(opts);
      const out = { phase: "submitted", prune };
      printJson(sdk, out);
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
      printVerboseStats(a, sdk);
      return;
    }

    const checkpoint = await sdk.gitvault.compact(target);
    const prune = await sdk.gitvault.prune(target);
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
    printJson(sdk, out);
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
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── access (read-only; repair gated) ──────────────────────

/** `repos access --human`: a compact roster of directory recipients and their coverage. */
function formatAccessHuman(result) {
  const lines = [`Repo: ${result.repo_id}`];
  lines.push(`Recipients: ${result.recipients.length} directory, ${result.recipients.filter((r) => r.covered).length} covered`);
  for (const r of result.recipients) {
    lines.push(`  ${r.covered ? "covered" : "NOT covered"}  ${r.display_name ?? r.principal_id}${r.envelope_state ? ` (${r.envelope_state})` : ""}`);
  }
  if (result.this_keystore) lines.push(`This machine's own keystore also covers (writing principal, not in org directory): ${result.this_keystore.fingerprint}`);
  if (result.unmatched_covered_fingerprints.length > 0) lines.push(`Orphaned/external coverage: ${result.unmatched_covered_fingerprints.join(", ")}`);
  if (Array.isArray(result.stale_access) && result.stale_access.length > 0) {
    lines.push(`Stale access (removed members that still decrypt): ${result.stale_access.map((s) => s.display_name ?? s.principal_id).join(", ")}`);
  }
  lines.push(result.gap);
  return lines.join("\n");
}

async function accessRead(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.access(target);
    if (human) {
      console.log(formatAccessHuman(result));
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "access", result);
    console.error(`${result.recipients.length} directory recipient(s), ${result.recipients.filter((r) => r.covered).length} covered on this repo.`);
    if (result.this_keystore) {
      console.error(`1 covering fingerprint is this machine's own keystore (the vault's writing principal, not in the org directory): ${result.this_keystore.fingerprint}`);
    }
    if (result.unmatched_covered_fingerprints.length > 0) {
      console.error(`${result.unmatched_covered_fingerprints.length} covering fingerprint(s) match no directory entry or desired-state row (orphaned/external): ${result.unmatched_covered_fingerprints.join(", ")}`);
    }
    if (Array.isArray(result.stale_access) && result.stale_access.length > 0) {
      const names = result.stale_access.map((s) => s.display_name ?? s.principal_id).join(", ");
      console.error(`${result.stale_access.length} removed member(s) STILL decrypt this vault (not yet revocable — no epoch rotation in v0): ${names}`);
    }
    console.error(result.gap);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

const ROTATION_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--recipient-state-version", "--recipient-revocation-version", "--idempotency-key"];

/**
 * `run402 repos access repair` (D193-D203, rev 42) — a general re-key of
 * this vault's CURRENT epoch, dropping every principal in `stale_access`
 * (`pending_removal`, still covered) and clearing a pre-existing vault's
 * one-time migration requirement. Drives `rotateEpoch({reason:"elective_rekey"})`.
 *
 * `--recipient-state-version`/`--recipient-revocation-version` are the D194
 * frozen watermarks this attempt must be fenced against. They are NOT
 * discovered automatically here: the live gateway exposes NO general read
 * route for `internal.gitvault_recipient_state_counters` outside the
 * `key-revocation` declare route's own response (see
 * `GitvaultVault.rotateEpoch`'s doc comment, `sdk/src/node/gitvault-
 * publication.ts`, for the confirmed source-level finding). Until that
 * route ships, this verb needs the pair supplied explicitly — refusing
 * cleanly and naming exactly this when they are omitted, rather than
 * guessing and either failing opaquely or (worse) never converging.
 *
 * **`elective_rekey` refuses ANY exclusion** (`EPOCH_ROTATION_INCOMPLETE_ENROLLMENT`
 * on even one keyless/unconfirmed desired principal) — so a pending
 * `/confirm`/`/repin` receipt does NOT help here: folding it into THIS
 * rotation's `pending_confirmations` still leaves that principal
 * `excluded_unconfirmed` for THIS rotation (D196 — same-head manifest
 * updates never self-authorize), which `elective_rekey`'s own
 * completeness check then refuses on. If a directory principal is
 * unconfirmed when this vault needs to clear its migration requirement,
 * use `run402 repos access revoke-key`/`declare-exposure` instead (an
 * urgent reason, which admits with a nonempty partial target set) and
 * fold the pending receipt into THAT rotation.
 */
async function accessRepair(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROTATION_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], ROTATION_VALUE_FLAGS);
  requirePositionalCount(a, ROTATION_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access repair", missing: "" });
  const recipientStateVersion = flagValue(a, "--recipient-state-version");
  const recipientRevocationVersion = flagValue(a, "--recipient-revocation-version");
  if (recipientStateVersion == null || recipientRevocationVersion == null) {
    fail({
      code: "ROTATION_COUNTERS_REQUIRED",
      message: "`run402 repos access repair` needs --recipient-state-version and --recipient-revocation-version — the gateway does not yet expose a read route for these two counters outside the key-revocation declare route.",
      hint: "If you know a specific principal whose key should be revoked, use `run402 repos access revoke-key <principal_id>` instead — it is fully self-contained (no flags needed). `access repair` is the general re-key for clearing stale_access / a first-ever migration and needs these two values from platform staff or direct DB access until a gateway read route ships.",
      next_actions: [nextAction("edit_request", { command: "run402 repos access revoke-key <principal_id>", why: "the ONE fully self-contained rotation entry point today — no counters needed" })],
    });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.rotateEpoch({
      ...target,
      reason: "elective_rekey",
      recipient_state_version: recipientStateVersion,
      recipient_revocation_version: recipientRevocationVersion,
      ...(flagValue(a, "--idempotency-key") != null ? { client_idempotency_key: flagValue(a, "--idempotency-key") } : {}),
    });
    printJson(sdk, result);
    await spillIfLarge(result.rotation_id, "access-repair", result);
    console.error(`rotated to epoch ${result.new_epoch} at generation ${result.generation}: ${result.included.length} recipient(s) included, ${result.excluded_keyless_principal_ids.length} keyless, ${result.excluded_unconfirmed_principal_ids.length} unconfirmed.`);
    console.error(`self_check: ${result.self_check}${result.self_check === "not_a_recipient" ? " (this machine's own principal is not itself a vault recipient — nothing to self-verify)" : " (this machine's own opened envelope reproduced the committed epoch key)"}.`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos access revoke-key <principal_id>` (D199) — the ONE fully
 * self-contained rotation entry point: declares
 * `reason:"recipient_key_revoked"` for `principal_id` (owner + step-up)
 * and drives the rotation off that declaration's OWN returned counters.
 * No flags needed — this is the reason value with a real, working
 * gateway-side counter read.
 */
async function accessRevokeKey(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--idempotency-key", "-v", "--verbose", "--help", "-h"], [...COMMON_VALUE_FLAGS, "--idempotency-key"]);
  const [principalId] = requirePositionalCount(a, [...COMMON_VALUE_FLAGS, "--idempotency-key"], {
    min: 1, max: 1, command: "run402 repos access revoke-key <principal_id>",
    missing: "Missing <principal_id>. This is the principal whose current key should no longer be trusted — the next rotation excludes them from the new epoch.",
  });
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.rotateEpochForKeyRevocation(principalId, {
      ...target,
      ...(flagValue(a, "--idempotency-key") != null ? { client_idempotency_key: flagValue(a, "--idempotency-key") } : {}),
    });
    printJson(sdk, result);
    await spillIfLarge(result.rotation_id, "access-revoke-key", result);
    console.error(`declared ${principalId}'s key revoked and rotated to epoch ${result.new_epoch} at generation ${result.generation}: ${result.included.length} recipient(s) included going forward.`);
    console.error(`self_check: ${result.self_check}.`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos access declare-exposure` (D199) — declares
 * `reason:"epoch_secret_exposed"` admissible for THIS vault (owner +
 * step-up), vault-scoped (one vault's leaked key is not evidence any
 * sibling vault is compromised). The DECLARATION itself is real and
 * self-contained; the FOLLOW-UP rotation it authorizes is NOT auto-run
 * here, because — same confirmed gap as `access repair` — the D194
 * counters it must be fenced against have no client-visible read for this
 * reason value either. This is the rekey remedy the exposed-key incident
 * needs: declare here, then rotate (via `--recipient-state-version`/
 * `--recipient-revocation-version` once known, e.g. from platform staff).
 *
 * **If a `/confirm`/`/repin` receipt is already pending** (a directory
 * principal was confirmed BEFORE this declaration, or gets confirmed while
 * the rotation is outstanding), do NOT call `publishPinManifestUpdate`
 * separately — that call is itself an ORDINARY admission and is itself
 * refused `EPOCH_ROTATION_REQUIRED` for as long as this declaration stays
 * outstanding (reproduced live in production 2026-08-27). Pass the receipt
 * to `r.gitvault.rotateEpoch({..., pending_confirmations: [{principal_id,
 * ek_fingerprint, receipt}]})` instead — it rides the SAME head as the
 * rotation this declaration requires, publishing durably without needing a
 * second, separately-gated admission. See `GitvaultVault.rotateEpoch`'s
 * doc comment for what this does NOT do: the folded principal is still
 * excluded from THIS rotation's own envelope set (D196) and becomes
 * eligible starting at the NEXT rotation.
 */
async function accessDeclareExposure(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access declare-exposure", missing: "" });
  const target = await vaultTarget(a);
  try {
    const sdk = getSdk();
    const repoId = target.repo_id ?? (await sdk.gitvault.forProject(target.project_id)).repo_id;
    const result = await sdk.gitvault.declareEpochSecretExposed(repoId);
    printJson(sdk, result);
    console.error(`declared epoch_secret_exposed for ${repoId} (epoch_secret_exposure_version now ${result.epoch_secret_exposure_version}).`);
    console.error("THIS DECLARATION DOES NOT ROTATE THE VAULT BY ITSELF — the next ordinary push now refuses EPOCH_ROTATION_REQUIRED until a rotate_epoch with reason:\"epoch_secret_exposed\" commits.");
    console.error("submit that rotation via r.gitvault.rotateEpoch({repo_id, reason: \"epoch_secret_exposed\", recipient_state_version, recipient_revocation_version}) once you have the two counter values (no CLI shortcut exists for this reason yet — see `run402 repos access repair --help`).");
    console.error("if a /confirm or /repin receipt is already pending for a directory principal, do NOT publish it separately (publishPinManifestUpdate is itself gated the same way) — pass it as rotateEpoch's pending_confirmations instead so it rides the SAME head as this rotation.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function access(args) {
  const a = normalizeArgv(args);
  if (a[0] === "repair") return accessRepair(a.slice(1));
  if (a[0] === "revoke-key") return accessRevokeKey(a.slice(1));
  if (a[0] === "declare-exposure") return accessDeclareExposure(a.slice(1));
  return accessRead(a);
}

// ─── recover ─────────────────────

/** `repos recover --human`: the same verdict the stderr lines already carry, condensed into one block. */
function formatRecoverHuman(result, outDir) {
  const lines = [
    `Repo: ${result.repo_id}`,
    `Recovered generation ${result.recovered_generation} into ${outDir}` +
      (result.chain_break ? ` (chain break at ${result.chain_break.generation} — fell back to the newest fully-verified generation)` : "") + ".",
  ];
  if (result.data_loss_detected) {
    lines.push(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences.`);
  }
  lines.push(`Layout: ${result.layout}` + (result.layout === "bare" ? " (no working files — not a failed recovery)" : ""));
  return lines.join("\n");
}

async function recover(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--out", "--repo", "--profile", "--region", "--endpoint"];
  assertKnownFlags(a, [...valueFlags, "--ambient", "--human", "-v", "--verbose", "--help", "-h"], valueFlags);
  const [source] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 repos recover <source> --out <dir>",
    missing: "Missing <source>. Expected s3://<bucket>[/<prefix>] or a directory path.",
  });
  const outDir = flagValue(a, "--out");
  if (outDir == null) {
    fail({ code: "BAD_USAGE", message: "run402 repos recover needs --out <dir>.", hint: "Where to materialize the recovered repository, e.g. --out ./restored" });
  }
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const credential = resolveMirrorCredential(a);
  const repoId = flagValue(a, "--repo");
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  try {
    const result = await sdk.gitvault.recover({
      source, out_dir: outDir,
      ...(repoId != null ? { repo_id: repoId } : {}),
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
    });
    if (human) {
      console.log(formatRecoverHuman(result, outDir));
      if (result.layout === "bare") for (const n of result.next_actions ?? []) console.error(`next: ${n.action} — ${n.command}`);
      printMirrorHonesty(result);
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "recover", result);
    console.error(`recovered generation ${result.recovered_generation} for ${result.repo_id} into ${outDir}` + (result.chain_break ? ` (chain break at ${result.chain_break.generation} — fell back to the newest fully-verified generation)` : "") + ".");
    if (result.data_loss_detected) {
      console.error(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences — see "absences" in the result above.`);
    }
    if (result.layout === "bare") {
      console.error(`layout: bare (no working files in ${outDir} — this is not a failed recovery)`);
      for (const n of result.next_actions ?? []) console.error(`next: ${n.action} — ${n.command}`);
    }
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
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
