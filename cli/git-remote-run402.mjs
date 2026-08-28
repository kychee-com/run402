#!/usr/bin/env node
/**
 * `git-remote-run402` — the git remote helper for gitvault, so plain
 * `git clone|fetch|push run402::<org_id>/<project_id>` speaks to a host-blind
 * encrypted vault with no run402-specific git ceremony.
 *
 * ARCHITECTURAL LAW (gitvault-client-surface, "All protocol logic lives in the
 * SDK"): this file is a THIN ADAPTER over `r.gitvault`. It translates git's
 * remote-helper wire protocol into SDK calls and back, and does nothing else.
 * No crypto, no HTTP, no ref-policy decisions, no pack building — those live
 * once in `@run402/sdk`. Even git itself is invoked only through the SDK's own
 * `hardenedGit` (hooks, fsmonitor, replace-refs and filter autodetection are
 * neutralized there), so this helper hand-rolls no git behaviour either.
 *
 * PROTOCOL SURFACE (gitremote-helpers(1)). Implemented:
 *   capabilities            → advertises fetch, push, option
 *   list [for-push]         → the vault's canonical ref map + the HEAD target
 *   fetch <sha1> <name>     → restore the vault's object database into this repo
 *   push [+]<src>:<dst>     → publish one atomic ref transaction
 *   option <name> <value>   → ok / unsupported, never a silent lie
 *
 * LAZY ALLOCATION ON FIRST PUSH (design D2). `list` never creates anything —
 * an unallocated vault reports as an empty ref set, exactly what a fresh
 * repository looks like — but `push` does: `git push origin main` against a
 * project whose vault does not exist yet runs the six-stage creation journal
 * inline (`r.gitvault.openOrCreate`, the SDK-owned primitive), prints the
 * one-shot recovery receipt and the keystore path to stderr, and then
 * completes the push. One command, no prior `gitvault init`. `git ls-remote`
 * / `fetch` stay pure reads and allocate nothing.
 *
 * NAMED ADDRESSING + PUSH-TO-CREATE (repo-first-onramp task 4, design D6).
 * `run402::<org>/<name>` admits TWO forms in the same slot — id-form
 * (`org_id`/`prj_...`, unchanged: resolved via `r.gitvault.openOrCreate`
 * above) and slug-form (`run402::<org-slug>/<name>`, e.g.
 * `run402::acme/my-notes`) — discriminated by
 * `gitvaultRemoteAddressForm`. A slug-form remote resolves through
 * `r.gitvault.resolveOrCreateAddress`, which ALSO drives push-to-create on a
 * miss (`push` only; `list`/`fetch` pass `allow_create: false`, same "reads
 * never allocate" discipline as the id-form path) and PINS the resolved
 * `repo_id` in this checkout's local git config the first time it resolves
 * (task 4.5) — every later invocation on THIS checkout goes straight to the
 * pinned id, skipping the address resolution round-trip entirely and
 * surviving a later rename of either half. `SLUG_RELEASED` is never
 * auto-followed: it refuses, naming the successor slug.
 *
 * WHICH REPOSITORY (the fail-closed rule). `process.cwd()` is NOT the
 * repository. git identifies the repository with `GIT_DIR`, and during
 * `git clone` cwd is the directory clone was RUN FROM — routinely some other,
 * unrelated repository. Discovering the repository from cwd therefore wrote a
 * vault's DECRYPTED objects into a repository the user never named, silently,
 * on every clone (dogfood #1). Every repository-touching command now resolves
 * through the SDK's `resolveGitInvocationRepo`, which proves `GIT_DIR` names a
 * real repository and refuses otherwise; a refusal writes nothing at all.
 * `capabilities`, `option` and `list` need no repository and are unaffected,
 * so a repository-free `git ls-remote run402::<org>/<project>` still works.
 *
 * NOT advertised, deliberately: `list` is a COMMAND in this protocol, not a
 * capability keyword — git's capability vocabulary is fetch/push/import/export/
 * connect/stateless-connect/option/refspec/check-connectivity/object-format/
 * signed-tags/bidi-import/get. Advertising `list` would be a line git silently
 * discards; the command itself is implemented above. `connect`,
 * `stateless-connect`, `import`, and `export` are NOT implemented: the vault is
 * not a git-protocol endpoint you can tunnel to, and pretending otherwise would
 * hand git a transport that cannot answer.
 *
 * KNOWN LIMITS, stated rather than papered over:
 *   - `fetch` restores the vault's object database WHOLESALE. The SDK exposes
 *     no per-ref object selection, so one batch = one full restore. That is a
 *     superset of what git asked for (git writes the refs itself from `list`),
 *     never a subset — but it is not incremental.
 *   - `push` REPAIRS a DANGLING vault HEAD and otherwise never moves it
 *     (kychee-com/run402#568). A fresh vault defaults its HEAD symref to
 *     `refs/heads/main`; before this fix, a first push of any OTHER branch
 *     left that symref naming a ref that would never exist, and the first
 *     `git clone` warned "remote HEAD refers to nonexistent ref" and checked
 *     out an EMPTY tree — publishing landed, but nothing was reachable from
 *     it. Now: when the vault's current HEAD target is unset, or is a
 *     symref naming a ref this push's own batch does not leave present, the
 *     helper points it at one of the branches THIS push is publishing — the
 *     local repository's own HEAD branch when it is among them, else the
 *     first branch in the batch — and prints a one-line stderr note saying
 *     which and why (see `chooseGitvaultHeadTargetForPush`). A HEALTHY HEAD
 *     (one that already names a ref this push leaves present) is NEVER
 *     touched — push moving history never means push moving HEAD.
 *   - `option dry-run true` (kychee-com/run402#565) runs the REAL local
 *     pipeline — pack building, encryption sizing, via `vault.planPush` — and
 *     reports the per-ref `ok` lines a real push would, plus a stderr summary
 *     (objects, encrypted bytes, refs, the generation it would admit as,
 *     whether allocation would be needed). It never uploads or admits, and a
 *     push-to-create dry run never allocates. Still honestly refuses
 *     anything git's own dry-run negotiation would also refuse (e.g. a
 *     non-fast-forward update) — reporting a fake `ok` would be worse than
 *     refusing, which is why this was `unsupported` until it could be real.
 *   - `fetch` and `push` REQUIRE the `GIT_DIR` git sets when it drives a
 *     helper against a repository, so running this binary by hand from a shell
 *     is refused rather than silently pointed at the current directory. Only
 *     `capabilities`, `option` and `list` work without one, which is exactly
 *     the set `git ls-remote <url>` outside a checkout needs.
 */

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { getSdk } from "./lib/sdk.mjs";
import { resolveWalletCore, enforceWalletExistsCore, WalletSelectionError } from "./lib/wallet-context.mjs";
import { gitvaultRemoteAddressForm, gitvaultSlugReleasedInfo, parseGitvaultRemoteUrl } from "#sdk";
import { GITVAULT_R402_REF_NAMESPACE, hardenedGit, resolveGitInvocationRepo, readPinnedGitvaultRepo, pinGitvaultRepo } from "#sdk/node";

const out = (line) => process.stdout.write(`${line}\n`);
/** Every helper response block is terminated by a blank line. */
const endBlock = () => process.stdout.write("\n");
const note = (line) => process.stderr.write(`git-remote-run402: ${line}\n`);

/**
 * Wallet selection (kychee-com/run402#558). Before this, this file called
 * `getSdk()` directly and ran NO wallet selection at all — a `.run402.json`
 * binding, and even the global `wallets use` default, silently never
 * reached it; only the `RUN402_WALLET` env layer worked, so a bound
 * checkout's very next `git push run402 main` after a correctly-bound
 * `run402 repos create` used the WRONG wallet's (usually empty) allowance.
 *
 * Shares `resolveWalletCore`/`enforceWalletExistsCore` with the CLI
 * (`cli/lib/wallet-context.mjs`) — ONE implementation, minus the CLI's
 * `--wallet` flag layer (this binary parses no argv flags at all). Resolved
 * and applied (`process.env.RUN402_WALLET`) once per invocation, right
 * before the first credential-touching call — never for `capabilities` /
 * `option`, which touch neither credentials nor the network.
 *
 * WHICH DIRECTORY the binding walk starts from is NOT uniform, for the same
 * fail-closed reason this file's own header explains for repository
 * resolution: `list` needs no repository (a repository-free `git ls-remote`
 * outside any checkout must keep working), so it walks from `process.cwd()`.
 * `fetch`/`push` DO have a resolved repository by the time wallet selection
 * runs (`requireRepo()` already succeeded) — walking from ITS directory
 * rather than cwd is what makes `git clone` (cwd = wherever clone was RUN
 * FROM, not the target repo) pick up a binding committed in the target
 * repository, not whatever checkout happened to be current.
 */
let resolvedWallet = null;

function applyWalletForDir(dir) {
  const resolved = resolveWalletCore({ env: process.env, cwd: dir });
  enforceWalletExistsCore(resolved);
  process.env.RUN402_WALLET = resolved.name;
  resolvedWallet = resolved;
  return resolved;
}

/** The resolved wallet's selection source, in the same words the CLI's own `--wallet` provenance line uses. `null` for the bare, unselected default. */
function walletSourceLabel(resolved) {
  if (!resolved) return null;
  if (resolved.source === "env") return "RUN402_WALLET";
  if (resolved.source === "binding") return resolved.sourceDetail; // the .run402.json path
  if (resolved.source === "config") return "wallets use";
  return null; // "default" — nothing selected anything
}

/**
 * The allowance-missing/malformed family (`core/src/allowance.ts`'s own
 * throws) all end with "Back up the file and run 'run402 init' to recreate
 * it." — a remedy that assumes the resolved wallet is the one you meant.
 * That is only true when NOTHING selected a wallet (the bare default); when
 * an env var or a binding DID name one, the remedy is actively harmful —
 * `run402 init` recreates the DEFAULT wallet's allowance, a DIFFERENT
 * wallet than the one that was actually resolved and whose allowance is
 * actually missing/broken (kychee-com/run402#558's second defect). Replace
 * it with the resolved wallet's name and how selection works, so the fix is
 * "correct the selection" rather than "recreate the wrong wallet".
 */
function enrichAllowanceError(message) {
  if (!resolvedWallet || !/allowance\.json/.test(message)) return message;
  const source = walletSourceLabel(resolvedWallet);
  const stripped = message.replace(/\s*Back up the file and run 'run402 init' to recreate it\.?/, "").trim();
  if (!source) {
    // Genuinely the bare default wallet with no override anywhere — the
    // original remedy already names the right target.
    return `${stripped} Back up the file and run 'run402 init' to recreate it.`;
  }
  return (
    `${stripped} Resolved wallet '${resolvedWallet.name}' via ${source} ` +
    "(order: RUN402_WALLET env > .run402.json binding > 'wallets use' default > default). " +
    `Wrong wallet? Fix selection instead. Right wallet, just no allowance yet? 'run402 wallets new ${resolvedWallet.name}'.`
  );
}

function describeError(err) {
  const code = err?.code ?? err?.body?.code ?? null;
  const message = enrichAllowanceError(err?.message ?? err?.body?.message ?? String(err));
  // SLUG_RELEASED is never auto-followed — but the successor slug (design D6)
  // is exactly the fact a human/agent reading stderr needs to act on it.
  const released = gitvaultSlugReleasedInfo(err);
  const suffix = released?.successor_slug ? ` (renamed to "${released.successor_slug}" — update the remote and re-run)` : "";
  return oneLine(code ? `${code}: ${message}${suffix}` : message);
}

/** Protocol lines are single-line: collapse anything that could break framing. */
function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * Resolve the vault address from git's argv.
 *
 * Git invokes `git-remote-<transport> <remote> <url>`, and for a
 * `<transport>::<address>` URL it passes the BARE `<address>` as the second
 * argument — the `run402::` prefix is already stripped. The SDK's parser is the
 * only thing that understands the address grammar, so both spellings are handed
 * to it rather than re-implemented here.
 */
function resolveRemoteAddress(argv) {
  for (const raw of [argv[1], argv[0]]) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const direct = parseGitvaultRemoteUrl(raw);
    if (direct) return direct;
    // Re-add the prefix ONLY for a bare, colon-free address. Without this
    // guard `https://example.com/x` parses as org `https:` / project
    // `/example.com/x`, and `git@github.com:x/y.git` as org `git@github.com:x`
    // — a confidently wrong answer is worse than no answer here. The colon is
    // git's own URL punctuation, never part of a bare `<org_id>/<project_id>`.
    if (raw.includes(":")) continue;
    const prefixed = parseGitvaultRemoteUrl(`run402::${raw}`);
    if (prefixed) return prefixed;
  }
  return null;
}

/** `[+]<src>:<dst>` — an empty `<src>` is a deletion. */
function parsePushSpec(spec) {
  const forced = spec.startsWith("+");
  const body = forced ? spec.slice(1) : spec;
  const colon = body.indexOf(":");
  if (colon === -1) return { src: body, dst: body, force: forced };
  return { src: body.slice(0, colon), dst: body.slice(colon + 1), force: forced };
}

/** `R402_PROTECTED_REF_NAMESPACE`'s one-line reason, shared by the protocol `error` line and the stderr note. */
export const R402_PROTECTED_REF_NAMESPACE_REASON = `R402_PROTECTED_REF_NAMESPACE: ${GITVAULT_R402_REF_NAMESPACE}* is client-local bookkeeping maintained by fetch, not push — push branches instead.`;

/**
 * D4: `refs/r402/*` is client-local (design D1/D2's local ref bookkeeping) —
 * never advertised for push, never part of a `GitvaultRefTransaction`. Split
 * one push batch into the specs this helper will actually publish and the
 * ones it refuses, PURE and pre-repository (a refname prefix check needs no
 * repo, no network, no wallet), so a batch made ENTIRELY of protected refs
 * costs nothing beyond parsing, and a MIXED batch still lets its unrelated
 * branch updates proceed (client-surface spec's own scenario) — this is why
 * the split happens here, before `vault.push`'s one all-or-nothing
 * transaction is ever built, rather than inside the SDK's existing (whole-
 * transaction-refusing) `refs/run402/*` guard.
 */
export function partitionProtectedRefPushes(specs) {
  const refused = [];
  const allowed = [];
  for (const spec of specs) {
    if (spec.dst.startsWith(GITVAULT_R402_REF_NAMESPACE)) refused.push(spec);
    else allowed.push(spec);
  }
  return { refused, allowed };
}

/**
 * Decide whether THIS push must repair a DANGLING vault HEAD, and to what
 * (kychee-com/run402#568 — the first-clone empty-tree hazard). The rule:
 *
 *   WHEN the vault's current materialized HEAD target is absent, OR is a
 *   symref naming a ref this push's own batch does not leave present, set
 *   `head_target` to one of the branches THIS push is publishing — this
 *   repository's own HEAD branch when it is among them, else the first
 *   branch in the batch (git's own order) — and say which, and why, in a
 *   one-line note. No silent magic.
 *
 *   WHEN HEAD is already set and healthy (a symref naming a ref this push
 *   leaves present, or a detached target), it is NEVER touched — push
 *   moving history never means push moving HEAD. That stays the documented
 *   rule (`vault.push`'s own `head_target ?? base.head_target` carry-forward
 *   already guarantees this at the SDK layer; this function just decides
 *   WHEN to override that default).
 *
 * Pure — no I/O, no git, no network — so it is unit-testable directly.
 * `updates` is this push's own ref-transaction updates (`{ ref, new_oid }`,
 * `new_oid: null` for a deletion); `baseRefs`/`baseHeadTarget` are what the
 * vault materialized BEFORE this push; `localHeadRef` is this repository's
 * own HEAD branch (`refs/heads/<name>`), or `null` when detached/unknown.
 *
 * Returns `{ head_target: undefined }` (never publish an override — the SDK
 * carries the base forward) when HEAD needs no repair, or when this batch
 * has no branch update to repair it WITH (a tags-only or deletion-only
 * batch cannot fix a dangling HEAD by itself).
 */
export function chooseGitvaultHeadTargetForPush({ baseHeadTarget, baseRefs, updates, localHeadRef }) {
  const postPushRefs = { ...(baseRefs ?? {}) };
  for (const u of updates) {
    if (u.new_oid === null) delete postPushRefs[u.ref];
    else postPushRefs[u.ref] = u.new_oid;
  }

  const dangling =
    !baseHeadTarget ||
    (baseHeadTarget.kind === "symref" && !Object.prototype.hasOwnProperty.call(postPushRefs, baseHeadTarget.ref));
  if (!dangling) return { head_target: undefined, note: null };

  const pushedBranches = updates.filter((u) => u.new_oid !== null && u.ref.startsWith("refs/heads/")).map((u) => u.ref);
  if (pushedBranches.length === 0) return { head_target: undefined, note: null };

  const localIsPushed = Boolean(localHeadRef) && pushedBranches.includes(localHeadRef);
  const chosen = localIsPushed ? localHeadRef : pushedBranches[0];
  const why = localIsPushed
    ? "this repository's own HEAD branch"
    : pushedBranches.length > 1
      ? `the first of ${pushedBranches.length} branches pushed in this batch`
      : "the branch this push publishes";
  const priorState = baseHeadTarget ? `dangling (named '${baseHeadTarget.ref}', which this push does not publish)` : "unset";
  const note = `vault HEAD was ${priorState} — setting it to '${chosen}' (${why}). A healthy HEAD is never moved by push.`;
  return { head_target: { kind: "symref", ref: chosen }, note };
}

async function main(argv) {
  const address = resolveRemoteAddress(argv);
  if (!address) {
    note(`could not read a run402 remote address from ${JSON.stringify(argv.join(" "))} — expected run402::<org_id>/<project_id>`);
    return 1;
  }

  // `org_id` rides in the parsed address (`run402::<org_id>/<project_id>`),
  // so it costs nothing extra to carry — it is exactly what D2's lazy
  // creation needs to allocate an unresolved vault from `runPush` below, with
  // no separate lookup. Only meaningful for an ID-FORM address; a slug-form
  // one resolves through `resolveOrCreateAddress` instead (below), which
  // needs no separate org_id at all — the gateway resolves the slug itself.
  const addressForm = gitvaultRemoteAddressForm(address);
  const target = { project_id: address.project_id, org_id: address.org_id };
  let verbosity = 1;
  // kychee-com/run402#565: `option dry-run true` used to be honestly
  // `unsupported` (this helper could not rehearse a publication, and
  // reporting a fake success would be worse than refusing). It now IS
  // real — see `handleOption`'s `dry-run` case and `runPush` below.
  let dryRun = false;

  /**
   * The repository git invoked us for, resolved once and PROVEN.
   *
   * Deliberately lazy: `list` needs no repository, so `git ls-remote` outside
   * any checkout keeps working. Deliberately not cached across a failure
   * either — a refusal is terminal for the command that asked, and there is
   * nothing to retry.
   */
  let resolvedRepo = null;
  async function requireRepo() {
    if (!resolvedRepo) resolvedRepo = await resolveGitInvocationRepo(process.env, process.cwd());
    return resolvedRepo.repo_dir;
  }

  /**
   * One materialize per push session (gitvault-client-round-trips design
   * D1). Git guarantees `list` precedes `push` in the same helper process,
   * so a `list` that resolves an EXISTING vault against a real repository
   * stashes its vault instance + materialized base here; `runPush` reuses
   * BOTH — skipping its own `openOrCreateVault` + `materialize()` entirely
   * — instead of materializing the same state a second and third time.
   * `null` whenever there is nothing safe to share: `list` never ran, ran
   * repo-free (a bare `git ls-remote`), or found an UNALLOCATED vault
   * (first-push-allocates keeps its own unchanged flow — design D7's own
   * "base-sharing subtlety" risk note). Reuse also requires the SAME
   * resolved repository AND the same resolved wallet as `push` is about to
   * use — in ordinary usage (`push` run from inside the repo it targets)
   * these always match `list`'s own resolution; the check just makes a
   * mismatch (an unusual `git -C otherdir push`) fail safe into `push`'s
   * original, unshared flow rather than reuse a snapshot read under a
   * different identity.
   */
  let sharedListSession = null;

  /** This repository's own HEAD branch (`refs/heads/<name>`), or `null` when detached, unborn, or unreadable — never a failure by itself. */
  async function localHeadBranchRef(repoDir) {
    try {
      const out = (await hardenedGit(repoDir, ["symbolic-ref", "--quiet", "HEAD"])).text().trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * What to tell a human when we refuse. `git clone` is the case that used to
   * fail; naming the working alternative beats a bare error.
   */
  function repoRefusalNote(err) {
    note(describeError(err));
    note("refusing to touch a repository git did not name — nothing was read or written.");
    note(`if you meant to restore this vault: git init --bare <dir> && git -C <dir> remote add run402 run402::${address.org_id}/${address.project_id} && git -C <dir> fetch run402 '+refs/heads/*:refs/heads/*'`);
  }

  /** A 404/absent-vault refusal — the "nothing here yet" shape, never a genuine failure to mask. */
  function isVaultNotFound(err) {
    return err?.status === 404 || err?.code === "RESOURCE_NOT_FOUND" || err?.code === "ROUTE_NOT_FOUND";
  }

  /**
   * Open the vault lazily — `capabilities` and `option` must never touch the
   * network. Both address forms resolve (and, on the first successful
   * resolution, PIN `repo_id` in local git state — task 4.5 for slug-form,
   * gitvault-client-round-trips design D4 widening the same mechanism to
   * id-form) through `gitvault.resolveOrCreateAddress` with
   * `allow_create: false` — a read never allocates, and `allow_create` is
   * meaningless for id-form's own dispatch anyway (it never creates,
   * pinned or not). A repo-free call (`repoDir` undefined — `list` outside
   * any checkout) resolves exactly as it always has, just with nothing to
   * pin.
   */
  const openVault = async (repoDir) => {
    const result = await getSdk().gitvault.resolveOrCreateAddress({ address, allow_create: false, ...(repoDir ? { repo_dir: repoDir } : {}) });
    return result.handle.vault;
  };

  /**
   * Open the vault, allocating it first when it does not exist yet (D2), and
   * — for a SLUG-form address whose name does not resolve yet —
   * PUSH-TO-CREATE it (design D6, task 4.4/4.5). Used ONLY by `runPush` —
   * `list`/`fetch` stay pure reads and never create anything (see
   * `runList`'s own not-found handling below).
   *
   * Id-form (gitvault-client-round-trips design D4): a PINNED repo_id means
   * this checkout has already resolved (or pushed to) this vault before, so
   * there is nothing left to allocate — the read-only, pin-aware
   * `resolveOrCreateAddress` path (same one `openVault` uses) is enough,
   * and cheaper than re-running the allocation-capable flow on every push.
   * With NO pin yet, this is unchanged: `gitvault.openOrCreate` runs its
   * six-stage creation journal when the vault does not exist, exactly as
   * before — and, on success, PINS the resolved id for every later push on
   * this checkout (this is the "first successful resolution" the pin exists
   * for; `resolveOrCreateAddress`'s own pin-on-resolve only covers
   * slug-form, since id-form's OWN allocation path — this one — never
   * routes through it).
   *
   * Prints the one-shot recovery receipt and the keystore path to stderr the
   * moment allocation happens, per the client-surface spec: an agent reads
   * stderr, and the receipt is worth exactly as many copies as get kept.
   */
  async function openOrCreateVault(repoDir) {
    if (addressForm === "id" && repoDir) {
      const pinned = await readPinnedGitvaultRepo(repoDir);
      if (pinned) {
        const result = await getSdk().gitvault.resolveOrCreateAddress({ address, repo_dir: repoDir, allow_create: false });
        return result.handle.vault;
      }
    }
    const result =
      addressForm === "id"
        ? await getSdk().gitvault.openOrCreate({ ...target, repo_dir: repoDir })
        : await getSdk().gitvault.resolveOrCreateAddress({ address, repo_dir: repoDir, allow_create: true });
    if (addressForm === "id" && repoDir) await pinGitvaultRepo(repoDir, result.handle.repo_id);
    if (!result.found && result.created) {
      note("");
      note(`vault ${result.handle.repo_id} allocated (genesis ${result.created.genesis_sha256}) — one-shot recovery receipt, keep many copies:`);
      note(JSON.stringify(result.created.recovery_receipt));
      try {
        const { getGitvaultKeystoreRoot } = await import("#sdk/node");
        note(`keystore: ${getGitvaultKeystoreRoot()} — back this up; whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship`);
      } catch {
        // Never let a diagnostic line fail a push that already allocated successfully.
      }
      note("");
    }
    return result.handle.vault;
  }

  async function runList() {
    // `list` needs no repository (a repository-free `git ls-remote` outside
    // any checkout must keep working) — the binding walk falls back to cwd,
    // same as `capabilities`/`option`'s repository-free tier. Wallet
    // resolution is UNCHANGED (still cwd-based, never repoDir-based) — only
    // the vault-open call below additionally threads a repository when one
    // resolves, purely so a later `push` in this same session can reuse the
    // resulting vault instance (design D1); the repo-free ls-remote case is
    // unaffected (`repoDir` just stays `null`).
    applyWalletForDir(process.cwd());
    let repoDir = null;
    try {
      repoDir = await requireRepo();
    } catch {
      // Not resolvable as a repository (e.g. `git ls-remote` outside any
      // checkout) — `list` still works, and there is nothing for `push` to
      // share later in that case.
    }
    let vault;
    let state;
    try {
      vault = await openVault(repoDir ?? undefined);
      state = await vault.materialize();
    } catch (err) {
      // An unallocated vault is not an error here: `list` is the read half of
      // the protocol dance and must never create anything on its own (D2
      // scopes lazy creation to `push`). Reporting it as an EMPTY ref set is
      // exactly what a fresh repository looks like to git, and `push` still
      // runs `list` first either way — this is what lets a first push land in
      // one command instead of `list` failing the whole exchange before
      // `push` ever gets a turn. Nothing to share with `push` either
      // (design D7): an unallocated vault has no base to reuse.
      if (isVaultNotFound(err)) {
        endBlock();
        return;
      }
      throw err;
    }
    if (repoDir) sharedListSession = { repoDir, walletName: resolvedWallet?.name ?? null, vault, base: state };
    const refs = state.refs ?? {};
    for (const ref of Object.keys(refs).sort()) out(`${refs[ref]} ${ref}`);
    // A snapshot-only vault holds protocol refs but no branch heads, so a
    // plain `git clone` prints "cloned an empty repository" with no hint the
    // history exists (blind-acceptance finding, 2026-08-28). Say where it is.
    const refNames = Object.keys(refs);
    if (refNames.length > 0 && !refNames.some((r) => r.startsWith("refs/heads/"))) {
      note(`this vault has no branch heads yet — its history lives on ${refNames.sort()[0]}`);
      note(`fetch it with: git fetch <remote> '+${refNames.sort()[0]}:${refNames.sort()[0]}' && git checkout -b restored ${refNames.sort()[0]}`);
    }
    const head = state.head_target;
    // A symref is only advertised when its target is actually present:
    // pointing HEAD at a ref that does not exist is what an empty repository
    // looks like, and git reads the empty list correctly on its own.
    if (head?.kind === "symref" && Object.prototype.hasOwnProperty.call(refs, head.ref)) out(`@${head.ref} HEAD`);
    else if (head?.kind === "detached") out(`${head.oid} HEAD`);
    endBlock();
  }

  async function runFetch(batch) {
    // Resolve the target repository BEFORE a single byte is decrypted: a
    // refusal here must leave no objects anywhere. This is what makes `clone`
    // work (git names the fresh repo in `GIT_DIR`) and what stops a clone run
    // from inside an unrelated checkout from writing into that checkout.
    let repoDir;
    try {
      repoDir = await requireRepo();
    } catch (err) {
      repoRefusalNote(err);
      return 1;
    }
    // The repository is resolved — walk the binding from ITS directory, not
    // cwd (the "WHICH REPOSITORY" note above: during `git clone` cwd is
    // wherever clone was run FROM, unrelated to the target repository).
    applyWalletForDir(repoDir);
    if (verbosity >= 1) note(`restoring the vault object database for ${batch.length} ref(s) into ${repoDir}`);
    const restored = await getSdk().gitvault.restore({ ...target, repo_dir: repoDir, target_dir: repoDir });
    if (verbosity >= 1) note(`restored generation ${restored.generation}`);
    // clone-installs-retained-refs D3: a bookkeeping failure here degrades to
    // exactly today's (pre-change) behavior — one stderr note, fetch still
    // completes. `restored.retained_refs` is never absent (the SDK always
    // returns a result, never throws for this step).
    if (restored.retained_refs?.warning) note(restored.retained_refs.warning);
    else if (verbosity >= 1 && (restored.retained_refs?.written.length > 0 || restored.retained_refs?.deleted.length > 0)) {
      note(`refs/r402/retain: +${restored.retained_refs.written.length} -${restored.retained_refs.deleted.length} (${restored.retained_refs.retained_count} retained tip(s) total)`);
    }
    endBlock();
    return 0;
  }

  async function runPush(batch) {
    const specs = batch.map(parsePushSpec);
    // D4: `refs/r402/*` is client-local — refuse it per-ref, BEFORE any
    // repository/wallet/network work, while unrelated branch updates in the
    // SAME push proceed normally (client-surface spec's own scenario).
    const { refused, allowed } = partitionProtectedRefPushes(specs);
    for (const spec of refused) {
      note(`refusing ${spec.dst}: ${R402_PROTECTED_REF_NAMESPACE_REASON}`);
      out(`error ${spec.dst} ${R402_PROTECTED_REF_NAMESPACE_REASON}`);
    }
    if (allowed.length === 0) {
      endBlock();
      return 0;
    }
    try {
      // Repository first, then every source revision, and only then the
      // network: a push that names a ref this repository does not have must
      // fail locally rather than after opening the vault.
      const repoDir = await requireRepo();
      // Same "walk from the resolved repository, not cwd" rule as `fetch`.
      applyWalletForDir(repoDir);
      const newOids = new Map();
      for (const spec of allowed) {
        // A deletion carries an empty <src>. Everything else is resolved by
        // git itself; `--end-of-options` keeps a hostile refname from being
        // read as a flag.
        newOids.set(spec, spec.src === ""
          ? null
          : (await hardenedGit(repoDir, ["rev-parse", "--verify", "--end-of-options", spec.src])).text().trim());
      }

      if (dryRun) {
        // kychee-com/run402#565: READ-ONLY resolution — `openVault`, never
        // `openOrCreateVault` — so a push-to-create dry run allocates
        // NOTHING. An unresolved vault means there is nothing to preview a
        // push against yet (no repo_id ⇒ no encryption key ⇒ sizing is
        // genuinely unknowable, not merely unreported); still report success
        // per-ref, since a real push here WOULD succeed (it would allocate
        // first) — only the sizing is unavailable.
        let vault;
        try {
          vault = await openVault(repoDir);
        } catch (err) {
          if (!isVaultNotFound(err)) throw err;
          note("dry-run: no vault allocated for this project yet — a real push would allocate one (push-to-create) before publishing; object/byte sizing is not knowable until then");
          for (const spec of allowed) out(`ok ${spec.dst}`);
          endBlock();
          return 0;
        }
        const base = await vault.materialize();
        const updates = [];
        for (const spec of allowed) {
          const expectedOld = base.refs?.[spec.dst] ?? null;
          updates.push({
            ref: spec.dst,
            expected_old_oid: expectedOld,
            new_oid: newOids.get(spec),
            force: spec.force && expectedOld !== null,
          });
        }
        // Same evaluation, pack building, and sealing/encryption a real push
        // runs — stops before the two network mutations (upload, admit). A
        // refusal here (non-fast-forward, tag immutability, ...) throws the
        // SAME way a real push's would, caught below and reported as
        // `error`, never a fake `ok`.
        const plan = await vault.planPush({ transaction: { updates } });
        note(
          `dry-run: would publish generation ${plan.would_admit_generation} (${plan.would_admit_generation_decimal}, ${plan.form}) — ` +
          `${plan.object_count} object(s), ${plan.encrypted_bytes} encrypted byte(s) (${plan.raw_bytes} raw), ` +
          `${Object.keys(plan.refs).length} ref(s); no allocation needed`,
        );
        for (const spec of allowed) out(`ok ${spec.dst}`);
        endBlock();
        return 0;
      }

      // Design D1: reuse `list`'s vault + materialized base for this push's
      // FIRST admission attempt when it resolved the SAME repository under
      // the SAME wallet — skips `openOrCreateVault` and `materialize()`
      // entirely instead of resolving/materializing the vault a second and
      // third time in one `list → push` exchange. A conflict retry inside
      // `vault.push` re-materializes from storage exactly as it always has;
      // only the FIRST attempt's base changes here. Any mismatch (no prior
      // `list`, an unallocated vault `list` had nothing to share for, or a
      // different repository/wallet) falls back to the original flow.
      const shared = sharedListSession && sharedListSession.repoDir === repoDir && sharedListSession.walletName === (resolvedWallet?.name ?? null) ? sharedListSession : null;
      const vault = shared ? shared.vault : await openOrCreateVault(repoDir);
      const base = shared ? shared.base : await vault.materialize();
      const updates = [];
      for (const spec of allowed) {
        const expectedOld = base.refs?.[spec.dst] ?? null;
        updates.push({
          ref: spec.dst,
          expected_old_oid: expectedOld,
          new_oid: newOids.get(spec),
          // Force-with-lease still requires a lease, so a CREATE is never
          // forced. The SDK owns what force actually permits.
          force: spec.force && expectedOld !== null,
        });
      }
      // Repair a DANGLING HEAD from this batch's own branches (#568) — see
      // `chooseGitvaultHeadTargetForPush`'s own doc comment for the exact
      // rule. `localHeadRef` is read from THIS repository (never cwd, same
      // fail-closed resolution as everything else in this function).
      const headFix = chooseGitvaultHeadTargetForPush({
        baseHeadTarget: base.head_target,
        baseRefs: base.refs,
        updates,
        localHeadRef: await localHeadBranchRef(repoDir),
      });
      if (headFix.note) note(headFix.note);
      // ONE transaction for the whole batch: the SDK evaluates fast-forward,
      // tag immutability, protocol-ref refusal and retention roots, builds the
      // packs, and publishes — all or nothing. `head_target` is included ONLY
      // when a repair is called for; omitted, `vault.push` carries the base
      // forward unchanged — a healthy HEAD is never moved.
      const published = await vault.push({
        transaction: { updates },
        base,
        ...(headFix.head_target ? { head_target: headFix.head_target } : {}),
      });
      if (verbosity >= 1) note(`published generation ${published.generation} (${published.form})`);
      for (const spec of allowed) out(`ok ${spec.dst}`);
    } catch (err) {
      // The transaction is atomic, so a failure failed every ref in it. Report
      // it against each one rather than letting some look like they landed.
      if (err?.code === "GIT_INVOCATION_REPO_UNRESOLVED") repoRefusalNote(err);
      const reason = describeError(err);
      for (const spec of allowed) out(`error ${spec.dst} ${reason}`);
    }
    endBlock();
    return 0;
  }

  function handleOption(name, value) {
    switch (name) {
      case "verbosity": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) { out("error expected an integer verbosity"); return; }
        verbosity = parsed;
        out("ok");
        return;
      }
      case "progress":
        // Progress is stderr chatter, which `verbosity` already governs.
        out("ok");
        return;
      case "atomic":
        // Every push here is a single ref transaction, so the guarantee holds
        // whichever way git asked for it.
        out("ok");
        return;
      case "dry-run":
        // kychee-com/run402#565: a REAL dry run — `runPush` runs the actual
        // local pipeline (pack building, encryption sizing) and stops before
        // the two network mutations. `value` is git's own boolean spelling
        // ("true"/"false"); anything else is refused rather than guessed.
        if (value === "true") { dryRun = true; out("ok"); return; }
        if (value === "false") { dryRun = false; out("ok"); return; }
        out("unsupported");
        return;
      default:
        // Includes object-format, depth, cloning, check-connectivity,
        // followtags, pushcert: honestly unsupported rather than acknowledged.
        out("unsupported");
    }
  }

  let fetchBatch = [];
  let pushBatch = [];

  /** Returns the process exit code the flushed batch demands (0 = keep going). */
  async function flushBatches() {
    if (fetchBatch.length > 0) {
      const batch = fetchBatch;
      fetchBatch = [];
      return await runFetch(batch);
    }
    if (pushBatch.length > 0) {
      const batch = pushBatch;
      pushBatch = [];
      return await runPush(batch);
    }
    return 0;
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        const code = await flushBatches();
        if (code !== 0) return code;
        continue;
      }
      const space = line.indexOf(" ");
      const command = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? "" : line.slice(space + 1);
      switch (command) {
        case "capabilities":
          out("fetch");
          out("push");
          out("option");
          endBlock();
          break;
        case "list":
          await runList();
          break;
        case "option": {
          const optSpace = rest.indexOf(" ");
          handleOption(optSpace === -1 ? rest : rest.slice(0, optSpace), optSpace === -1 ? "" : rest.slice(optSpace + 1));
          break;
        }
        case "fetch":
          fetchBatch.push(rest);
          break;
        case "push":
          pushBatch.push(rest);
          break;
        default:
          note(`unknown command: ${oneLine(line)}`);
          return 1;
      }
    }
    // EOF. Git always terminates a batch with a blank line, but flushing here
    // means a truncated stream still does the work it already asked for
    // instead of silently dropping it.
    return await flushBatches();
  } finally {
    rl.close();
  }
}

// Only run the protocol loop when git (or a human) actually invoked this file
// as a binary — never on `import` (tests import `chooseGitvaultHeadTargetForPush`
// directly; without this guard that import would block on stdin forever).
const invokedDirectly = (() => {
  try {
    if (process.argv[1] === undefined) return false;
    // SYMLINK-SAFE, or every real install is dead (4.39.0 shipped without
    // this and the helper silently no-opped for everyone): npm installs the
    // bin as a SYMLINK (`/opt/homebrew/bin/git-remote-run402 -> ../lib/...`),
    // and Node's ESM loader resolves `import.meta.url` through the symlink
    // to the REAL file while `process.argv[1]` keeps the symlink path — a
    // naive equality check therefore fails exactly and only in production,
    // where `git push` then reads zero capabilities and aborts the session.
    // Compare realpaths on both sides; a vanished argv[1] path falls through
    // to the plain comparison rather than crashing the guard.
    const argvReal = (() => {
      try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
    })();
    return import.meta.url === pathToFileURL(argvReal).href;
  } catch {
    return false;
  }
})();

// Never `process.exit()` mid-stream: that can truncate a pending stdout write
// on a pipe, which git reads as a protocol violation. Set the code and let Node
// flush and exit on its own.
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { note(describeError(err)); process.exitCode = 1; },
  );
}
