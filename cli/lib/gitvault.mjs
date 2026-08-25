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
import { readFileSync } from "node:fs";
import { resolveProjectId } from "./config.mjs";
import { resolveOwningOrgId } from "./org-context.mjs";
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
  run402 gitvault init    [--project <id>] [--org <org_id>] [--git-remote] [--no-remote]
  run402 gitvault status  [--project <id>] [--repo <repo_id>] [--refs]
  run402 gitvault push    [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint]
  run402 gitvault policy  <required|grandfathered> [--project <id>] [--repo <repo_id>]
                          [--reason <why>]
  run402 gitvault compact [--project <id>] [--repo <repo_id>]
  run402 gitvault prune   [--project <id>] [--repo <repo_id>]
                          [--submit --intent-core <path> --verifier-receipt <path> [--wait]]
  run402 gitvault verify  [--project <id>] [--repo <repo_id>] [--budget <n>]

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
  push      Capture the working tree and publish it. This is NOT gated on a
            deploy — a vault-only project pushes for months without one.
            Against a project with no vault yet, this ALLOCATES one inline
            (the six-stage creation, same as \`init\`) before publishing — one
            command, no prior \`gitvault init\`. The one-shot recovery receipt
            and keystore path print to stderr the moment that happens.
            Before reporting a push as landed the SDK compares finalization
            receipts against the expected manifest and reads the admitted head
            back from storage; a 200 alone is never enough.
  compact   Publish a checkpoint covering the canonical refs, every root
            unexpired at the cutoff, and the HEAD target, under a maintenance
            lease so a concurrent cycle cannot race it.
  prune     Plan a prune, and — with both verifier receipts — submit it.
            Two phases, because the protocol is two-phase; see below.
  verify    Verify the head chain from the authenticated pin up to the newest
            listed generation. Fails closed on a regression, a gap, or a
            transition descriptor this client cannot validate.

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
  --repo <repo_id>  Address the vault directly by id, skipping project lookup
  --message <text>  push: commit message for the synthetic commit a dirty tree
                    produces (a clean tree pushes HEAD itself, no message used)
  --checkpoint      push: force the checkpoint-bearing form regardless of delta size
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
  run402 gitvault push --message "wip: refactor the parser"
  run402 gitvault policy grandfathered --reason "migrating CI to a vaulted client"
  run402 gitvault verify --budget 500
  run402 gitvault prune --project prj_1a2b3c
`;

/**
 * Resolve which vault to act on, plus the local git tree.
 *
 * `--repo` addresses the vault directly (the cold-restart path: an agent that
 * knows its repo_id needs no project lookup). Otherwise the project is
 * resolved the CLI-wide way — `--project`, then RUN402_PROJECT_ID, then the
 * active project — and the SDK resolves the vault from it.
 */
function vaultTarget(a) {
  const repoId = flagValue(a, "--repo");
  const project = flagValue(a, "--project");
  const target = { repo_dir: process.cwd() };
  if (repoId != null) target.repo_id = repoId;
  // Only demand a project when one is actually needed: `--repo` alone is a
  // complete address, and requiring an active project on top of it would make
  // the cold-restart path fail for no reason.
  if (repoId == null || project != null) target.project_id = resolveProjectId(project);
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

/** Where the keystore lives — for verbs whose payload is not a `status`. */
async function printKeystoreLocation() {
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

  const target = vaultTarget(a);
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

async function status(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--refs", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 gitvault status", missing: "",
  });
  const target = vaultTarget(a);
  if (a.includes("--refs")) target.refs = true;
  try {
    const s = await getSdk().gitvault.status(target);
    console.log(JSON.stringify(s, null, 2));
    printTerminalLoss(s);
    // Two facts the user otherwise has to leave the CLI for: which vault this
    // checkout is wired to, and what the control plane says is in it.
    if (s.remote) {
      console.error(`remote '${s.remote.name}': ${s.remote.url}${s.remote.matches ? "" : "  ← points at a DIFFERENT project than this status"}`);
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

async function push(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--message"];
  assertKnownFlags(a, [...valueFlags, "--checkpoint", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, {
    min: 0, max: 0, command: "run402 gitvault push", missing: "",
  });
  const message = flagValue(a, "--message");
  const target = vaultTarget(a);
  // D2: lazily allocate the vault on first push when there is a project to
  // resolve the owning org from — the same resolution `gitvault init` uses.
  // `--repo`-only addressing has nothing to create FROM (no project_id), so
  // it is skipped there, matching `open()`'s own precedence.
  const orgId = target.project_id ? await resolveOwningOrgId(target.project_id) : null;
  const opts = {
    ...target,
    ...(orgId ? { org_id: orgId } : {}),
    // The gitvault_commit line is progress, not payload: print it the moment
    // the snapshot exists, well before the publication round-trips finish, so
    // a human watching a slow push sees what is being pushed.
    onCommitLine: (line) => console.error(line),
    // Fires synchronously, BEFORE the capture/publish that follows — printed
    // here rather than deferred past `push()`'s return so the receipt is
    // never lost if a later step in the SAME push fails after allocation
    // already landed on the server.
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
    const result = await getSdk().gitvault.push(opts);
    console.log(JSON.stringify(result, null, 2));
    console.error(`published generation ${result.generation} (${result.form})`);
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
    const result = await getSdk().gitvault.compact(vaultTarget(a));
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
  const opts = vaultTarget(a);
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
  const target = vaultTarget(a);
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
    case "push": {
      await push(argv);
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
    default:
      failUnknownSubcommand("gitvault", sub, {
        hint: "Run `run402 gitvault --help` for usage.",
      });
  }
}
