/**
 * The HOST-AGNOSTIC remote-helper session (gitvault-persistent-helper D1).
 *
 * Extracted verbatim from `cli/git-remote-run402.mjs` so ONE implementation
 * serves two hosts: the in-process fallback (the thin bin imports this and
 * runs it with the real process's stdio) and the resident daemon
 * (`cli/lib/gitvault-daemon.mjs`, which forwards a client's session into it).
 * Per-invocation state — wallet resolution, repository resolution, env-
 * derived config — is resolved fresh per `runHelperSession` call; the only
 * thing that persists across sessions in a daemon is warm code and warm
 * connections. stdout/stderr go through `process.stdout`/`process.stderr`
 * writes, which the daemon host redirects for the session's duration; stdin
 * is injected (`sessionStdin`) because a daemon session's input arrives over
 * the socket.
 *
 * The original file-level doctrine follows, unchanged:
 *
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
 *
 * DEGRADED READ MODE (gitvault-byo-primary-bucket, design D4). `list` and
 * `fetch` each wrap their own live gateway read in
 * `getSdk().gitvault.withDegradedRead` — on a NETWORK-CLASS failure (never a
 * 401/403/404 or any other 4xx; one bounded retry runs first so a transient
 * blip does not flap between sources) with a mirror configured for this
 * vault, the read is served from it instead via the SAME `r402s-recover`
 * engine `run402 repos recover` uses — `git fetch`/`clone` keep working
 * while run402 is down. The result is marked `degraded: true` with source
 * provenance, and exactly one stderr line names the fallback and its source
 * (`gitvaultDegradedReadNote`). Local trust pins never advance past what the
 * mirror copy itself chain-verifies (the fallback engine never touches the
 * live vault's own keystore pins at all — see `gitvault-degraded-read.ts`'s
 * own doc comment). A vault with no mirror configured is BYTE-IDENTICAL to
 * today: the original gateway error surfaces unchanged. `push` is UNTOUCHED
 * by this — writes are never rerouted; admission always requires the
 * gateway.
 */

import { createInterface } from "node:readline";
import { statSync } from "node:fs";

// The heavy graphs load as ONE top-level await batch — in the in-process
// host this races the thin bin's already-fired prewarm; in the daemon host
// it happens once at daemon boot (gitvault-startup-amortization D1).
const sdkModP = import("./sdk.mjs");
const walletModP = import("./wallet-context.mjs");
const isoModP = import("#sdk");
const nodeModP = import("#sdk/node");
const configModP = import("./config.mjs");
const { getSdk } = await sdkModP;
const { resolveWalletCore, enforceWalletExistsCore, WalletSelectionError } = await walletModP;
const { gitvaultRemoteAddressForm, gitvaultSlugReleasedInfo, parseGitvaultRemoteUrl, gitvaultDegradedReadNote } = await isoModP;
const { GITVAULT_R402_REF_NAMESPACE, hardenedGit, resolveGitInvocationRepo, readPinnedGitvaultRepo, pinGitvaultRepo, readGitvaultRestoreMarker, readGitvaultAutoGcThreshold, predialGitvaultObjectStore } = await nodeModP;
const { allowanceFile, projectCredentialsFile, profileStateFile } = await configModP;

/**
 * Per-session SDK construction cache (gitvault-first-op-premium task 2.2).
 *
 * `getSdk()` builds a fresh Node SDK instance on every call — cheap for a
 * traditional one-process-per-invocation CLI, but this module is ALSO the
 * resident daemon's per-session engine, where every forwarded session calls
 * it fresh exactly once (via `openVault`). Measured: constructing a NEW SDK
 * instance re-probes the paid-fetch buyer's rail selection (two live RPC
 * calls, `sepolia.base.org` + `mainnet.base.org`, ~150-300ms combined) on
 * its own first authenticated request — a cost a genuinely resident process
 * should pay ONCE, not once per session. This is the dominant share of the
 * measured "first transport op" premium a resident daemon was built to
 * eliminate and, before this cache, did not.
 *
 * Keyed on the resolved wallet + the env that governs config resolution
 * (`RUN402_CONFIG_DIR`/`RUN402_API_BASE` — the exact two vars `getSdk`'s own
 * doc comment calls out as reasons a fresh instance mattered for tests that
 * mutate them between calls in one process) and INVALIDATED on the mtime of
 * the three files whose bytes actually determine signer/credential material
 * (allowance, project-credentials keystore, profile state) — a wallet
 * rotation, `run402 init`, or any other on-disk change is picked up on the
 * very next call, no daemon restart required. A file that does not exist
 * yet (fresh wallet, no allowance) signs into the key as `null`, so its
 * LATER appearance also busts the cache. The in-process fallback host calls
 * this at most once per process anyway, so it degrades to exactly today's
 * behavior there — this only changes anything for the daemon.
 */
let cachedSdk = null; // { key, sdk }

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function sdkCacheKey() {
  const wallet = process.env.RUN402_WALLET ?? "";
  const configDir = process.env.RUN402_CONFIG_DIR ?? "";
  const apiBase = process.env.RUN402_API_BASE ?? "";
  const files = [mtimeOf(allowanceFile()), mtimeOf(projectCredentialsFile()), mtimeOf(profileStateFile())];
  return `${wallet} ${configDir} ${apiBase} ${files.join(",")}`;
}

export function getCachedSdk() {
  const key = sdkCacheKey();
  if (cachedSdk && cachedSdk.key === key) return cachedSdk.sdk;
  const sdk = getSdk();
  cachedSdk = { key, sdk };
  return sdk;
}

/** The session's input stream — injected per session (daemon: the socket's forwarded stdin). */
let sessionStdin = process.stdin;

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

/**
 * gitvault-checkpoint-cadence design D1 — the pure post-push auto-gc
 * threshold decision, exported standalone so the threshold matrix (below /
 * at / disabled) is directly unit-testable without the session's heavier
 * closures (network, git, daemon plumbing). `0` (or anything not a
 * positive finite number — a corrupt local config value) means disabled;
 * `generationsSinceCheckpoint >= threshold` is the trigger (matches
 * `gitvaultCheckpointStaleness`'s own `since >= THRESHOLD` shape).
 */
export function shouldRunAutoGc(threshold, generationsSinceCheckpoint) {
  return Number.isFinite(threshold) && threshold > 0 && Number.isFinite(generationsSinceCheckpoint) && generationsSinceCheckpoint >= threshold;
}

/**
 * The auto-gc cycle's `compact()`/`prune()` target — exported standalone,
 * same reasoning as `shouldRunAutoGc` above, because the merge itself was
 * the bug: `GitvaultVaultHandleOptions.repo_dir` defaults to
 * `process.cwd()` only in CALLER convention, never inside the SDK's own
 * `open()` (which sets it ONLY when `options.repo_dir !== undefined`).
 * Building the auto-gc target from `{ ...target }` alone — omitting
 * `repo_dir` — made every real post-push auto-gc cycle fail closed with
 * `GITVAULT_REPO_DIR_REQUIRED`, silently degrading to the advisory on
 * EVERY push, live in production shape, until a push-latency guard bench
 * finally drove the real trigger path (found 2026-08-31; `repos gc`'s CLI
 * wrapper passes repo_dir explicitly and never hit this).
 */
export function buildAutoGcCompactionTarget(target, repoDir) {
  return { ...target, repo_dir: repoDir };
}

async function main(argv, { onBackgroundWork } = {}) {
  // gitvault-connection-amortization (bench P5) note: the prewarm now fires
  // at the module TOP, before the SDK graph loads (gitvault-startup-
  // amortization D1) — connection dial and signer warmup both race module
  // evaluation instead of starting here.
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
    if (!resolvedRepo) {
      resolvedRepo = await resolveGitInvocationRepo(process.env, process.cwd());
      // gitvault-object-host-predial task 2.1 (trigger (a), the in-process
      // fallback path — this module IS that fallback; a daemon-forwarded
      // session reaches the same code and gets the same predial for free).
      // The repository is now known OFFLINE (no network read, matching
      // design D6) — fire-and-forget dial the addressed repo's persisted
      // object-store origin(s), if the local keystore has learned any, so
      // it overlaps the rest of this session's local work exactly like the
      // API-origin prewarm that already raced module load above. A repo
      // with no local pin (never opened here before) or nothing persisted
      // yet predials nothing — never a source of a new failure mode.
      void (async () => {
        try {
          const pinned = await readPinnedGitvaultRepo(resolvedRepo.repo_dir);
          if (pinned) predialGitvaultObjectStore(pinned.repo_id);
        } catch {
          /* best-effort: must never surface from repository resolution */
        }
      })();
    }
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
    const result = await getCachedSdk().gitvault.resolveOrCreateAddress({ address, allow_create: false, ...(repoDir ? { repo_dir: repoDir } : {}) });
    return { vault: result.handle.vault, keystore: result.handle.keystore, repo_id: result.handle.repo_id, resolution: result.resolution };
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
        const result = await getCachedSdk().gitvault.resolveOrCreateAddress({ address, repo_dir: repoDir, allow_create: false });
        return result.handle.vault;
      }
    }
    const result =
      addressForm === "id"
        ? await getCachedSdk().gitvault.openOrCreate({ ...target, repo_dir: repoDir })
        : await getCachedSdk().gitvault.resolveOrCreateAddress({ address, repo_dir: repoDir, allow_create: true });
    if (addressForm === "id" && repoDir) await pinGitvaultRepo(repoDir, result.handle.repo_id, undefined, { project_id: target.project_id, org_id: target.org_id });
    if (!result.found && result.created) {
      note("");
      note(`vault ${result.handle.repo_id} allocated (genesis ${result.created.genesis_sha256}) — one-shot recovery receipt, keep many copies:`);
      note(JSON.stringify(result.created.recovery_receipt));
      try {
        const { getGitvaultKeystoreRoot, GITVAULT_MIRROR_SETUP_HINT } = await import("#sdk/node");
        // gitvault-mirror-default: every allocation teaches the mirror door
        // beside the recovery receipt, lazy push-to-create included.
        note(GITVAULT_MIRROR_SETUP_HINT);
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
    // gitvault-session-state-reuse design D2: read the restore MARKER —
    // NEVER the chain-trust pin (see `tryStateFastPath`'s own doc comment on
    // why the pin is the wrong `since` for a standing clone that is
    // generations behind) — once, here, and thread it to the materialize
    // call below AND to `fetch`'s reuse below. Best-effort: a marker-read
    // failure (no repository, no prior restore) just means no `since` is
    // sent, exactly today's behavior.
    let fetchMarker = null;
    if (repoDir) {
      try {
        fetchMarker = await readGitvaultRestoreMarker(repoDir);
      } catch {
        fetchMarker = null;
      }
    }
    const materializeOpts = fetchMarker ? { deltaSince: fetchMarker.generation } : {};
    let opened;
    try {
      opened = await openVault(repoDir ?? undefined);
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
    let vault = opened.vault;

    // gitvault-byo-primary-bucket (design D4, task 3.4 — mirror half): the
    // live materialize (with its own stale-pin retry, unchanged from before
    // this change) is the "attemptLive" `withDegradedRead` wraps — on a
    // NETWORK-CLASS failure (never 4xx) with a mirror configured for this
    // vault, it falls back to `r402s-recover`'s engine against it instead of
    // failing the whole `list`/`clone`. `repoDir` is required for the
    // fallback to materialize into (`out_dir`); a repo-free `list` (bare
    // `git ls-remote`) simply has none, so the fallback never runs and the
    // original error surfaces exactly as it always did.
    const attemptLive = async () => {
      try {
        return await vault.materialize(materializeOpts);
      } catch (err) {
        // An OFFLINE (id-carrying pin) resolution discovers a stale pin on
        // its FIRST repo-scoped read (client-surface spec, id-pinning
        // requirement): recover once — clear the pin, re-resolve — and retry
        // only when re-resolution lands on a DIFFERENT vault; a same-id
        // answer means the pin was fine and the refusal below is real. git
        // always runs `list` first in a helper session, so this one site
        // heals the pin for the `fetch`/`push` that follows it.
        const recovered = repoDir && opened.resolution?.offline
          ? await getCachedSdk().gitvault.recoverStalePin({ address, repo_dir: repoDir, resolution: opened.resolution, error: err })
          : null;
        if (!recovered) throw err;
        note(`pinned vault ${opened.resolution.repo_id} no longer resolves — re-resolved to ${recovered.resolution.repo_id}, retrying`);
        vault = recovered.handle.vault;
        opened = { ...opened, vault: recovered.handle.vault, keystore: recovered.handle.keystore, repo_id: recovered.handle.repo_id, resolution: recovered.resolution };
        return await vault.materialize(materializeOpts);
      }
    };

    let outcome;
    try {
      outcome = await getCachedSdk().gitvault.withDegradedRead({ attemptLive, keystore: opened.keystore, repo_id: opened.repo_id, out_dir: repoDir });
    } catch (err) {
      // Same "an unallocated vault is not an error" reasoning as above — a
      // 404 discovered only once materialize actually runs takes this same
      // empty-ref-set path (network-class errors never reach here at all:
      // `withDegradedRead` only rethrows them after exhausting its own
      // fallback, and a 404 is never network-class).
      if (isVaultNotFound(err)) {
        endBlock();
        return;
      }
      throw err;
    }

    let refs;
    let head;
    if (outcome.degraded) {
      // Exactly ONE stderr line naming the degraded read and its source
      // (design D4) — the validity-not-freshness limit rides inside the
      // canonical statement this composes, verbatim.
      note(gitvaultDegradedReadNote(outcome.result.source));
      refs = outcome.result.refs ?? {};
      head = outcome.result.head_target;
      // No live vault instance materialized this pass — nothing safe to
      // share with a following `push` (design D7's own "unallocated vault"
      // reasoning applies equally to a degraded one: writes are never
      // rerouted, so `push` must resolve and materialize live on its own).
    } else {
      const state = outcome.live;
      refs = state.refs ?? {};
      head = state.head_target;
      // gitvault-session-state-reuse design D1: `fetchState`/`fetchMarker`
      // extend the SAME session-scoped handoff `push` already reuses (`base`)
      // — the `fetch` phase of THIS session reuses this response instead of
      // issuing its own state read. Session-scoped only: dropped the moment a
      // push admits in this same session (see `runPush`'s reset below).
      // `keystore`/`repo_id` ride along so `fetch`'s own degraded-read wrap
      // can fall back without re-resolving.
      if (repoDir) sharedListSession = { repoDir, walletName: resolvedWallet?.name ?? null, vault, keystore: opened.keystore, repo_id: opened.repo_id, base: state, fetchMarker, fetchState: state };
    }

    for (const ref of Object.keys(refs).sort()) out(`${refs[ref]} ${ref}`);
    // A snapshot-only vault holds protocol refs but no branch heads, so a
    // plain `git clone` prints "cloned an empty repository" with no hint the
    // history exists (blind-acceptance finding, 2026-08-28). Say where it is.
    const refNames = Object.keys(refs);
    if (refNames.length > 0 && !refNames.some((r) => r.startsWith("refs/heads/"))) {
      note(`this vault has no branch heads yet — its history lives on ${refNames.sort()[0]}`);
      note(`fetch it with: git fetch <remote> '+${refNames.sort()[0]}:${refNames.sort()[0]}' && git checkout -b restored ${refNames.sort()[0]}`);
    }
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
    // gitvault-session-state-reuse design D1/D4: reuse THIS session's `list`
    // phase state — same resolved repository AND wallet, exactly the same
    // matching rule `push`'s own reuse uses above — instead of a second
    // network state read. Any mismatch (no prior `list`, a failed list, a
    // different repository/wallet, or a push that already admitted in this
    // same session — see `runPush`'s reset) falls back to the vault's own
    // read, unchanged.
    //
    // gitvault-byo-primary-bucket (design D4, task 3.4 — mirror half):
    // either path's actual chain/payload read is the "attemptLive" that
    // `withDegradedRead` wraps — `gitvault.restore(...)` is exactly `open()`
    // followed by `handle.vault.restoreObjectsInto(target_dir)` (see that
    // method's own one-line body), decomposed here so the SECOND half can be
    // wrapped, with byte-identical resolution to today on the live-success
    // path. On a NETWORK-CLASS failure (never 4xx) with a mirror configured
    // for this vault, the fetch is served from it instead of failing the
    // whole clone; the destination it materialized into is the SAME
    // `repoDir` git already prepared, so `git fetch`/`clone` completes
    // exactly as if the live path had run.
    const shared = sharedListSession && sharedListSession.repoDir === repoDir && sharedListSession.walletName === (resolvedWallet?.name ?? null) ? sharedListSession : null;
    let attemptLive;
    let degradedKeystore;
    let degradedRepoId;
    if (shared) {
      attemptLive = () => shared.vault.restoreObjectsInto(repoDir, { marker: shared.fetchMarker, state: shared.fetchState });
      degradedKeystore = shared.keystore;
      degradedRepoId = shared.repo_id;
    } else {
      const handle = await getCachedSdk().gitvault.open({ ...target, repo_dir: repoDir });
      attemptLive = () => handle.vault.restoreObjectsInto(repoDir);
      degradedKeystore = handle.keystore;
      degradedRepoId = handle.repo_id;
    }
    const outcome = await getCachedSdk().gitvault.withDegradedRead({
      attemptLive,
      keystore: degradedKeystore,
      repo_id: degradedRepoId,
      out_dir: repoDir,
    });
    let restored;
    if (outcome.degraded) {
      // Exactly ONE stderr line naming the degraded read and its source
      // (design D4) — the validity-not-freshness limit rides inside the
      // canonical statement this composes, verbatim. A later `git push`
      // still requires the gateway unchanged — this function only ever
      // serves reads; `runPush` below is untouched by this change.
      note(gitvaultDegradedReadNote(outcome.result.source));
      restored = { generation: outcome.result.generation, retained_refs: outcome.result.retained_refs };
    } else {
      restored = { generation: outcome.live.generation, retained_refs: outcome.live.retained_refs };
    }
    if (verbosity >= 1) note(`restored generation ${restored.generation}`);
    // clone-installs-retained-refs D3: a bookkeeping failure here degrades to
    // exactly today's (pre-change) behavior — one stderr note, fetch still
    // completes. `restored.retained_refs` is never absent (both the live and
    // the degraded path always return a result, never throw for this step).
    if (restored.retained_refs?.warning) note(restored.retained_refs.warning);
    else if (verbosity >= 1 && (restored.retained_refs?.written.length > 0 || restored.retained_refs?.deleted.length > 0)) {
      note(`refs/r402/retain: +${restored.retained_refs.written.length} -${restored.retained_refs.deleted.length} (${restored.retained_refs.retained_count} retained tip(s) total)`);
    }
    endBlock();
    return 0;
  }

  /**
   * gitvault-checkpoint-cadence (design D1/D2) — the post-push auto-gc
   * cadence, `git gc --auto`'s shape: a cheap local threshold check after
   * every successful push, maintenance only past it.
   *
   * MUST be called strictly AFTER the push's own `ok`/`error` lines and
   * `endBlock()` have already been written — auto-gc can never fail, slow,
   * or reorder the push it follows (this function itself never throws).
   * `generationsSinceCheckpoint` comes from `published.checkpoint_staleness`
   * (the push's own already-materialized chain) — zero extra reads to learn
   * it.
   *
   * Threshold: `repoDir`'s local `auto_gc_generations` (default 32, `0`
   * disables — `readGitvaultAutoGcThreshold`, design D1's "rides the
   * existing vault policy surface" as a per-checkout `repos policy` knob).
   *
   * Dispatch: with a daemon-supplied `onBackgroundWork`, the compaction is
   * STARTED immediately and handed off as a promise — the daemon keeps
   * itself alive until it settles, but THIS call returns immediately so the
   * client-visible session (and the user's prompt) is not held up. Without
   * one (the in-process fallback), the SAME cycle is awaited right here,
   * with one stderr advisory line naming the wait.
   *
   * `compact()` (namespace, `sdk/src/namespaces/gitvault.ts`) already owns
   * the compaction headroom grant's open/close and single-flight refusal
   * (`GITVAULT_COMPACTION_IN_PROGRESS`) — this function only decides WHETHER
   * and HOW to run the cycle, never re-implements those. `--force-headroom`
   * is NEVER passed on this path (design D5) — an insufficient-headroom
   * refusal, a conflicting in-flight compaction, or any other failure all
   * degrade identically: one advisory line naming `run402 repos gc`, never
   * a thrown error, never a retry loop.
   */
  async function maybeRunAutoGc({ repoDir, generationsSinceCheckpoint }) {
    let threshold;
    try {
      threshold = await readGitvaultAutoGcThreshold(repoDir);
    } catch {
      return; // never let a local-config read failure touch the push it follows
    }
    if (!shouldRunAutoGc(threshold, generationsSinceCheckpoint)) return;

    // `compact()`/`prune()` never default repo_dir to process.cwd() —
    // GitvaultVaultHandleOptions's own doc comment describes CALLER
    // convention, not an SDK fallback (`open()` only sets repo_dir when
    // `options.repo_dir !== undefined`). Omitting it here made every real
    // post-push auto-gc cycle fail closed with GITVAULT_REPO_DIR_REQUIRED,
    // silently degrading to the advisory on every push (found live,
    // 2026-08-31, via a push-latency guard bench that finally drove the
    // ACTUAL trigger path instead of a synthetic `repos gc` invocation).
    const compactionTarget = buildAutoGcCompactionTarget(target, repoDir);
    const runCycle = async () => {
      const sdk = getCachedSdk();
      const checkpoint = await sdk.gitvault.compact({ ...compactionTarget });
      const prune = await sdk.gitvault.prune(compactionTarget); // PLAN only — never `submit`; see compact()'s own grant-close doc comment for why prune needs no headroom of its own
      return { checkpoint, prune };
    };

    if (typeof onBackgroundWork === "function") {
      // Daemon host: start it now, hand the PROMISE off, return immediately.
      // Failures are swallowed here (best-effort, matching the fallback
      // branch's degrade contract) — there is no live client to advise by
      // the time this settles, and the daemon's own teardown does not
      // depend on the outcome, only on the promise SETTLING.
      const cyclePromise = runCycle().catch(() => undefined);
      onBackgroundWork(cyclePromise);
      return;
    }

    // In-process fallback: the extra wall time is real, so name it.
    note(`gitvault: compacting (${generationsSinceCheckpoint} generations since checkpoint)…`);
    try {
      await runCycle();
    } catch (err) {
      note(`gitvault: auto-compaction stopped short — ${describeError(err)} — run \`run402 repos gc\` to finish it by hand.`);
    }
  }

  async function runPush(batch) {
    const specs = batch.map(parsePushSpec);
    // gitvault-checkpoint-cadence: set ONLY after a successful admission
    // (never in the catch block) — `null` means "auto-gc has nothing to
    // do", which is also the correct value for every early-return path
    // above (nothing pushed, nothing refused-only, dry-run).
    let autoGcCandidate = null;
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
          vault = (await openVault(repoDir)).vault;
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
      // gitvault-session-state-reuse design D4: this admission just advanced
      // the vault, so the `list` phase's handoff (if any) is now stale —
      // drop it. A `fetch` later in this SAME session (an unusual ordering
      // git's own protocol does not normally produce) reads fresh rather
      // than reusing pre-admission state.
      sharedListSession = null;
      if (verbosity >= 1) note(`published generation ${published.generation} (${published.form})`);
      // gitvault-clone-scaling (P3): advisory only — informational, always
      // fires at 25 generations regardless of the SEPARATE auto-gc
      // threshold below (design D1's `auto_gc_generations`, default 32) —
      // the two are deliberately different numbers for different purposes.
      if (published.checkpoint_staleness?.advised) {
        note(`${published.checkpoint_staleness.generations_since_checkpoint} generations since the last checkpoint — cold clones re-verify each one; run402 repos gc compacts them`);
      }
      for (const spec of allowed) out(`ok ${spec.dst}`);
      // gitvault-checkpoint-cadence: captured here (never in the catch
      // block below — auto-gc must never fire on a failed push) and acted
      // on AFTER this function's own `endBlock()`, so the auto-gc check
      // itself can never delay, alter, or reorder the push's own report.
      autoGcCandidate = { repoDir, generationsSinceCheckpoint: published.checkpoint_staleness?.generations_since_checkpoint ?? 0 };
    } catch (err) {
      // The transaction is atomic, so a failure failed every ref in it. Report
      // it against each one rather than letting some look like they landed.
      if (err?.code === "GIT_INVOCATION_REPO_UNRESOLVED") repoRefusalNote(err);
      // Force-spelling truth (gitvault-force-spelling-and-pin-fold): render
      // the SDK's own `git push --force` next_action beside git's per-ref
      // rejection — humans read stderr, agents read the structured error.
      const forceHint = Array.isArray(err?.body?.next_actions) ? err.body.next_actions.find((a) => a?.action === "git push --force") : null;
      if (forceHint?.why) note(`hint: ${forceHint.action} — ${forceHint.why}`);
      const reason = describeError(err);
      for (const spec of allowed) out(`error ${spec.dst} ${reason}`);
    }
    endBlock();
    // gitvault-checkpoint-cadence design D1/D2: strictly AFTER the push's
    // own report — `null` (a failed push, a refused-only batch, dry-run)
    // is a silent no-op. `maybeRunAutoGc` itself never throws.
    if (autoGcCandidate) await maybeRunAutoGc(autoGcCandidate);
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

  const rl = createInterface({ input: sessionStdin, crlfDelay: Infinity });
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

/**
 * Run one remote-helper session to completion (gitvault-persistent-helper
 * D1). `argv` is git's argv slice (`[remote, address]`); `stdin` is the
 * session's input stream (defaults to the real process stdin for the
 * in-process host). Per-session module state is reset here so a daemon
 * serving sequential sessions never leaks one invocation's resolution into
 * the next (D2). Never throws — the error path is the same
 * note-and-exit-1 the standalone binary always had.
 *
 * `onBackgroundWork` (gitvault-checkpoint-cadence design D2): when supplied
 * (the DAEMON host only — see `gitvault-daemon.mjs`), a successful push's
 * auto-gc cycle is handed to it as an ALREADY-STARTED promise instead of
 * being awaited inline, so this call resolves (and the client-visible
 * session ends) at push speed. The caller is responsible for keeping
 * whatever this promise needs alive (its own connections, its own process)
 * until the promise settles. Absent (the in-process fallback host), the
 * SAME cycle is awaited inline instead — see `maybeRunAutoGc` below.
 */
export async function runHelperSession(argv, { stdin, onBackgroundWork } = {}) {
  sessionStdin = stdin ?? process.stdin;
  resolvedWallet = null;
  try {
    return await main(argv, { onBackgroundWork });
  } catch (err) {
    note(describeError(err));
    return 1;
  } finally {
    sessionStdin = process.stdin;
  }
}
