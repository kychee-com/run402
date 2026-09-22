/**
 * The `run402 repos` naming-law conventions gate (repo-surface-consolidation
 * task 5.1): mechanically, from `COMMAND_MANIFEST`, no `repos` verb may
 * reuse a git verb name with different semantics (design D2 rule 4) — every
 * verb that collides with a real git command name must have a recorded,
 * reviewed meaning that matches git's own; every verb must otherwise
 * classify as a `gh repo` verb or a plain-English verb with no analog
 * (D2 rules 1/3).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_MANIFEST } from "./cli/lib/command-manifest.mjs";

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
    // `git bundle` packs repo OBJECTS into an offline file — added here when
    // the recovery-bundle verb was named, precisely so a future bare
    // `repos bundle` (key material, a different meaning) trips rule 4.
    "bundle",
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
  //
  // `recovery-bundle` (vault-recovery-custody, 2026-08-29): exports the
  // member recovery bundle `recover --bundle` consumes. The reviewed naming
  // deliberation, recorded: bare `bundle` was REJECTED — `git bundle` is a
  // real git verb packing repo OBJECTS for offline transfer, and ours would
  // carry KEY MATERIAL under the same word (the exact rule-4 collision that
  // rejected `restore`); `export` was REJECTED as misleading — every prior
  // (git fast-export, the portable-archive family) teaches "export = get my
  // repo/project contents out", and getting a key bundle instead is a
  // trust-surprise. The hyphenated compound has no git/gh analog and names
  // exactly what it produces, next to the verb that consumes it.
  // `handoff`/`resume` (kygit-handoff): a session PASS between agents — a
  // captured working tree plus a single-use bearer key, and the verb that
  // claims one. Neither collides with a `gh repo` verb or a real git verb
  // name (`git stash` inspires the restore MECHANISM `resume` uses
  // internally — `git stash apply --index` — but `resume` itself names no
  // git porcelain command), so both are plain-English no-analog verbs.
  // `invite`/`join` (kygit-invite): the SECOND claim kind, sharing the same
  // capture/restore machinery as handoff/resume by kind — a coordination
  // room invite plus the verb that claims one. Same reasoning: neither
  // collides with a `gh repo` verb or a real git porcelain command name.
  const NO_ANALOG_VERBS = new Set(["capture", "policy", "mirror", "access", "recover", "recovery-bundle", "handoff", "resume", "invite", "join"]);

  it("the repos verb set is exactly the seventeen the design specifies (create/list/view/rename/delete/capture/policy/mirror/fsck/gc/access/recover/recovery-bundle/handoff/resume/invite/join)", () => {
    assert.deepEqual(
      REPOS_VERBS,
      ["access", "capture", "create", "delete", "fsck", "gc", "handoff", "invite", "join", "list", "mirror", "policy", "recover", "recovery-bundle", "rename", "resume", "view"],
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
    assert.equal(REPOS_VERBS.includes("status"), false, "`vault status` retired precisely because `git status` means working-tree state, not vault state — `repos view` replaced it; reintroducing `status` repeats the exact mistake this change fixes");
    assert.equal(REPOS_VERBS.includes("restore"), false, "the external review rejected `restore` for the recovery verb because `git restore` already means something else (D2 rule 4) — `repos recover` is the kept name (design D10)");
  });

  it("`repos` never defines bare `bundle` or `export` — the two collisions the recovery-bundle naming rejected", () => {
    assert.equal(REPOS_VERBS.includes("bundle"), false, "`git bundle` packs repo OBJECTS for offline transfer; a repos verb of the same name carrying KEY MATERIAL would be exactly the rule-4 reuse the law forbids — `repos recovery-bundle` is the kept name");
    assert.equal(REPOS_VERBS.includes("export"), false, "every prior (git fast-export, the portable-archive family) teaches export = get my repo/project contents out; a key-bundle answer under that word is a trust-surprise");
    assert.equal(GIT_VERBS.has("bundle"), true, "git bundle is real — this is exactly why repos never names a verb `bundle`");
  });

  it("`recover` collides with no git or gh verb — `restore` was rejected precisely because IT would have (design D10)", () => {
    assert.equal(GIT_VERBS.has("recover"), false);
    assert.equal(GH_REPO_VERBS.has("recover"), false);
    assert.equal(GIT_VERBS.has("restore"), true, "git restore is real — this is exactly why repos never names a verb `restore`");
  });
});
