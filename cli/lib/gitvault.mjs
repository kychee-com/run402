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
import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";
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
  run402 gitvault status  [--project <id>] [--repo <repo_id>]
  run402 gitvault push    [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint]
  run402 gitvault compact [--project <id>] [--repo <repo_id>]
  run402 gitvault prune   [--project <id>] [--repo <repo_id>]
  run402 gitvault verify  [--project <id>] [--repo <repo_id>] [--budget <n>]

Subcommands:
  status    What this machine and the control plane each believe about the
            vault: allocation, policy, whether this keystore can sign, the
            authenticated and materialized pins, and any pending
            unvaulted-override journals. Never reports key material.
  push      Capture the working tree and publish it. This is NOT gated on a
            deploy — a vault-only project pushes for months without one.
            Before reporting a push as landed the SDK compares finalization
            receipts against the expected manifest and reads the admitted head
            back from storage; a 200 alone is never enough.
  compact   Publish a checkpoint covering the canonical refs, every root
            unexpired at the cutoff, and the HEAD target, under a maintenance
            lease so a concurrent cycle cannot race it.
  prune     Report which retention roots have passed their retention window.
            DRY RUN in V0 — see below.
  verify    Verify the head chain from the authenticated pin up to the newest
            listed generation. Fails closed on a regression, a gap, or a
            transition descriptor this client cannot validate.

Options:
  --project <id>    Project whose vault to act on (defaults to the active project)
  --repo <repo_id>  Address the vault directly by id, skipping project lookup
  --message <text>  push: commit message for the synthetic commit a dirty tree
                    produces (a clean tree pushes HEAD itself, no message used)
  --checkpoint      push: force the checkpoint-bearing form regardless of delta size
  --budget <n>      verify: heads to verify in this call. The verified prefix is
                    persisted, so a budget-exceeded run resumes where it stopped
                    instead of restarting.
  --json            No-op: stdout is already JSON.

prune is a DRY RUN in V0:
  The prune intent/completion wire — the two verifier receipts and the server's
  eligibility confirmation — has no shipped route, so nothing is submitted and
  no bytes are deleted. \`submitted\` is always false. There is deliberately no
  purge verb in V0 at all. Retention is an operational promise of the platform,
  not a cryptographic guarantee against it.

Expiry is permissive, by design:
  A retention root whose \`effective_admitted_at\` this client cannot resolve is
  RETAINED, and a compact that cannot obtain a retention-cutoff ticket keeps
  every root. That costs storage, never history.

Terminal loss (protocol §0):
  In V0-A, whole-machine or whole-keystore loss is terminal for vault history
  until human envelopes ship. \`status\` prints the full statement verbatim on
  stderr and carries it in its JSON — read it before you rely on this.

Examples:
  run402 gitvault status
  run402 gitvault push --message "wip: refactor the parser"
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
 */
function printTerminalLoss(status) {
  console.error("");
  console.error(status.terminal_loss_statement);
  console.error(status.terminal_loss_detail);
  console.error("");
}

async function status(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 gitvault status", missing: "",
  });
  try {
    const s = await getSdk().gitvault.status(vaultTarget(a));
    console.log(JSON.stringify(s, null, 2));
    printTerminalLoss(s);
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
  const opts = {
    ...vaultTarget(a),
    // The gitvault_commit line is progress, not payload: print it the moment
    // the snapshot exists, well before the publication round-trips finish, so
    // a human watching a slow push sees what is being pushed.
    onCommitLine: (line) => console.error(line),
  };
  // The message rides on `snapshot`, which is what `captureSnapshot` actually
  // reads. (`push({ message })` is declared on the SDK option type but is not
  // forwarded to the capture — passing it there would silently do nothing.)
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

async function prune(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 0, max: 0, command: "run402 gitvault prune", missing: "",
  });
  try {
    const result = await getSdk().gitvault.prune(vaultTarget(a));
    console.log(JSON.stringify(result, null, 2));
    // Never imply a deletion. The header states the mode first; the SDK's own
    // note is then reproduced verbatim rather than summarized.
    console.error(
      `DRY RUN — nothing was deleted. ${result.eligible_count} root(s) would be eligible, ` +
      `${result.retained_count} retained.`,
    );
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
