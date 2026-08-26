/**
 * `run402 gitvault` — the host-blind encrypted Git remote (wire tag `r402s/v0`).
 *
 * ARCHITECTURAL LAW (gitvault-client-surface, "All protocol logic lives in the
 * SDK"): every piece of vault protocol behaviour — crypto core, keystore,
 * creation journal, snapshot + capture, publication state machines, ref
 * transactions, verification budget, token exchange, repair — lives ONCE in
 * `@run402/sdk` under `r.gitvault`. This module is a THIN ADAPTER: argument
 * parsing, TTY output, exit codes, local file I/O. It adds zero protocol
 * behaviour, and imports only the SDK (via `./sdk.mjs`) plus the CLI's own
 * argument/error helpers — never a crypto, HTTP, or git library.
 *
 * Pipe contract (docs/style.md): the payload is JSON on stdout; every human
 * line — progress, the terminal-loss statement, advisories — goes to stderr, so
 * `run402 gitvault status | jq` stays clean.
 *
 * Run these from inside the git working tree: `repo_dir` is `process.cwd()`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectId } from "./config.mjs";
import { resolveOwningOrgId } from "./org-context.mjs";
import { resolveGitvaultTarget } from "./gitvault-target.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  parseIntegerFlag,
  flagValue,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";

/** Value-taking flags every gitvault subcommand accepts. */
const COMMON_VALUE_FLAGS = ["--project", "--repo"];

export const HELP = `run402 gitvault — your source, encrypted before it leaves the machine

Usage:
  run402 gitvault init     [--project <id>] [--org <org_id>] [--git-remote] [--no-remote]
  run402 gitvault status   [--project <id>] [--repo <repo_id>] [--refs] [--human]
  run402 gitvault snapshot [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint] [--dry-run]
  run402 gitvault policy   <required|grandfathered> [--project <id>] [--repo <repo_id>]
                           [--reason <why>]
  run402 gitvault compact  [--project <id>] [--repo <repo_id>]
  run402 gitvault prune    [--project <id>] [--repo <repo_id>]
                           [--submit --intent-core <path> --verifier-receipt <path> [--wait]]
  run402 gitvault verify   [--project <id>] [--repo <repo_id>] [--budget <n>]
  run402 gitvault mirror set <destination> [--profile <name> | --ambient]
                           [--region <r>] [--endpoint <url>] [--project <id>] [--repo <repo_id>]
  run402 gitvault mirror remove   [--project <id>] [--repo <repo_id>]
  run402 gitvault mirror status   [--project <id>] [--repo <repo_id>]
  run402 gitvault mirror sync     [--project <id>] [--repo <repo_id>]
  run402 gitvault mirror verify   [--project <id>] [--repo <repo_id>]
  run402 gitvault recover <source> --out <dir> [--repo <repo_id>]
                           [--profile <name> | --ambient] [--region <r>] [--endpoint <url>]

Subcommands:
  init      ALLOCATE the project's vault. This is the one step that mints key
            material on this machine and emits the one-shot recovery receipt,
            so it is explicit rather than a side effect of \`run402 init\` (which
            only adds the git remote). Idempotent: an existing vault is
            reported with \`deduplicated: true\` and nothing is re-minted. Adds
            the \`run402\` remote too when the current directory is already a
            repository.
  status    What this machine and the control plane each believe about the
            vault: allocation, policy, whether this keystore can sign, the
            authenticated and materialized pins, any pending
            unvaulted-override journals, and where the keystore lives. Never
            reports key material.
  policy    Set the activation policy — \`required\` (a deploy must present a
            vaulted capture) or \`grandfathered\` (it need not). Owner + step-up,
            audited. \`grandfathered\` is the documented way out of a deploy
            blocked by GITVAULT_CLIENT_UPGRADE_REQUIRED, and leaves a
            doctor-persistent warning until the project returns to \`required\`.
  snapshot  Capture the working tree and publish it. This is NOT gated on a
            deploy — a vault-only project snapshots for months without one.
            Against a project with no vault yet, this ALLOCATES one inline
            (the six-stage creation, same as \`init\`) before publishing — one
            command, no prior \`gitvault init\`. When --repo/--project are
            both omitted and the local run402/origin remote is a slug-form
            address (run402::<org-slug>/<name>), PUSH-TO-CREATES through it
            instead (design D6) — same as pushing that name with \`git\`. The
            one-shot recovery receipt and keystore path print to stderr the
            moment that happens.
            Before reporting a snapshot as landed the SDK compares finalization
            receipts against the expected manifest and reads the admitted head
            back from storage; a 200 alone is never enough. \`push\` is a
            deprecation-warning alias for one release — it will be removed
            next release. Once \`gitvault\` was the only publish verb; \`git
            push\` is now the actual publish path (via the remote helper),
            so \`push\` here was renamed to name what it does: one verb per
            operation. \`--dry-run\` (kychee-com/run402#565) previews it
            instead: the same real local pipeline, publishing nothing and
            never allocating.
  compact   Publish a checkpoint covering the canonical refs, every root
            unexpired at the cutoff, and the HEAD target, under a maintenance
            lease so a concurrent cycle cannot race it.
  prune     Plan a prune, and — with both verifier receipts — submit it.
            Two phases, because the protocol is two-phase; see below.
  verify    Verify the head chain from the authenticated pin up to the newest
            listed generation. Fails closed on a regression, a gap, or a
            transition descriptor this client cannot validate.
  mirror    The exit ramp (gitvault-mirror-and-recover): a client-side,
            customer-owned ciphertext mirror. run402 never holds a
            credential to it. \`set\` configures the destination (config
            lives beside the keystore, never in run402.config.json, never a
            raw secret); \`remove\` drops the config only — it NEVER touches
            the mirror's own bytes; \`status\` reports whether the mirror is
            current against the live vault; \`sync\` lists+diffs+copies what
            the mirror is missing (idempotent, resumable); \`verify\` is the
            KEYLESS integrity probe — discovery + chain verification +
            absence adjudication, never decryption. Every deploy/snapshot
            dual-pushes to a configured mirror automatically; a mirror
            failure NEVER blocks the deploy — it is reported as a separate
            \`mirror_push\` field.
  recover   \`r402s-recover\`: rebuild a working git repository straight from
            a mirrored prefix, with NO SERVER INVOLVED. Proves this mirror's
            validity, never freshness — read both honesty statements in the
            output before relying on the result.

Options:
  --project <id>    Project whose vault to act on (defaults to the active project)
  --org <org_id>    init: the owning organization (resolved from the project
                    when omitted)
  --git-remote      init: 'git init' the current directory when it is not a
                    repository yet, so the run402 remote can be added there.
                    Opt-in: creating a repository where you did not ask for one
                    is a bad surprise, so without it a non-repository directory
                    allocates the vault and adds no remote.
  --no-remote       init: allocate the vault only; touch no git configuration
  --reason <why>    policy: why the policy is changing — recorded in the audit
                    event. REQUIRED for \`grandfathered\`, which is a deliberate
                    weakening of the activation guarantee.
  --refs            status: also materialize and report the vault's ref map and
                    HEAD target. This is a VERIFICATION (it walks the head
                    chain and advances the local materialized pin), which is
                    why plain \`status\` — an observation — does not do it.
  --human           status: a five/six-line human summary on stdout instead of
                    the JSON dump (kychee-com/run402#569; explicit opt-in per
                    the cli-output-contract). Address, remote; HEAD + ref count
                    (needs --refs too — otherwise the line names the omission);
                    generations in decimal; storage bytes/object count (from
                    this SAME status() call — no extra network read); whether
                    THIS machine can decrypt, and the policy; standing warnings,
                    if any, verbatim (a live terminal-loss risk may be the sixth
                    line). Rejected together with --json. No effect on plain
                    \`status\`'s own output, which is unchanged.
  --repo <repo_id>  Address the vault directly by id, skipping project lookup
  --message <text>  snapshot: commit message for the synthetic commit a dirty tree
                    produces (a clean tree pushes HEAD itself, no message used)
  --checkpoint      snapshot: force the checkpoint-bearing form regardless of delta size
  --dry-run         snapshot: a REAL preview (kychee-com/run402#565) — runs the actual
                    local pipeline (capture, pack building, encryption sizing) and
                    reports objects, encrypted bytes, refs, and the generation it
                    would admit as. Publishes NOTHING, and never allocates a vault
                    that does not exist yet (reports allocation_needed instead).
  --budget <n>      verify: heads to verify in this call. The verified prefix is
                    persisted, so a budget-exceeded run resumes where it stopped
                    instead of restarting.
  --submit          prune: submit the planned intent. Requires --intent-core and
                    --verifier-receipt.
  --intent-core <path>
                    prune: the plan's \`intent_core\`, saved verbatim from a prior
                    planning run. A rebuilt core carries a different nonce, so
                    the r402s-verify receipt would no longer bind to it.
  --verifier-receipt <path>
                    prune: r402s-verify's \`verifier_receipt\` over that core.
  --wait            prune: poll the submitted intent until the control-plane-
                    signed completion appears, instead of returning immediately.
  --profile <name>  mirror set / recover: the AWS credential profile name for an
                    s3:// destination (read from ~/.aws/credentials at USE time —
                    never stored). Mutually exclusive with --ambient.
  --ambient         mirror set / recover: use the ambient AWS_ACCESS_KEY_ID /
                    AWS_SECRET_ACCESS_KEY environment chain instead of a profile.
  --region <r>      mirror set / recover: AWS region for an s3:// destination
                    (defaults to AWS_REGION / AWS_DEFAULT_REGION).
  --endpoint <url>  mirror set / recover: an S3-compatible endpoint override.
  --out <dir>       recover: where to materialize the recovered repository.
  --json            No-op: stdout is already JSON.

prune is TWO PHASES, because the protocol is:
  1. \`run402 gitvault prune\` plans. It walks the verified chain, computes the GC
     root set, subtracts it, and prints a SIGNED \`intent_core\` plus its
     \`intent_core_sha256\`. Nothing is submitted and nothing is deleted.
  2. Run \`r402s-verify\` against that core, then re-run with
     \`--submit --intent-core <core.json> --verifier-receipt <receipt.json>\`.
     The intent carries TWO receipts over the same core, one per implementation:
     this CLI produces the \`run402-cli\` half by restoring the latest checkpoint
     and recomputing its commitments, and \`r402s-verify\` produces the other.
     A second receipt from this lineage would prove nothing, so it is never
     synthesized here.
  Only the control-plane-signed completion says what was deleted, and only its
  \`deleted\` result means the bytes are gone — \`present_after_attempt\` is a
  FAILED deletion, never counted as a success. There is deliberately no purge
  verb in V0 at all. Retention is an operational promise of the platform, not a
  cryptographic guarantee against it.

Expiry is permissive, by design:
  A retention root whose \`effective_admitted_at\` this client cannot resolve is
  RETAINED, and a compact that cannot obtain a retention-cutoff ticket keeps
  every root. That costs storage, never history.

Terminal loss (protocol §0):
  In V0-A, whole-machine or whole-keystore loss is terminal for vault history
  until human envelopes ship. \`status\` prints the full statement verbatim on
  stderr and carries it in its JSON — read it before you rely on this.

Examples:
  run402 gitvault init
  run402 gitvault status --refs
  run402 gitvault status --human
  run402 gitvault snapshot --message "wip: refactor the parser"
  run402 gitvault snapshot --dry-run
  run402 gitvault policy grandfathered --reason "migrating CI to a vaulted client"
  run402 gitvault verify --budget 500
  run402 gitvault prune --project prj_1a2b3c
  run402 gitvault mirror set s3://acme-vault-mirror --profile acme
  run402 gitvault mirror sync
  run402 gitvault mirror status
  run402 gitvault mirror verify
  run402 gitvault recover s3://acme-vault-mirror --out ./restored
  # \`gitvault push\` still works as a deprecation-warning alias for \`snapshot\`
  # for one release; it will be removed next release.
`;

/**
 * Resolve which vault to act on, plus the local git tree.
 *
 * `--repo` addresses the vault directly (the cold-restart path: an agent that
 * knows its repo_id needs no project lookup). Otherwise the project targets,
 * highest first: `--project` > the repo's own pin/remote > RUN402_PROJECT_ID
 * > the active project (repo-first-onramp follow-up, kychee-com/run402#559 —
 * see `gitvault-target.mjs`'s module doc for the full targeting order and
 * why it exists: a stale active-project pointer used to silently outrank the
 * repository this command is actually standing in).
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
  // Only demand a project when one is actually needed: `--repo` alone is a
  // complete address, and requiring one on top of it would make the
  // cold-restart path fail for no reason.
  if (repoId == null || project != null) {
    if ("repo_id" in resolved && project == null) target.repo_id = resolved.repo_id;
    // `resolveGitvaultTarget` reports its last (env/active) tier
    // non-throwingly (`run402 doctor`'s call site needs that) — this call
    // site is the one that historically failed closed with PROJECT_REQUIRED
    // when nothing resolves anywhere, and still does: `resolveProjectId`
    // re-derives the exact same env/active check and throws.
    if ("project_id" in resolved) target.project_id = resolved.project_id ?? resolveProjectId(project);
  }
  return target;
}

/**
 * Print the protocol §0 terminal-loss statement.
 *
 * NORMATIVE COPY, printed verbatim straight from the SDK's own constants and
 * never paraphrased, summarized, or reassembled here. Both lines also ride in
 * the JSON payload on stdout.
 *
 * The PATH is printed with it. "Whole-keystore loss is terminal" appeared three
 * times across this surface while the directory to back up appeared nowhere
 * (dogfood #1, finding D2) — a warning nobody can act on.
 */
function printTerminalLoss(status) {
  console.error("");
  console.error(status.terminal_loss_statement);
  console.error(status.terminal_loss_detail);
  console.error(`Back up this directory: ${status.keystore.root}`);
  console.error("");
}

/**
 * Where the keystore lives — for verbs whose payload is not a `status`.
 * Exported: `repos create` (repo-first-onramp task 2.6) prints the same
 * line after allocating a vault, and must not restate this logic.
 */
export async function printKeystoreLocation() {
  try {
    const { getGitvaultKeystoreRoot } = await import("#sdk/node");
    console.error(`keystore: ${getGitvaultKeystoreRoot()} — back this up; whole-keystore loss is terminal for vault history`);
  } catch {
    // Never let a diagnostic line fail a command that already succeeded.
  }
}

/**
 * `run402 gitvault init` — allocate the project's vault.
 *
 * WHY THIS EXISTS AS ITS OWN VERB (dogfood #1, finding A). Until it did, the
 * only way to allocate was `sdk.gitvault.init()` through the vendored SDK:
 * `gitvault status` pointed at `run402 init`, which scaffolds the remote and
 * says so in a comment; `gitvault push` and `git push run402` both 404'd and
 * handed the user a raw `POST /gitvault/v1/vaults`. A published CLI that can
 * do everything except start is not a usable product.
 *
 * It stays SEPARATE from `run402 init` on purpose: this is the step that mints
 * key material on this machine and emits a one-shot recovery receipt, and
 * whole-keystore loss is terminal for vault history. That belongs to a command
 * the user typed, not to a setup command's side effects.
 */
async function init(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--project", "--org"];
  assertKnownFlags(a, [...valueFlags, "--git-remote", "--no-remote", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, {
    min: 0, max: 0, command: "run402 gitvault init", missing: "",
  });
  if (a.includes("--git-remote") && a.includes("--no-remote")) {
    fail({
      code: "BAD_USAGE",
      message: "--git-remote and --no-remote contradict each other.",
      hint: "--git-remote creates a repository to add the remote to; --no-remote touches no git configuration at all.",
    });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  const orgId = flagValue(a, "--org") ?? await resolveOwningOrgId(projectId);
  if (!orgId) {
    fail({
      code: "ORG_UNRESOLVED",
      message: `Could not resolve the organization that owns ${projectId}.`,
      hint: "Pass --org <org_id>, or check that this wallet can see the project (`run402 projects list`).",
      details: { project_id: projectId },
    });
  }

  // Whether to touch git at all. Mirrors `run402 init`: adding a remote inside
  // an EXISTING repository is pure addition and is the default; CREATING a
  // repository is opt-in, because a vault can be allocated from anywhere and
  // `git init`-ing whatever directory you happened to be in is a bad surprise.
  let scaffold = !a.includes("--no-remote");
  let remoteSkipped = null;
  if (scaffold && !a.includes("--git-remote")) {
    const { hardenedGit } = await import("#sdk/node");
    try {
      await hardenedGit(process.cwd(), ["rev-parse", "--git-dir"]);
    } catch {
      scaffold = false;
      remoteSkipped = "not a git repository — the vault was allocated; re-run with --git-remote to create one and add the remote";
    }
  }

  try {
    const result = await getSdk().gitvault.init({
      org_id: orgId,
      project_id: projectId,
      ...(scaffold ? { repo_dir: process.cwd() } : { scaffold_git: false }),
    });
    console.log(JSON.stringify(remoteSkipped ? { ...result, remote_skipped: remoteSkipped } : result, null, 2));
    console.error(
      result.deduplicated
        ? `vault ${result.repo_id} already existed — nothing was re-allocated and no new key material was minted`
        : `allocated vault ${result.repo_id} (genesis ${result.genesis_sha256})`,
    );
    if (result.remote) console.error(`remote '${result.remote.name}' -> ${result.remote.url} (${result.remote.reason})`);
    if (remoteSkipped) console.error(`remote not added: ${remoteSkipped}`);
    // The recovery receipt is integrity data, not a secret, and it is worth
    // exactly as much as the number of copies you keep. It is persisted into
    // the keystore automatically; say where, because "keep many copies" is
    // advice nobody can act on without a path.
    console.error("");
    console.error(result.terminal_loss_statement);
    await printKeystoreLocation();
    console.error("");
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 gitvault policy <required|grandfathered>` — the activation gate.
 *
 * The gateway's own `GITVAULT_CLIENT_UPGRADE_REQUIRED` envelope names
 * `run402 gitvault policy grandfathered --reason <why>` as the second way out
 * of a blocked deploy. Until this verb existed, running exactly what the
 * platform told you to run returned UNKNOWN_SUBCOMMAND, so a user could
 * allocate themselves into a blocked-deploy state with no way back.
 */
async function policy(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--reason"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  const [requested] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 gitvault policy <required|grandfathered>",
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
  // Required only for the weakening direction. Returning to `required` is
  // restoring the default and needs no justification; leaving it does.
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
    const result = await sdk.gitvault.setPolicy(repoId, {
      gitvault_policy: requested,
      ...(reason != null ? { reason } : {}),
    });
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

/**
 * The vault's address in the form a human would actually type it: named
 * (`run402::<org-slug>/<name>`) when this checkout's local pin resolved from
 * one — an id-form pin buys nothing and is never written (see
 * `gitvault-address.ts`'s own doc comment), so a non-null `s.pinned` always
 * carries `resolved_from` — else id-form (`run402::<org_id>/<project_id>`),
 * falling back to whichever of project_id/repo_id is known when the vault
 * record itself is unavailable.
 */
function formatGitvaultAddress(s) {
  if (s.pinned?.resolved_from) {
    return `run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name}`;
  }
  const orgId = s.vault?.org_id ?? null;
  const projectId = s.project_id ?? s.vault?.project_id ?? null;
  if (orgId && projectId) return `run402::${orgId}/${projectId}`;
  if (projectId) return projectId;
  if (s.repo_id) return `repo ${s.repo_id}`;
  return "(unresolved)";
}

/**
 * `run402 gitvault status --human` (kychee-com/run402#569) — the five-liner:
 * "status --refs is an admission-debugging protocol dump; the human question
 * is five lines — remote URL, branch/HEAD, generation, bytes,
 * can-this-machine-decrypt." Renders from `s` alone — the SAME status() call
 * the JSON path already made, so `--human` costs no extra network read.
 *
 * Generations render DECIMAL, not the wire's 16-hex-digit form — a hex
 * generation is a protocol detail, not something a human reads at a glance.
 *
 * The HEAD/ref-count line needs the vault's OWN ref map, which `status`
 * fetches only when `--refs` is ALSO passed (materializing is a verification
 * that advances local state — `status` alone stays a pure observation, see
 * that option's own doc comment). Composing `--human --refs` gets the full
 * line; `--human` alone names the omission rather than guessing from the
 * local git checkout, which could easily disagree with what the vault holds.
 *
 * Warnings — including the progressive terminal-loss risk warning — are
 * echoed EXACTLY as the SDK reported them (never reworded) and become an
 * optional sixth line, present only when `s.warnings` is non-empty. Without
 * `--human`, `run402 gitvault status` is unchanged: it always prints the
 * FULL terminal-loss statement verbatim on stderr regardless of warnings;
 * this compact view surfaces it only when it is actually live advice.
 */
async function formatGitvaultHuman(s) {
  const lines = [];
  const remotePart = s.remote
    ? ` (remote '${s.remote.name}'${s.remote.matches ? "" : " — points at a DIFFERENT project"})`
    : " (no local remote)";
  lines.push(`Address: ${formatGitvaultAddress(s)}${remotePart}`);

  if (!s.vault) {
    // A normal shape (protocol D183) — no vault allocated for this project
    // yet. Nothing below this line is knowable, so it is not fabricated.
    lines.push("Vault: not allocated yet for this project — run 'run402 gitvault init' to allocate one.");
    if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);
    return lines.join("\n");
  }

  if (s.refs) {
    const count = Object.keys(s.refs).length;
    const head = !s.head_target
      ? "(none yet)"
      : s.head_target.kind === "symref"
        ? s.head_target.ref
        : `detached @ ${s.head_target.oid}`;
    lines.push(`HEAD: ${head}  (${count} ref${count === 1 ? "" : "s"})`);
  } else {
    lines.push("HEAD: (not materialized — pass --refs to see HEAD/ref count)");
  }

  const { generationToBigInt } = await import("#sdk/node");
  const decimal = (g) => (g ? generationToBigInt(g).toString() : "none");
  lines.push(`Generations: authenticated ${decimal(s.pins.highest_authenticated)}, materialized ${decimal(s.pins.highest_materialized)}`);

  // Bytes + object count — pulled from the vault record `status()` ALREADY
  // fetched (no new network read, per the ask). `objects` is per-object-kind
  // counts; summed for one number a human can glance at.
  const storage = s.vault.storage;
  const objectCount = storage?.objects ? Object.values(storage.objects).reduce((sum, n) => sum + Number(n), 0) : null;
  lines.push(storage ? `Storage: ${storage.source_bytes} byte(s)${objectCount != null ? ` across ${objectCount} object(s)` : ""}` : "Storage: unknown");

  const decryptPart = !s.keystore.holds_repo_key
    ? "CANNOT decrypt (no key in this machine's keystore)"
    : s.keystore.can_sign
      ? "can decrypt and publish"
      : "can decrypt (read-only — no signing key)";
  lines.push(`This machine: ${decryptPart}. Policy: ${s.gitvault_policy ?? "(none)"}`);

  if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);

  return lines.join("\n");
}

async function status(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--refs", "--human", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 gitvault status", missing: "",
  });
  // kychee-com/run402#569 — an explicit opt-in per the cli-output-contract
  // (openspec/specs/cli-output-contract/spec.md: raw/human stdout REQUIRES
  // one), the same shape `run402 up`'s own `--human` already uses. Without
  // it, behavior is byte-identical to before this flag existed.
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({
      code: "BAD_USAGE",
      message: "--human cannot be combined with --json.",
      details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") },
    });
  }
  const target = await vaultTarget(a);
  if (a.includes("--refs")) target.refs = true;
  try {
    const s = await getSdk().gitvault.status(target);
    if (human) {
      // The human view REPLACES the JSON dump — it is the sanctioned
      // exception the CLI-wide `--json` no-op convention already carves out
      // for a command's OWN `--human` flag (see argparse.mjs's header
      // comment). No new network read: everything below is already present
      // on `s`, the SAME status() call the JSON path made.
      console.log(await formatGitvaultHuman(s));
      return;
    }
    console.log(JSON.stringify(s, null, 2));
    printTerminalLoss(s);
    // Two facts the user otherwise has to leave the CLI for: which vault this
    // checkout is wired to, and what the control plane says is in it.
    if (s.remote) {
      // `matches` is a TRI-STATE (kychee-com/run402#562): `false` is a real
      // mismatch; `null` only means a slug-form remote has not resolved on
      // this machine yet — that is NOT evidence of anything wrong, so it
      // gets a neutral note, never the mismatch warning.
      const suffix =
        s.remote.matches === false ? "  ← points at a DIFFERENT project than this status"
        : s.remote.matches === null ? `  (${s.remote.reason})`
        : "";
      console.error(`remote '${s.remote.name}': ${s.remote.url}${suffix}`);
    }
    // The id-pinning state (design D6, task 4.5): a slug-form remote pins
    // repo_id in local git state the first time it resolves; id-form pins
    // nothing (it needs no pin — see resolveGitvaultAddress's doc comment).
    if (s.pinned) {
      console.error(
        `pinned: repo_id ${s.pinned.repo_id}` +
        (s.pinned.resolved_from ? ` (resolved from run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name})` : ""),
      );
    }
    if (s.refs) {
      const names = Object.keys(s.refs).sort();
      console.error(names.length === 0 ? "refs: (none yet)" : `refs (${names.length}):`);
      for (const ref of names) console.error(`  ${s.refs[ref]}  ${ref}`);
      if (s.head_target) {
        console.error(s.head_target.kind === "symref" ? `  HEAD -> ${s.head_target.ref}` : `  HEAD ${s.head_target.oid} (detached)`);
      }
    }
    // Advisories are echoed EXACTLY as the SDK reported them. Nothing is
    // synthesized here — in particular a project that has never deployed gets
    // no deploy-related warning, because a vault-only project is a first-class
    // shape (protocol D183), not a half-configured deploy.
    for (const w of s.warnings) console.error(`warning (${w.kind}): ${w.message}`);
    for (const n of s.next_actions) console.error(`next: ${n.action}${n.command ? ` — ${n.command}` : ""}`);
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * D5 (repo-first-onramp task 2.5): one verb per operation. Renamed from
 * `push` — `push` now means exactly one thing everywhere: `git push`. The
 * capture lane keeps its old function name internally to minimize churn;
 * only the dispatched SUBCOMMAND name changed (see `run()` below, where
 * `gitvault push` survives one release as a deprecation-warning alias).
 */
/**
 * D6 (repo-first-onramp task 4): when neither `--repo` nor `--project` was
 * given explicitly, look at the local `run402`/`origin` remote (in that
 * order, mirroring `scaffoldRemote`'s own naming) and, if it is a SLUG-form
 * address (`run402::<org-slug>/<name>`), return the parsed address so
 * `snapshot` can push-to-create through it — the same address-form
 * resolution `git push` drives via the remote helper. `null` for an
 * id-form remote, no remote at all, or an explicit `--repo`/`--project`.
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
  const valueFlags = [...COMMON_VALUE_FLAGS, "--message"];
  assertKnownFlags(a, [...valueFlags, "--checkpoint", "--dry-run", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, {
    min: 0, max: 0, command: "run402 gitvault snapshot", missing: "",
  });
  const dryRun = a.includes("--dry-run");
  const message = flagValue(a, "--message");
  const repoDir = process.cwd();
  const address = await detectSlugFormRemote(a, repoDir);
  // D2: lazily allocate the vault on first push when there is a project to
  // resolve the owning org from — the same resolution `gitvault init` uses.
  // `--repo`-only addressing has nothing to create FROM (no project_id), so
  // it is skipped there, matching `open()`'s own precedence. Skipped
  // entirely for a slug-form remote (`address` above) — that resolves
  // through the address, not a project_id, and needs no separate org_id.
  //
  // Skipped ENTIRELY for --dry-run (kychee-com/run402#565): org resolution
  // exists only to feed lazy allocation, and a dry run never allocates — the
  // read would cost a network round-trip for a fact `planPush` never uses.
  const target = address ? { repo_dir: repoDir } : await vaultTarget(a);
  const orgId = !address && !dryRun && target.project_id ? await resolveOwningOrgId(target.project_id) : null;
  const opts = {
    ...target,
    ...(address ? { address } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    // The gitvault_commit line is progress, not payload: print it the moment
    // the snapshot exists, well before the publication round-trips finish, so
    // a human watching a slow push sees what is being pushed. Fires for a
    // dry run too — the capture itself is real, local work.
    onCommitLine: (line) => console.error(line),
    // Fires synchronously, BEFORE the capture/publish that follows — printed
    // here rather than deferred past `push()`'s return so the receipt is
    // never lost if a later step in the SAME push fails after allocation
    // already landed on the server. Never fires for --dry-run: `planPush`
    // never allocates, so this callback is simply unused there.
    onVaultCreated: async (created) => {
      console.error("");
      console.error(`vault allocated (genesis ${created.genesis_sha256}) — one-shot recovery receipt, keep many copies:`);
      console.error(JSON.stringify(created.recovery_receipt));
      await printKeystoreLocation();
      console.error("");
    },
  };
  // The message rides on `snapshot`, which is what `captureSnapshot` reads —
  // and, since 5.12b removed the dead top-level `push({ message })` field, is
  // the ONE place it can ride.
  if (message != null) opts.snapshot = { message };
  if (a.includes("--checkpoint")) opts.checkpoint = true;
  try {
    if (dryRun) {
      // kychee-com/run402#565: a REAL dry run — the same local pipeline
      // `push` runs (capture, pack building, encryption sizing), stopping
      // before the two network mutations. Nothing is published; the JSON
      // report is the entire contract, so it goes on stdout like every other
      // gitvault verb's payload.
      const plan = await getSdk().gitvault.planPush(opts);
      console.log(JSON.stringify(plan, null, 2));
      if (plan.allocation_needed) {
        console.error("dry-run: no vault allocated for this project yet — a real snapshot would allocate one first; object/byte sizing is not knowable until then");
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
    // Design D6: the mirror result is reported BESIDE the vault outcome
    // above, on its own line — a mirror failure never blocked the publish.
    if (result.mirror_push?.outcome === "pushed") {
      console.error(`mirror: pushed generation ${result.generation} (${result.mirror_push.summary?.objects_copied ?? 0} object(s) copied)`);
    } else if (result.mirror_push?.outcome === "failed") {
      console.error(`mirror: dual-push FAILED (deploy is unaffected) — ${result.mirror_push.error ?? "see mirror_push.summary.errors"}`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function compact(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 gitvault compact", missing: "",
  });
  try {
    const result = await getSdk().gitvault.compact(await vaultTarget(a));
    console.log(JSON.stringify(result, null, 2));
    console.error(
      `checkpoint published at generation ${result.generation}: ` +
      `${result.covered_refs} ref(s), ${result.covered_roots} retention root(s).`,
    );
    if (!result.cutoff_bound) {
      // Say what actually happened rather than reporting a clean compaction:
      // without a ticket no root can leave the map, so this run reclaimed
      // nothing from expiry.
      console.error(
        "no retention-cutoff ticket was obtained, so roots were RETAINED — expiry is permissive. " +
        "The checkpoint published, but no expired root left the map; re-run compact once the ticket route answers.",
      );
    }
  } catch (err) {
    reportSdkError(err);
  }
}

/** Read a protocol object a prior planning run (or r402s-verify) wrote to disk. */
function readJsonFile(flag, path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: `${flag} ${path} could not be read: ${err?.message ?? String(err)}`,
      hint: "Point it at the file a prior `run402 gitvault prune` (or r402s-verify) wrote.",
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail({
      code: "BAD_USAGE",
      message: `${flag} ${path} is not valid JSON: ${err?.message ?? String(err)}`,
      hint: "Pass the file verbatim; do not reformat or re-serialize it.",
    });
  }
}

async function prune(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--intent-core", "--verifier-receipt"];
  assertKnownFlags(a, [...valueFlags, "--submit", "--wait", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, {
    min: 0, max: 0, command: "run402 gitvault prune", missing: "",
  });
  const submitting = a.includes("--submit");
  const corePath = flagValue(a, "--intent-core");
  const receiptPath = flagValue(a, "--verifier-receipt");
  // Refuse the half-specified submit here rather than planning and silently
  // discarding the flags — an agent that typed --submit meant to submit.
  if (submitting && (corePath == null || receiptPath == null)) {
    fail({
      code: "BAD_USAGE",
      message: "run402 gitvault prune --submit needs both --intent-core and --verifier-receipt.",
      hint: "Plan first (`run402 gitvault prune`), save its `intent_core`, run r402s-verify against it, then submit both.",
    });
  }
  if (!submitting && (corePath != null || receiptPath != null)) {
    fail({
      code: "BAD_USAGE",
      message: "--intent-core / --verifier-receipt only apply with --submit.",
      hint: "Add --submit, or drop the flags to plan.",
    });
  }
  const opts = await vaultTarget(a);
  if (submitting) {
    opts.submit = {
      core: readJsonFile("--intent-core", corePath),
      verifier_receipt: readJsonFile("--verifier-receipt", receiptPath),
    };
    if (a.includes("--wait")) opts.submit.wait = {};
  }
  try {
    const result = await getSdk().gitvault.prune(opts);
    console.log(JSON.stringify(result, null, 2));
    // Never imply a deletion. State what actually happened, then reproduce the
    // SDK's own note verbatim rather than summarizing it.
    if (!result.submitted) {
      console.error(
        result.blocked_reason
          ? `planned — nothing to submit: ${result.blocked_reason}`
          : `planned — nothing submitted. ${result.object_candidates.length} object(s) proposed for deletion` +
            `${result.deferred_object_count > 0 ? ` (${result.deferred_object_count} more deferred to a later intent)` : ""}` +
            `; ${result.eligible_count} retention root(s) past their window, ${result.retained_count} retained.`,
      );
      if (result.intent_core_sha256) {
        console.error(`intent_core_sha256: ${result.intent_core_sha256} — run r402s-verify against this core, then re-run with --submit.`);
      }
    } else if (result.confirmation?.outcome) {
      console.error(
        `submitted — the signed completion reports ${result.confirmation.deleted.length} deleted, ` +
        `${result.confirmation.present.length} still present` +
        `${result.confirmation.unadjudicated.length > 0 ? `, ${result.confirmation.unadjudicated.length} unadjudicated` : ""}.`,
      );
    } else {
      console.error("submitted — no completion yet. Nothing is deleted until the control-plane-signed completion says so; re-run with --wait or poll the intent.");
    }
    console.error(result.note);
  } catch (err) {
    reportSdkError(err);
  }
}

async function verify(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--budget"];
  assertKnownFlags(a, [...valueFlags, "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, {
    min: 0, max: 0, command: "run402 gitvault verify", missing: "",
  });
  const target = await vaultTarget(a);
  const budget = flagValue(a, "--budget");
  if (budget != null) target.verification_budget = parseIntegerFlag("--budget", budget, { min: 1 });
  try {
    const state = await getSdk().gitvault.verify(target);
    console.log(JSON.stringify(state, null, 2));
    console.error(`verified through generation ${state.generation}`);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── mirror (gitvault-mirror-and-recover) ─────────────────────────────────

const LARGE_OUTPUT_THRESHOLD_BYTES = 100 * 1024;

/**
 * docs/agent-response-design.md's CLI pipe-contract row: stdout ALWAYS keeps
 * the full JSON (never truncated), and when a result is large it is ALSO
 * written to a private 0600 file with a one-line stderr breadcrumb naming the
 * path. Best-effort — a spill failure never changes what the command reports.
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

/** Design D8: both honesty statements, verbatim, wherever mirror status or recovery success is shown. */
function printMirrorHonesty(result) {
  if (result.validity_not_freshness) console.error(result.validity_not_freshness);
  if (result.keystore_still_required) console.error(result.keystore_still_required);
}

function resolveMirrorCredential(a) {
  const profile = flagValue(a, "--profile");
  const ambient = a.includes("--ambient");
  if (profile != null && ambient) {
    fail({
      code: "BAD_USAGE",
      message: "--profile and --ambient contradict each other.",
      hint: "Pick one credential source for the s3:// destination.",
    });
  }
  if (profile != null) return { kind: "profile", profile };
  if (ambient) return { kind: "ambient" };
  return undefined;
}

function formatMirrorDestination(destination) {
  if (!destination) return "(none)";
  return destination.kind === "s3" ? `s3://${destination.bucket}/${destination.prefix}` : destination.path;
}

async function mirrorSetCmd(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--profile", "--region", "--endpoint"];
  assertKnownFlags(a, [...valueFlags, "--ambient", "--help", "-h"], valueFlags);
  const [destination] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 gitvault mirror set <destination>",
    missing: "Missing <destination>. Expected s3://<bucket>[/<prefix>] or a directory path.",
  });
  const credential = resolveMirrorCredential(a);
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  const target = await vaultTarget(a);
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
    console.error("run `run402 gitvault mirror sync` to backfill it now, then deploys will dual-push automatically.");
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorRemoveCmd(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 gitvault mirror remove", missing: "" });
  const target = await vaultTarget(a);
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

async function mirrorStatusCmd(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 gitvault mirror status", missing: "" });
  const target = await vaultTarget(a);
  try {
    const result = await getSdk().gitvault.mirrorStatus(target);
    console.log(JSON.stringify(result, null, 2));
    if (!result.configured) {
      console.error(`no mirror configured for ${result.repo_id}. Configure one: run402 gitvault mirror set <destination>`);
    } else {
      const currency = result.is_current === true ? "current" : result.is_current === false ? `STALE — ${result.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${result.destination}: mirrored generation ${result.mirrored_generation ?? "(none)"}, vault newest ${result.newest_generation ?? "(none)"} — ${currency}`);
    }
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorSyncCmd(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 gitvault mirror sync", missing: "" });
  const target = await vaultTarget(a);
  try {
    const result = await getSdk().gitvault.mirrorSync(target);
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "mirror-sync", result);
    console.error(
      `mirror sync for ${result.repo_id}: ${result.objects_copied} copied, ${result.objects_already_present} already present` +
      `${result.objects_failed > 0 ? `, ${result.objects_failed} FAILED` : ""} (${result.bytes_copied} byte(s) copied this run).`,
    );
    for (const e of result.errors) console.error(`  failed: ${e.key} — ${e.error}`);
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorVerifyCmd(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 gitvault mirror verify", missing: "" });
  const target = await vaultTarget(a);
  try {
    const result = await getSdk().gitvault.mirrorVerify(target);
    console.log(JSON.stringify(result, null, 2));
    await spillIfLarge(result.repo_id, "mirror-verify", result);
    console.error(`mirror keyless verify for ${result.repo_id}: recoverable generation ${result.recovered_generation}${result.chain_break ? ` (chain break at ${result.chain_break.generation}: ${result.chain_break.reason})` : ""}.`);
    if (result.data_loss_detected) {
      console.error(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences.`);
    }
    printMirrorHonesty(result);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirror(args) {
  const a = normalizeArgv(args);
  if (!a[0] || hasHelp([a[0], ...a.slice(1)])) {
    console.log(HELP);
    process.exit(0);
  }
  const action = a[0];
  const rest = a.slice(1);
  // Deliberately if/else, not a switch statement (`policy()`'s own
  // precedent above): sync.test.ts's CLI-command scanner regexes switch
  // labels FLATLY across the whole file with no nesting awareness, so a
  // nested switch here would misattribute "set"/"remove"/"sync" as bogus
  // top-level `gitvault:set` etc. commands. `gitvault mirror <action>` is
  // ONE compound verb (SURFACE's `gitvault_mirror` row), not five leaf
  // commands.
  if (action === "set") return mirrorSetCmd(rest);
  if (action === "remove") return mirrorRemoveCmd(rest);
  if (action === "status") return mirrorStatusCmd(rest);
  if (action === "sync") return mirrorSyncCmd(rest);
  if (action === "verify") return mirrorVerifyCmd(rest);
  failUnknownSubcommand("gitvault mirror", action, {
    hint: "Run `run402 gitvault mirror --help` for usage.",
    extraSubcommands: ["set", "remove", "status", "sync", "verify"],
  });
}

async function recover(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--out", "--repo", "--profile", "--region", "--endpoint"];
  assertKnownFlags(a, [...valueFlags, "--ambient", "--help", "-h"], valueFlags);
  const [source] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 gitvault recover <source> --out <dir>",
    missing: "Missing <source>. Expected s3://<bucket>[/<prefix>] or a directory path.",
  });
  const outDir = flagValue(a, "--out");
  if (outDir == null) {
    fail({
      code: "BAD_USAGE",
      message: "run402 gitvault recover needs --out <dir>.",
      hint: "Where to materialize the recovered repository, e.g. --out ./restored",
    });
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

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "init": {
      await init(argv);
      break;
    }
    case "policy": {
      await policy(argv);
      break;
    }
    case "status": {
      await status(argv);
      break;
    }
    case "snapshot": {
      await snapshot(argv);
      break;
    }
    case "push": {
      // D5: one verb per operation — "push" now means exactly one thing,
      // `git push`. Retained as a deprecation-warning alias for ONE release
      // (pre-launch, the benchmark gate prefers the rename now over an
      // alias forever); it will be removed next release.
      console.error("`run402 gitvault push` is deprecated and will be removed in the next release — use `run402 gitvault snapshot` instead.");
      await snapshot(argv);
      break;
    }
    case "compact": {
      await compact(argv);
      break;
    }
    case "prune": {
      await prune(argv);
      break;
    }
    case "verify": {
      await verify(argv);
      break;
    }
    case "mirror": {
      await mirror(argv);
      break;
    }
    case "recover": {
      await recover(argv);
      break;
    }
    default:
      failUnknownSubcommand("gitvault", sub, {
        hint: "Run `run402 gitvault --help` for usage.",
      });
  }
}
