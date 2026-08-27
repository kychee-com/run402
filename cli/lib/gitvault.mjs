/**
 * `run402 gitvault` — retired from the CLI; every spelling answers a
 * structured error naming its `repos`/git successor.
 *
 * Every spelling answers a proper stderr JSON error envelope: typed
 * `next_actions`, non-zero exit, EMPTY stdout — never silence, never new
 * behavior. Renamed verbs answer `COMMAND_MOVED` naming their `repos`
 * successor; verbs with no behavioral successor answer `COMMAND_REMOVED`
 * (never a `COMMAND_MOVED` that would lie about equivalence). The freed
 * spellings are never re-pointed at different behavior.
 *
 * `gitvault` itself survives only as protocol/infrastructure language: the
 * SDK keeps `r.gitvault.*` ("gitvault is what the thing IS; repos is what
 * the user HAS"). This module's one surviving export,
 * `printKeystoreLocation`, is a shared print helper `cli/lib/repos.mjs`
 * still composes — moving it there instead would make repos.mjs restate
 * logic this file already owns for zero benefit.
 */
import { fail } from "./sdk-errors.mjs";
import { hasHelp } from "./argparse.mjs";

export const HELP = `run402 gitvault — RETIRED (repo-surface-consolidation)

Usage:
  run402 gitvault <anything> — answers a structured error naming its repos/git successor; see below.

Every "run402 gitvault <verb>" spelling has moved to "run402 repos <verb>",
except "reconcile" and "push", which are REMOVED outright (see below). Each
one answers a structured COMMAND_MOVED/COMMAND_REMOVED error for exactly one
release; after that the spelling is reserved and answers nothing at all.

Moved:
  gitvault init       -> repos create --project <id>   (or repos create <name> for a NEW project)
  gitvault status     -> repos view
  gitvault snapshot   -> repos snapshot
  gitvault policy     -> repos policy
  gitvault compact    -> repos gc
  gitvault prune      -> repos gc
  gitvault verify     -> repos fsck
  gitvault mirror     -> repos mirror
  gitvault recover    -> repos recover

Removed, no successor:
  gitvault push       -> git push (its one-release alias window is over); repos snapshot is the capture lane
  gitvault reconcile  -> repos access (read-only inspection; the workaround it approximated is gone, not renamed)

Run \`run402 repos --help\` for the current surface.
`;

/** Renamed verbs: `gitvault <key>` -> the exact `repos` command that means the same thing now. */
const MOVED = {
  init: { command: "run402 repos create --project <id>", why: "repos create absorbs allocation — pass --project to adopt an existing project, or a name to provision a new one." },
  status: { command: "run402 repos view", why: "repos view is the side-effect-free repo inspection command; it never materializes refs the way status --refs used to." },
  snapshot: { command: "run402 repos snapshot", why: "same verb, new noun." },
  policy: { command: "run402 repos policy", why: "same verb, new noun." },
  compact: { command: "run402 repos gc", why: "gc is git gc's own two halves — checkpoint publication and prune planning — in one verb." },
  prune: { command: "run402 repos gc", why: "gc is git gc's own two halves — checkpoint publication and prune planning — in one verb." },
  verify: { command: "run402 repos fsck", why: "fsck is git fsck's own job: walk the object graph and fail closed on corruption." },
  mirror: { command: "run402 repos mirror", why: "one flag-driven verb replaces the five mirror subcommands (set/remove/status/sync/verify)." },
  recover: { command: "run402 repos recover", why: "same verb, new noun." },
};

/** Verbs with NO behavioral successor — a lying COMMAND_MOVED would be worse than an honest COMMAND_REMOVED. */
const REMOVED = {
  push: {
    message: "`run402 gitvault push` was a deprecation-warning alias for exactly one release, and that release is over.",
    hint: "`push` now means exactly one thing everywhere: `git push`. The capture lane is `run402 repos snapshot`.",
    next_actions: [
      { type: "use_moved_command", command: "git push", why: "Publish your branches and tags the ordinary way." },
      { type: "use_moved_command", command: "run402 repos snapshot", why: "The capture lane: publish the protocol-owned deploy ref outside a deploy." },
    ],
  },
  reconcile: {
    message: "`run402 gitvault reconcile` is removed. It was a workaround — its own help text said so — a newly-wrapped member got the vault's entire history under a single fixed epoch, not real epoch rotation, and a temporary mechanism does not get a permanent verb.",
    hint: "`run402 repos access` reports what the read surface has today (recipients, coverage, this machine's local TOFU pins). `repos access repair` will replace the mutating half once real epoch rotation ships — it does not exist yet either.",
    next_actions: [{ type: "use_moved_command", command: "run402 repos access", why: "Inspect recipients and coverage — there is no equivalent mutating successor yet." }],
  },
};

function movedResponse(sub) {
  const m = MOVED[sub];
  fail({
    code: "COMMAND_MOVED",
    message: `run402 gitvault ${sub} moved to ${m.command}.`,
    hint: m.why,
    details: { was: `gitvault ${sub}`, now: m.command },
    next_actions: [{ type: "use_moved_command", command: m.command, why: m.why }],
  });
}

function removedResponse(sub) {
  const r = REMOVED[sub];
  fail({
    code: "COMMAND_REMOVED",
    message: r.message,
    hint: r.hint,
    details: { was: `gitvault ${sub}` },
    next_actions: r.next_actions,
  });
}

/**
 * Where the keystore lives — for verbs whose payload is not a `view`.
 * Exported: `repos create` and `repos snapshot` print the same line after
 * allocating/publishing, and must not restate this logic.
 */
export async function printKeystoreLocation() {
  try {
    const { getGitvaultKeystoreRoot } = await import("#sdk/node");
    console.error(`keystore: ${getGitvaultKeystoreRoot()} — back this up; whole-keystore loss is terminal for repo history`);
  } catch {
    // Never let a diagnostic line fail a command that already succeeded.
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "init":
      movedResponse("init");
      break;
    case "status":
      movedResponse("status");
      break;
    case "snapshot":
      movedResponse("snapshot");
      break;
    case "policy":
      movedResponse("policy");
      break;
    case "compact":
      movedResponse("compact");
      break;
    case "prune":
      movedResponse("prune");
      break;
    case "verify":
      movedResponse("verify");
      break;
    case "mirror":
      movedResponse("mirror");
      break;
    case "recover":
      movedResponse("recover");
      break;
    case "push":
      removedResponse("push");
      break;
    case "reconcile":
      removedResponse("reconcile");
      break;
    default:
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `run402 gitvault ${sub}: unknown, and gitvault itself is retired.`,
        hint: "Run `run402 repos --help` for the current surface.",
      });
  }
}
