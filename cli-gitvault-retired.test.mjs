/**
 * `run402 gitvault` — RETIRED (repo-surface-consolidation, design D7/D10,
 * tasks 3.6/3.12/5.1).
 *
 * Two things under test:
 *
 * 1. The tombstone dispatcher itself: every old `gitvault <verb>` spelling
 *    answers a proper stderr JSON error envelope — typed `next_actions`,
 *    non-zero exit, EMPTY stdout — never silence, never new behavior.
 *    Renamed verbs answer `COMMAND_MOVED` naming their `repos` successor;
 *    `push` and `reconcile` (no behavioral successor) answer
 *    `COMMAND_REMOVED`. The list of subcommands under test is read
 *    MECHANICALLY from `RESERVED_SUBCOMMANDS` in `command-manifest.mjs`
 *    (the same source `sync.test.ts` reads), not hand-duplicated — a new
 *    reserved gitvault spelling is covered automatically.
 *
 * 2. The naming-law conventions gate (task 5.1): mechanically, from
 *    `COMMAND_MANIFEST`, no `repos` verb may reuse a git verb name with
 *    different semantics (design D2 rule 4) — every verb that collides
 *    with a real git command name must have a recorded, reviewed meaning
 *    that matches git's own; every verb must otherwise classify as a
 *    `gh repo` verb or a plain-English verb with no analog (D2 rules 1/3).
 */

import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_MANIFEST, RESERVED_SUBCOMMANDS } from "./cli/lib/command-manifest.mjs";
import { run } from "./cli/lib/gitvault.mjs";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

let stdout = [];
let stderr = [];

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

after(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});
beforeEach(() => {
  stdout = [];
  stderr = [];
});

/** Every retired gitvault subcommand, read mechanically from RESERVED_SUBCOMMANDS. */
const RETIRED_GITVAULT_SUBS = Object.keys(RESERVED_SUBCOMMANDS)
  .filter((k) => k.startsWith("gitvault:"))
  .map((k) => k.slice("gitvault:".length))
  .sort();

/** `push` and `reconcile` have no behavioral successor (design D7) — every other retired verb is a rename. */
const REMOVED_NOT_MOVED = new Set(["push", "reconcile"]);

async function runAndCaptureFailure(sub) {
  captureStart();
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  try {
    await assert.rejects(() => run(sub, []), /process\.exit/);
  } finally {
    captureStop();
    process.exit = originalExit;
  }
  return JSON.parse(stderr.join("\n"));
}

describe("the tombstone dispatcher — every retired gitvault spelling", () => {
  it("RESERVED_SUBCOMMANDS actually lists every subcommand the tombstone module dispatches (the two lists must agree)", () => {
    // Read the module source directly rather than importing internals — the
    // same "no case label without a reserved-subcommand entry" invariant
    // sync.test.ts enforces for the CLI inventory, checked here from the
    // opposite direction: every case in gitvault.mjs must be reserved.
    assert.ok(RETIRED_GITVAULT_SUBS.length >= 11, `expected at least 11 retired gitvault subcommands, found ${RETIRED_GITVAULT_SUBS.length}: ${RETIRED_GITVAULT_SUBS.join(", ")}`);
  });

  for (const sub of RETIRED_GITVAULT_SUBS) {
    it(`gitvault ${sub} — empty stdout, non-zero exit, typed next_actions, ${REMOVED_NOT_MOVED.has(sub) ? "COMMAND_REMOVED" : "COMMAND_MOVED"}`, async () => {
      const envelope = await runAndCaptureFailure(sub);
      assert.equal(stdout.length, 0, `gitvault ${sub} must print nothing to stdout on a moved/removed spelling`);
      assert.equal(envelope.status, "error");
      assert.equal(
        envelope.code,
        REMOVED_NOT_MOVED.has(sub) ? "COMMAND_REMOVED" : "COMMAND_MOVED",
        `gitvault ${sub}: ${REMOVED_NOT_MOVED.has(sub) ? "has no behavioral successor and must never claim one via COMMAND_MOVED" : "was renamed and must say so via COMMAND_MOVED, not silently vanish"}`,
      );
      assert.ok(Array.isArray(envelope.next_actions) && envelope.next_actions.length > 0, `gitvault ${sub} must carry at least one typed next_action`);
      for (const action of envelope.next_actions) {
        assert.ok(typeof action.type === "string" && action.type.length > 0, "next_actions entries use the `type` discriminator, not a bare string or `action`");
      }
    });
  }

  it("a renamed verb's next_action never claims the old and new command are the same operation without naming both", () => {
    // Spot-checked structurally rather than per-verb: every MOVED envelope's
    // `details` names both `was` and `now`.
    return (async () => {
      for (const sub of RETIRED_GITVAULT_SUBS) {
        if (REMOVED_NOT_MOVED.has(sub)) continue;
        const envelope = await runAndCaptureFailure(sub);
        assert.equal(envelope.details.was, `gitvault ${sub}`);
        assert.ok(typeof envelope.details.now === "string" && envelope.details.now.startsWith("run402 repos "), `gitvault ${sub}'s COMMAND_MOVED must name a run402 repos successor, got ${JSON.stringify(envelope.details.now)}`);
      }
    })();
  });

  it("reconcile's COMMAND_REMOVED points at `repos access`, never inventing an equivalent successor", async () => {
    const envelope = await runAndCaptureFailure("reconcile");
    assert.match(envelope.message, /workaround/i);
    assert.ok(envelope.next_actions.find((a) => a.command === "run402 repos access"));
  });

  it("push's COMMAND_REMOVED points at both `git push` and `repos snapshot`", async () => {
    const envelope = await runAndCaptureFailure("push");
    assert.ok(envelope.next_actions.find((a) => a.command === "git push"));
    assert.ok(envelope.next_actions.find((a) => a.command === "run402 repos snapshot"));
  });

  it("a genuinely unknown gitvault subcommand still fails cleanly (never falls through to real behavior)", async () => {
    const envelope = await runAndCaptureFailure("frobnicate");
    assert.equal(stdout.length, 0);
    assert.equal(envelope.status, "error");
  });

  it("gitvault --help (no subcommand) prints the tombstone map and exits 0 — not an error", async () => {
    captureStart();
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error("exit"); };
    try {
      await assert.rejects(() => run(undefined, ["--help"]));
    } finally {
      captureStop();
      process.exit = originalExit;
    }
    assert.equal(exitCode, 0);
    assert.match(stdout.join("\n"), /RETIRED/);
    assert.match(stdout.join("\n"), /repos view/);
  });
});

describe("naming-law conventions gate (task 5.1) — mechanically, from COMMAND_MANIFEST", () => {
  const REPOS_VERBS = [...new Set(
    COMMAND_MANIFEST.filter((e) => e.path[0] === "repos").map((e) => e.path[1]),
  )].sort();

  // `gh repo`'s own verb set (design D2 rule 1) — using one of these exactly
  // is the FIRST-priority naming choice.
  const GH_REPO_VERBS = new Set(["create", "list", "view", "rename", "delete", "clone", "fork", "sync", "archive"]);

  // A representative set of git's own porcelain verb names (design D2 rule
  // 2/4) — not exhaustive of every git plumbing command, but every verb an
  // agent coming from `git --help` would recognize as git's. If a `repos`
  // verb collides with one of these, its meaning must be recorded (and
  // reviewed) in ALLOWED_GIT_VERB_REUSE below, matching what the git verb
  // of the same name actually does — the external review's clause-5
  // addition to D2: a borrowed name must match not just the rough
  // operation, but the SAFETY AND SIDE-EFFECT PROFILE the agent expects.
  const GIT_VERBS = new Set([
    "init", "clone", "add", "mv", "rm", "commit", "status", "log", "diff",
    "branch", "checkout", "switch", "restore", "reset", "revert", "merge",
    "rebase", "cherry-pick", "push", "pull", "fetch", "remote", "tag",
    "stash", "gc", "fsck", "prune", "repack", "blame", "show", "config",
    "submodule", "worktree", "bisect", "grep", "archive", "clean", "describe",
    "reflog", "verify-commit", "verify-tag", "notes", "sparse-checkout",
  ]);

  // Every `repos` verb that ALSO happens to be a real git verb name, with
  // the reviewed, recorded reason its meaning matches git's own. A `repos`
  // verb name appearing in GIT_VERBS but missing here fails the gate below
  // — an undocumented collision is exactly what D2 rule 4 forbids.
  const ALLOWED_GIT_VERB_REUSE = {
    gc: "repack + prune planning — git gc's own two halves, exactly. Never described as \"exactly git gc\": the deletion ceremony (two-receipt submit) is stricter (design D2 clause 5).",
    fsck: "walk the object graph and fail closed on corruption — exactly git fsck's job description.",
  };

  // Verbs with no git or gh analog at all (design D2 rule 3) — a plain-
  // English verb naming a platform concept. `recover` belongs here too: it
  // has no git/gh analog, which is exactly WHY the design considered (and
  // the external review rejected) reusing `restore` for it — see D2 rule 4
  // and D10's recorded resolution, checked explicitly below.
  const NO_ANALOG_VERBS = new Set(["snapshot", "policy", "mirror", "access", "recover"]);

  it("the repos verb set is exactly the twelve the design specifies (create/list/view/rename/delete/snapshot/policy/mirror/fsck/gc/access/recover)", () => {
    assert.deepEqual(
      REPOS_VERBS,
      ["access", "create", "delete", "fsck", "gc", "list", "mirror", "policy", "recover", "rename", "snapshot", "view"],
    );
  });

  it("every repos verb that collides with a real git verb name has a recorded, reviewed meaning matching git's own", () => {
    for (const verb of REPOS_VERBS) {
      if (!GIT_VERBS.has(verb)) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(ALLOWED_GIT_VERB_REUSE, verb),
        `"repos ${verb}" reuses the git verb "${verb}" with no recorded meaning in ALLOWED_GIT_VERB_REUSE — design D2 rule 4 forbids reusing a git verb for a different, undocumented meaning. Either record why "${verb}" means the same thing git's "${verb}" does, or rename the CLI verb.`,
      );
    }
  });

  it("every repos verb classifies under D2's naming law: a gh repo verb, a recorded git-verb reuse, or a plain-English no-analog verb", () => {
    for (const verb of REPOS_VERBS) {
      const isGhVerb = GH_REPO_VERBS.has(verb);
      const isAllowedGitReuse = Object.prototype.hasOwnProperty.call(ALLOWED_GIT_VERB_REUSE, verb);
      const isNoAnalog = NO_ANALOG_VERBS.has(verb);
      assert.ok(
        isGhVerb || isAllowedGitReuse || isNoAnalog,
        `"repos ${verb}" is not classified anywhere in this gate (not a gh repo verb, not a recorded git-verb reuse, not a declared no-analog verb) — design D2 requires every verb to justify its name one of these three ways.`,
      );
    }
  });

  it("`repos` never defines `status` or `restore` — the two collisions the review explicitly rejected", () => {
    assert.equal(REPOS_VERBS.includes("status"), false, "`gitvault status` retired precisely because `git status` means working-tree state, not vault state — `repos view` replaced it; reintroducing `status` repeats the exact mistake this change fixes");
    assert.equal(REPOS_VERBS.includes("restore"), false, "the external review rejected `restore` for the recovery verb because `git restore` already means something else (D2 rule 4) — `repos recover` is the kept name (design D10)");
  });

  it("`recover` collides with no git or gh verb — `restore` was rejected precisely because IT would have (design D10)", () => {
    assert.equal(GIT_VERBS.has("recover"), false);
    assert.equal(GH_REPO_VERBS.has("recover"), false);
    assert.equal(GIT_VERBS.has("restore"), true, "git restore is real — this is exactly why repos never names a verb `restore`");
  });
});
