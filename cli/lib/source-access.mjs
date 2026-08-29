/**
 * `run402 source-access` — RETIRED after exactly one release (v4.54.0, live
 * for hours), moved into the `repos` family the same day it shipped.
 *
 * The family violated the one-noun consolidation the CLI just fought for
 * (repo-surface-consolidation: 19 commands → one noun, twelve verbs): it
 * pattern-matched the gateway's `/agent/v1/source-access/*` route namespace
 * into a CLI noun, and the wire is organized by resource while the CLI is
 * organized by user nouns. Both verbs live where a user actually looks:
 *
 *   source-access export  ->  repos recovery-bundle   (the artifact
 *                             `repos recover --bundle` consumes; custody
 *                             machinery of the repos family)
 *   source-access status  ->  repos access            (its "you" block —
 *                             your own wrapper custody, rendered inside the
 *                             family's existing custody roster read)
 *
 * Same contract as the gitvault retirement (`cli/lib/gitvault.mjs`): every
 * spelling answers a structured COMMAND_MOVED for exactly one release —
 * typed next_actions, non-zero exit, EMPTY stdout — then the spelling is
 * reserved and answers nothing at all. Never re-pointed at new behavior.
 */
import { fail } from "./sdk-errors.mjs";
import { hasHelp } from "./argparse.mjs";

export const HELP = `run402 source-access — RETIRED (moved into the repos family)

Usage:
  run402 source-access <anything> — answers a structured error naming its repos successor; see below.

Moved:
  source-access export -> repos recovery-bundle   (export your member recovery bundle)
  source-access status -> repos access            (your own wrapper custody rides its "you" block)

Run \`run402 repos --help\` for the current surface.
`;

const MOVED = {
  export: {
    command: "run402 repos recovery-bundle",
    why: "The bundle's whole life is in the repos family — it is the artifact `repos recover --bundle` consumes and the sidecar a `repos mirror` carries.",
  },
  status: {
    command: "run402 repos access",
    why: "Your own wrapper custody now renders inside the family's existing custody roster read (its member_custody block); the org-level advisory is `run402 doctor --only recovery_posture`.",
  },
};

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  const m = MOVED[sub];
  if (m) {
    fail({
      code: "COMMAND_MOVED",
      message: `run402 source-access ${sub} moved to ${m.command}.`,
      hint: m.why,
      details: { was: `source-access ${sub}`, now: m.command },
      next_actions: [{ type: "use_moved_command", command: m.command, why: m.why }],
    });
  }
  fail({
    code: "UNKNOWN_SUBCOMMAND",
    message: `run402 source-access ${sub}: unknown, and source-access itself is retired.`,
    hint: "Run `run402 repos --help` for the current surface.",
  });
}
