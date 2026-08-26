#!/usr/bin/env node
/**
 * gitvault-mirror-and-recover — LIVE conformance drill (tasks 5.1 + 5.2).
 *
 * ============================================================================
 * NOT a CI test. This is a live, PAID, MUTATING drill against the real
 * production gateway (https://api.run402.com by default). It is deliberately
 * NOT registered in package.json's test scripts — running it on every push
 * would spend real testnet funds and provision/delete a real project on every
 * commit for no reason. Run it by hand, on demand, when you need to prove the
 * gitvault exit ramp against reality rather than the memory-transport mock.
 *
 * WHY THIS EXISTS (design.md "Agent Trace", tasks.md 5.1). Every gitvault
 * unit test — including the ones this same change added for the key-envelope
 * addressing fix (task 6.5) — runs against `gitvault-memory-transport.test.ts`,
 * a fixture that stores an uploaded object at whatever path the CLIENT
 * supplied. A client that constructs the WRONG storage key for `key_envelope`
 * objects (as this SDK did until 2026-08-26, commit 4294ffcd — it read/wrote
 * `envelopes/<epoch>/<fp>`, the SDK's own internal upload-manifest label,
 * instead of the gateway's real `key-envelopes/<epoch>/<fp>.env`) still
 * passes every unit test, because the mock is self-consistent with the bug:
 * it never validates the client's path against what the GATEWAY actually
 * built. Only a real sync against the real objects listing — built server-
 * side from `internal.gitvault_*` — exercises the real key shape. This drill
 * is that check. If envelope addressing regresses again, THIS is what catches
 * it, not the unit suite.
 *
 * Usage:
 *   node gitvault-mirror-drill.mjs
 *
 * Requires:
 *   - /Users/talweiss/Developer/run402-private/.env to hold BUYER_PRIVATE_KEY
 *     (the dedicated e2e-only testnet wallet — see run402-private/CLAUDE.md's
 *     "Test buyer wallet is dedicated" section). NEVER PLATFORM_WALLET_PRIVATE_KEY.
 *   - `npm run build` already run in this worktree (cli/sdk/dist,
 *     cli/core-dist must reflect current sdk/src — the CLI imports built
 *     artifacts via the `#sdk` / `#sdk/node` subpath imports, not source).
 *   - Network access to https://api.run402.com and a git binary on PATH.
 *
 * What it proves:
 *   1. A real vault, mirrored to a local directory via `gitvault mirror sync`,
 *      recovers byte-exact via `gitvault recover` — with the gateway made
 *      UNREACHABLE for the recover step (RUN402_API_BASE pointed at a closed
 *      port), proving `recover`/`mirror verify` are what the SDK's own code
 *      structurally is: pure reads against the mirror backend, zero HTTP.
 *   2. A torn/truncated mirror (newest head+admission missing) recovers at
 *      the PREVIOUS generation with `chain_break: null` (an honest "nothing
 *      further was ever synced here", never mistaken for corruption).
 *   3. A mirror missing a WAL pack referenced by its newest head (but with
 *      the head itself present) falls back a generation and NAMES the loss
 *      as `unexplained_absence` in the recovery report — never a silent skip.
 *
 * Cleanup (project delete via the CLI's own locally-cached project service
 * key) runs in a `finally` block so a failed assertion still tears down the
 * throwaway project.
 *
 * HONESTY RULE: if any live step disagrees with what the unit suite claims,
 * that is a FINDING to report verbatim, not something to route around by
 * loosening an assertion or catching an error this drill doesn't expect.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKTREE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const CLI_ENTRY = join(WORKTREE_ROOT, "cli", "cli.mjs");
const PRIVATE_ENV_PATH = "/Users/talweiss/Developer/run402-private/.env";
const WALLET_NAME = "gitvault-mirror-drill";
const API_BASE = process.env.RUN402_API_BASE_OVERRIDE_FOR_DRILL || "https://api.run402.com";
const DEAD_API_BASE = "http://127.0.0.1:1"; // nothing listens here; connect refused immediately, no DNS/timeout ambiguity.

let PASS = 0;
let FAIL = 0;
const findings = [];

function section(title) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function step(title) {
  console.log(`\n--- ${title} ---`);
}

function assertTrue(cond, msg, evidence) {
  if (cond) {
    PASS++;
    console.log(`  [PASS] ${msg}`);
  } else {
    FAIL++;
    console.log(`  [FAIL] ${msg}`);
    if (evidence !== undefined) console.log(`         evidence: ${JSON.stringify(evidence)}`);
    findings.push({ msg, evidence });
  }
}

function assertEqual(actual, expected, msg) {
  assertTrue(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`, { actual, expected });
}

/** Read BUYER_PRIVATE_KEY out of the private repo's .env without shelling through it. */
function readBuyerPrivateKey() {
  const text = readFileSync(PRIVATE_ENV_PATH, "utf8");
  for (const line of text.split("\n")) {
    const m = /^BUYER_PRIVATE_KEY=(.+)$/.exec(line.trim());
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  throw new Error(`BUYER_PRIVATE_KEY not found in ${PRIVATE_ENV_PATH}`);
}

/**
 * Run `node cli/cli.mjs <args>` as a child process. Returns {code, stdout,
 * stderr, json} — json is JSON.parse(stdout.trim()) on success, null if
 * stdout wasn't parseable JSON (some commands print nothing on stdout).
 * Throws (never returns) on a non-zero exit unless allowFail is set.
 */
function runCli(args, { cwd = WORKTREE_ROOT, env = {}, allowFail = false, label = args.join(" ") } = {}) {
  const fullEnv = { ...process.env, RUN402_CONFIG_DIR: DRILL_CONFIG_DIR, ...env };
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, env: fullEnv, encoding: "utf8" });
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  const code = r.status ?? (r.signal ? 128 : 1);
  if (code !== 0 && !allowFail) {
    console.log(`  $ run402 ${label}`);
    console.log(`    exit ${code}`);
    if (stdout) console.log(`    stdout: ${stdout.slice(0, 2000)}`);
    if (stderr) console.log(`    stderr: ${stderr.slice(0, 2000)}`);
    throw new Error(`run402 ${label} failed with exit ${code}: ${stderr || stdout || "(no output)"}`);
  }
  return { code, stdout, stderr, json };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

// ─── Setup: isolated CLI state so this drill never touches a real profile ──

const DRILL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gitvault-drill-config-"));
const REPO_DIR = mkdtempSync(join(tmpdir(), "gitvault-drill-repo-"));
const MIRROR_DIR = mkdtempSync(join(tmpdir(), "gitvault-drill-mirror-"));
const RECOVER_DIR = mkdtempSync(join(tmpdir(), "gitvault-drill-recover-"));
const scratchDirs = [DRILL_CONFIG_DIR, REPO_DIR, MIRROR_DIR, RECOVER_DIR];

let projectId = null;
let repoId = null;

async function main() {
  section("gitvault-mirror-and-recover — LIVE conformance drill");
  console.log(`api_base:        ${API_BASE}`);
  console.log(`drill config dir: ${DRILL_CONFIG_DIR}`);
  console.log(`drill repo dir:   ${REPO_DIR}`);
  console.log(`drill mirror dir: ${MIRROR_DIR}`);
  console.log(`drill recover dir:${RECOVER_DIR}`);

  // ── 1. Wallet: import the dedicated e2e buyer key (never the platform key) ──
  step("1. Import the dedicated e2e buyer wallet");
  const privateKey = readBuyerPrivateKey();
  assertTrue(/^0x[0-9a-fA-F]{64}$/.test(privateKey), "BUYER_PRIVATE_KEY is a well-formed 0x-prefixed private key");
  {
    const r = spawnSync(process.execPath, [CLI_ENTRY, "wallets", "import", WALLET_NAME, "--key", "-"], {
      cwd: WORKTREE_ROOT,
      env: { ...process.env, RUN402_CONFIG_DIR: DRILL_CONFIG_DIR },
      input: privateKey + "\n",
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`wallets import failed: ${r.stderr}`);
    const imported = JSON.parse(r.stdout.trim());
    console.log(`  imported wallet '${imported.local_label}' -> ${imported.address}`);
    assertTrue(imported.imported === true, "wallets import reports imported:true", imported);
  }
  const WALLET_ARGS = ["--wallet", WALLET_NAME];

  // ── 2. Bootstrap: allowance + faucet-if-zero + report current tier ──
  step("2. run402 init (allowance + faucet-if-zero)");
  const initResult = runCli(["init", ...WALLET_ARGS], { label: "init" });
  console.log(`  wallet: ${JSON.stringify(initResult.json?.wallet)}`);
  console.log(`  balances: ${JSON.stringify(initResult.json?.balances)}`);
  console.log(`  tier: ${JSON.stringify(initResult.json?.tier)}`);

  step("2b. Ensure an active prototype tier (subscribe/renew if needed)");
  const tierStatus = runCli(["tier", "status", ...WALLET_ARGS], { label: "tier status" });
  console.log(`  tier status: ${JSON.stringify(tierStatus.json)}`);
  const tierActive = tierStatus.json?.status === "active" || tierStatus.json?.tier?.status === "active";
  if (!tierActive) {
    console.log("  no active tier — subscribing to prototype ($0.10 x402)");
    const tierSet = runCli(["tier", "set", "prototype", ...WALLET_ARGS], { label: "tier set prototype" });
    console.log(`  tier set result: ${JSON.stringify(tierSet.json)}`);
  } else {
    console.log("  tier already active — skipping subscribe (renew-on-set would also be safe, but unnecessary spend)");
  }

  // ── 3. Provision a throwaway project ──
  step("3. Provision a throwaway project");
  const projectName = `mirror-drill-${Date.now()}`;
  const provisionResult = runCli(["projects", "provision", "--tier", "prototype", "--name", projectName, ...WALLET_ARGS], { label: "projects provision", cwd: REPO_DIR });
  projectId = provisionResult.json?.project_id;
  assertTrue(typeof projectId === "string" && projectId.startsWith("prj_"), "provision returned a prj_ id", provisionResult.json);
  console.log(`  project_id: ${projectId}`);

  // ── 4. Local git repo with 3 commits ──
  step("4. git init + 3 commits in the drill repo");
  git(REPO_DIR, ["init", "--initial-branch=main"]);
  git(REPO_DIR, ["config", "user.email", "drill@run402.dev"]);
  git(REPO_DIR, ["config", "user.name", "gitvault-mirror-drill"]);
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(REPO_DIR, `file-${i}.txt`), `commit ${i} at ${new Date().toISOString()}\n`.repeat(50));
    git(REPO_DIR, ["add", "-A"]);
    git(REPO_DIR, ["commit", "-m", `commit ${i}`]);
  }
  const localHead = git(REPO_DIR, ["rev-parse", "HEAD"]);
  console.log(`  local HEAD after 3 commits: ${localHead}`);

  // ── 5. gitvault init (allocate the vault, mint the recovery receipt) ──
  step("5. gitvault init — allocate the vault");
  const gvInit = runCli(["gitvault", "init", "--project", projectId, "--no-remote", ...WALLET_ARGS], { cwd: REPO_DIR, label: "gitvault init" });
  repoId = gvInit.json?.repo_id;
  assertTrue(typeof repoId === "string" && repoId.startsWith("src_"), "gitvault init returned a src_ repo_id", gvInit.json);
  console.log(`  repo_id: ${repoId}, genesis_sha256: ${gvInit.json?.genesis_sha256}`);
  assertTrue(typeof gvInit.json?.recovery_receipt === "object" && gvInit.json.recovery_receipt !== null, "gitvault init emitted a recovery_receipt", gvInit.json?.recovery_receipt);

  // ── 6. Publish 3 distinct generations, one snapshot per commit. ──
  //
  // `gitvault snapshot` captures whatever the working tree looks like RIGHT
  // NOW — so to get 3 ascending, DISTINCT generations we replay the 3 commits
  // one at a time, snapshotting after each, rather than snapshotting once
  // against the already-fully-committed tree from step 4 (which would yield
  // exactly one generation covering all three commits' combined delta).
  step("6. Publish 3 generations (one snapshot per commit)");
  git(REPO_DIR, ["reset", "--hard", "--quiet", git(REPO_DIR, ["rev-list", "--max-parents=0", "HEAD"])]);
  rmSync(join(REPO_DIR, "file-2.txt"), { force: true });
  rmSync(join(REPO_DIR, "file-3.txt"), { force: true });

  const generations = [];
  for (let i = 1; i <= 3; i++) {
    if (i > 1) {
      writeFileSync(join(REPO_DIR, `file-${i}.txt`), `commit ${i} at ${new Date().toISOString()}\n`.repeat(50));
      git(REPO_DIR, ["add", "-A"]);
      git(REPO_DIR, ["commit", "-m", `commit ${i}`]);
    }
    const snap = runCli(["gitvault", "snapshot", "--project", projectId, "--message", `snapshot ${i}`, ...WALLET_ARGS], { cwd: REPO_DIR, label: `gitvault snapshot #${i}` });
    console.log(`  snapshot #${i}: generation=${snap.json?.generation} form=${snap.json?.form}`);
    generations.push(snap.json?.generation);
  }
  assertTrue(generations.every((g) => typeof g === "string"), "every snapshot returned a generation", generations);
  assertTrue(new Set(generations).size === generations.length, "the 3 generations are distinct", generations);
  const newestGeneration = generations[generations.length - 1];

  const finalHead = git(REPO_DIR, ["rev-parse", "HEAD"]);
  const sourceRefs = git(REPO_DIR, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  console.log(`  source repo final HEAD: ${finalHead}`);
  console.log(`  source repo refs:\n${sourceRefs.split("\n").map((l) => `    ${l}`).join("\n")}`);

  // ── 7. Configure + sync + verify the mirror ──
  step("7. gitvault mirror set / sync / verify");
  const mirrorSet = runCli(["gitvault", "mirror", "set", MIRROR_DIR, "--repo", repoId, ...WALLET_ARGS], { label: "gitvault mirror set" });
  console.log(`  mirror set: ${JSON.stringify(mirrorSet.json)}`);
  assertEqual(mirrorSet.json?.repo_id, repoId, "mirror set targeted the right repo_id");

  const mirrorSync = runCli(["gitvault", "mirror", "sync", "--repo", repoId, ...WALLET_ARGS], { label: "gitvault mirror sync" });
  console.log(`  mirror sync: copied=${mirrorSync.json?.objects_copied} already_present=${mirrorSync.json?.objects_already_present} failed=${mirrorSync.json?.objects_failed} bytes=${mirrorSync.json?.bytes_copied}`);
  assertEqual(mirrorSync.json?.objects_failed, 0, "mirror sync copied everything with zero failures");
  assertTrue(Number(mirrorSync.json?.objects_copied) > 0, "mirror sync actually copied objects (not a no-op)", mirrorSync.json);

  const mirrorVerify = runCli(["gitvault", "mirror", "verify", "--repo", repoId, ...WALLET_ARGS], { label: "gitvault mirror verify" });
  console.log(`  mirror verify: recovered_generation=${mirrorVerify.json?.recovered_generation} chain_break=${JSON.stringify(mirrorVerify.json?.chain_break)} data_loss_detected=${mirrorVerify.json?.data_loss_detected}`);
  console.log(`  validity_not_freshness statement: "${mirrorVerify.json?.validity_not_freshness}"`);
  console.log(`  keystore_still_required statement: "${mirrorVerify.json?.keystore_still_required}"`);
  assertEqual(mirrorVerify.json?.recovered_generation, newestGeneration, "mirror verify (keyless) reports the newest published generation");
  assertEqual(mirrorVerify.json?.chain_break, null, "mirror verify reports no chain break on a freshly-synced mirror");
  assertEqual(mirrorVerify.json?.data_loss_detected, false, "mirror verify reports no data loss on a freshly-synced mirror");

  // ── 8. THE PROOF: recover with the gateway unreachable ──
  step("8. gitvault recover — gateway UNREACHABLE (RUN402_API_BASE points at a dead port)");
  const outDir = join(RECOVER_DIR, "restored");
  const recoverResult = runCli(
    ["gitvault", "recover", MIRROR_DIR, "--out", outDir, "--repo", repoId, ...WALLET_ARGS],
    { env: { RUN402_API_BASE: DEAD_API_BASE }, label: "gitvault recover (dead api base)" },
  );
  console.log(`  recovered_generation: ${recoverResult.json?.recovered_generation}`);
  console.log(`  chain_break: ${JSON.stringify(recoverResult.json?.chain_break)}`);
  console.log(`  data_loss_detected: ${recoverResult.json?.data_loss_detected}`);
  console.log(`  validity_not_freshness statement: "${recoverResult.json?.validity_not_freshness}"`);
  console.log(`  keystore_still_required statement: "${recoverResult.json?.keystore_still_required}"`);
  console.log(`  refs: ${JSON.stringify(recoverResult.json?.refs)}`);
  console.log(`  head_target: ${JSON.stringify(recoverResult.json?.head_target)}`);

  assertEqual(recoverResult.json?.recovered_generation, newestGeneration, "recover (network-dead) lands on the newest published generation");
  assertEqual(recoverResult.json?.chain_break, null, "recover (network-dead) reports no chain break");
  assertEqual(recoverResult.json?.data_loss_detected, false, "recover (network-dead) reports no data loss");
  assertTrue(
    recoverResult.json?.validity_not_freshness === GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT_EXPECTED,
    "recover carries the validity-not-freshness statement verbatim",
    recoverResult.json?.validity_not_freshness,
  );
  assertTrue(
    recoverResult.json?.keystore_still_required === GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT_EXPECTED,
    "recover carries the keystore-still-required statement verbatim",
    recoverResult.json?.keystore_still_required,
  );

  // Ref-exact comparison against the source repo.
  const recoveredRefs = git(outDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  console.log(`  recovered repo refs:\n${recoveredRefs.split("\n").map((l) => `    ${l}`).join("\n")}`);
  assertEqual(recoveredRefs, sourceRefs, "recovered repo's refs match the source repo byte-exactly (git for-each-ref)");
  const recoveredHead = git(outDir, ["rev-parse", "HEAD"]);
  assertEqual(recoveredHead, finalHead, "recovered repo's HEAD oid matches the source repo's HEAD oid");
  const fsckResult = spawnSync("git", ["fsck", "--full", "--strict"], { cwd: outDir, encoding: "utf8" });
  assertEqual(fsckResult.status, 0, "recovered repo passes `git fsck --full --strict`");

  console.log("\n  Structural proof of zero network dependency: `recover`/`mirror verify`");
  console.log("  never call `this.#client` in the SDK (sdk/src/namespaces/gitvault.ts");
  console.log("  lines 1748-1782) — only mirrorSet/mirrorStatus/mirrorSync do. The dead");
  console.log("  RUN402_API_BASE above is defense-in-depth on top of that structural fact.");

  // ── 5.2a. Torn-mirror probe: delete the newest head (+ admission) ──
  step("5.2a. Torn-mirror probe — delete the newest head + admission record");
  const tornDir1 = join(RECOVER_DIR, "torn-head-copy");
  cpSync(MIRROR_DIR, tornDir1, { recursive: true });
  const headFile = join(tornDir1, "source", repoId, "head", newestGeneration);
  const admissionFile = join(tornDir1, "source", repoId, "admissions", newestGeneration);
  assertTrue(existsSync(headFile), `torn-mirror copy has head/${newestGeneration} before truncation`);
  rmSync(headFile);
  if (existsSync(admissionFile)) rmSync(admissionFile);
  assertTrue(!existsSync(headFile), `head/${newestGeneration} removed from the torn copy`);

  const priorGeneration = generations[generations.length - 2];
  const tornOut1 = join(RECOVER_DIR, "restored-torn-head");
  const tornRecover1 = runCli(
    ["gitvault", "recover", tornDir1, "--out", tornOut1, "--repo", repoId, ...WALLET_ARGS],
    { env: { RUN402_API_BASE: DEAD_API_BASE }, label: "gitvault recover (torn: missing newest head)" },
  );
  console.log(`  recovered_generation: ${tornRecover1.json?.recovered_generation} (expected prior generation ${priorGeneration})`);
  console.log(`  chain_break: ${JSON.stringify(tornRecover1.json?.chain_break)}`);
  assertEqual(tornRecover1.json?.recovered_generation, priorGeneration, "torn mirror (missing newest head) falls back to the PREVIOUS generation");
  assertEqual(tornRecover1.json?.chain_break, null, "torn mirror falls back with chain_break:null (an earlier valid state, never a reported break)");

  // ── 5.2b. Absence-adjudication probe: delete a WAL pack the newest head references ──
  step("5.2b. Absence-adjudication probe — delete a WAL pack referenced by the newest head");
  const tornDir2 = join(RECOVER_DIR, "torn-wal-copy");
  cpSync(MIRROR_DIR, tornDir2, { recursive: true });
  const newestHeadJson = JSON.parse(readFileSync(join(tornDir2, "source", repoId, "head", newestGeneration), "utf8"));
  const walEntries = Array.isArray(newestHeadJson.wal_entries) ? newestHeadJson.wal_entries : [];
  console.log(`  newest head (${newestGeneration}) wal_entries: ${JSON.stringify(walEntries.map((w) => w.object_id))}`);

  if (walEntries.length === 0) {
    console.log("  [SKIP] newest generation carries no wal_entries (likely a checkpoint-form push) — cannot probe WAL absence at this generation.");
    findings.push({ msg: "task 5.2b skipped: newest generation had no wal_entries to truncate", evidence: newestHeadJson });
  } else {
    const targetWalId = walEntries[0].object_id;
    const walFile = join(tornDir2, "source", repoId, "wal", `${targetWalId}.pack.enc`);
    assertTrue(existsSync(walFile), `WAL pack ${targetWalId}.pack.enc exists in the copy before truncation`);
    rmSync(walFile);
    assertTrue(!existsSync(walFile), `WAL pack ${targetWalId}.pack.enc removed from the copy`);

    const tornOut2 = join(RECOVER_DIR, "restored-torn-wal");
    const tornRecover2 = runCli(
      ["gitvault", "recover", tornDir2, "--out", tornOut2, "--repo", repoId, ...WALLET_ARGS],
      { env: { RUN402_API_BASE: DEAD_API_BASE }, allowFail: true, label: "gitvault recover (torn: missing referenced WAL pack)" },
    );
    console.log(`  exit code: ${tornRecover2.code}`);
    console.log(`  recovered_generation: ${tornRecover2.json?.recovered_generation}`);
    console.log(`  data_loss_detected: ${tornRecover2.json?.data_loss_detected}`);
    console.log(`  absences: ${JSON.stringify(tornRecover2.json?.absences)}`);
    if (tornRecover2.json) {
      const namedAbsence = (tornRecover2.json.absences ?? []).find((a) => a.object_id === targetWalId);
      assertTrue(namedAbsence !== undefined, "the missing WAL pack is NAMED in the absences[] list — never a silent skip", tornRecover2.json.absences);
      assertTrue(namedAbsence?.adjudication === "unexplained_absence", "the missing WAL pack is adjudicated unexplained_absence (no covering prune_intent)", namedAbsence);
      assertTrue(tornRecover2.json.data_loss_detected === true, "data_loss_detected is true when an unexplained_absence is present", tornRecover2.json.data_loss_detected);
      // Per design D5: absence adjudication falls back to a generation whose
      // closure does NOT need the missing object (here: the prior generation),
      // and the loss is named on the way there — never silently swallowed.
      assertTrue(
        tornRecover2.json.recovered_generation !== newestGeneration,
        "recovery does not silently land on the newest generation when its own closure is missing an object",
        tornRecover2.json.recovered_generation,
      );
    } else {
      findings.push({
        msg: "gitvault recover (torn WAL) produced no parseable JSON — see stdout/stderr above",
        evidence: { stdout: tornRecover2.stdout, stderr: tornRecover2.stderr, code: tornRecover2.code },
      });
      FAIL++;
    }
  }
}

// These are copied verbatim from sdk/src/namespaces/gitvault.crypto.ts so the
// drill fails loudly if the SOURCE text ever drifts from what ships (rather
// than importing the constant and trivially matching itself).
const GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT_EXPECTED =
  "this recovery proves validity, never freshness — a mirror (or the vault itself) can only tell you the newest generation it happens to hold, never that a newer one does not exist elsewhere";
const GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT_EXPECTED =
  "a mirror without the principal keystore (or an equivalent key) recovers nothing — mirroring ciphertext does not create a second key, and the V0 terminal-loss sentence is unchanged";

async function cleanup() {
  section("Cleanup");
  if (projectId) {
    try {
      const del = runCli(["projects", "delete", projectId, "--confirm", "--wallet", WALLET_NAME], { cwd: REPO_DIR, label: `projects delete ${projectId}` });
      console.log(`  deleted project ${projectId}: ${JSON.stringify(del.json)}`);
    } catch (e) {
      console.log(`  [WARN] failed to delete project ${projectId}: ${e.message}`);
      findings.push({ msg: `cleanup: failed to delete throwaway project ${projectId}`, evidence: e.message });
    }
  } else {
    console.log("  no project was provisioned — nothing to delete");
  }
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  console.log("  scratch directories removed");
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.log(`\n[DRILL ABORTED] ${e.stack || e.message}`);
  findings.push({ msg: "drill aborted with an uncaught error", evidence: e.message });
  FAIL++;
  exitCode = 1;
} finally {
  await cleanup();
}

section("Result");
console.log(`PASS: ${PASS}  FAIL: ${FAIL}`);
if (findings.length > 0) {
  console.log("\nFindings:");
  for (const f of findings) console.log(`  - ${f.msg}${f.evidence !== undefined ? ` :: ${JSON.stringify(f.evidence)}` : ""}`);
}
process.exit(exitCode || (FAIL > 0 ? 1 : 0));
