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
 *   - `push` never changes the vault's HEAD target; the SDK carries it forward.
 *     A fresh vault defaults to `refs/heads/main`, so a first push of some
 *     other branch leaves HEAD naming a ref that does not exist yet. Use
 *     `run402 gitvault push`, which sets the HEAD target from the local HEAD.
 *   - `option dry-run` is `unsupported`: this helper cannot rehearse a
 *     publication, and reporting a fake success would be worse than refusing.
 *   - The repository is discovered from `process.cwd()` (git's own upward
 *     discovery). `hardenedGit` scrubs `GIT_DIR`/`GIT_WORK_TREE` on purpose, so
 *     an invocation from outside the work tree is not supported.
 */

import { createInterface } from "node:readline";
import { getSdk } from "./lib/sdk.mjs";
import { parseGitvaultRemoteUrl } from "#sdk";
import { hardenedGit } from "#sdk/node";

const out = (line) => process.stdout.write(`${line}\n`);
/** Every helper response block is terminated by a blank line. */
const endBlock = () => process.stdout.write("\n");
const note = (line) => process.stderr.write(`git-remote-run402: ${line}\n`);

/** Protocol lines are single-line: collapse anything that could break framing. */
function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function describeError(err) {
  const code = err?.code ?? err?.body?.code ?? null;
  const message = err?.message ?? err?.body?.message ?? String(err);
  return oneLine(code ? `${code}: ${message}` : message);
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

async function main(argv) {
  const address = resolveRemoteAddress(argv);
  if (!address) {
    note(`could not read a run402 remote address from ${JSON.stringify(argv.join(" "))} — expected run402::<org_id>/<project_id>`);
    return 1;
  }

  const repoDir = process.cwd();
  const target = { project_id: address.project_id, repo_dir: repoDir };
  let verbosity = 1;

  /** Open the vault lazily — `capabilities` and `option` must never touch the network. */
  const openVault = async () => (await getSdk().gitvault.open(target)).vault;

  async function runList() {
    const state = await (await openVault()).materialize();
    const refs = state.refs ?? {};
    for (const ref of Object.keys(refs).sort()) out(`${refs[ref]} ${ref}`);
    const head = state.head_target;
    // A symref is only advertised when its target is actually present:
    // pointing HEAD at a ref that does not exist is what an empty repository
    // looks like, and git reads the empty list correctly on its own.
    if (head?.kind === "symref" && Object.prototype.hasOwnProperty.call(refs, head.ref)) out(`@${head.ref} HEAD`);
    else if (head?.kind === "detached") out(`${head.oid} HEAD`);
    endBlock();
  }

  async function runFetch(batch) {
    if (verbosity >= 1) note(`restoring the vault object database for ${batch.length} ref(s)`);
    const restored = await getSdk().gitvault.restore({ ...target, target_dir: repoDir });
    if (verbosity >= 1) note(`restored generation ${restored.generation}`);
    endBlock();
  }

  async function runPush(batch) {
    const specs = batch.map(parsePushSpec);
    try {
      const vault = await openVault();
      const base = await vault.materialize();
      const updates = [];
      for (const spec of specs) {
        const expectedOld = base.refs?.[spec.dst] ?? null;
        // A deletion carries an empty <src>. Everything else is resolved by
        // git itself; `--end-of-options` keeps a hostile refname from being
        // read as a flag.
        const newOid = spec.src === ""
          ? null
          : (await hardenedGit(repoDir, ["rev-parse", "--verify", "--end-of-options", spec.src])).text().trim();
        updates.push({
          ref: spec.dst,
          expected_old_oid: expectedOld,
          new_oid: newOid,
          // Force-with-lease still requires a lease, so a CREATE is never
          // forced. The SDK owns what force actually permits.
          force: spec.force && expectedOld !== null,
        });
      }
      // ONE transaction for the whole batch: the SDK evaluates fast-forward,
      // tag immutability, protocol-ref refusal and retention roots, builds the
      // packs, and publishes — all or nothing.
      const published = await vault.push({ transaction: { updates } });
      if (verbosity >= 1) note(`published generation ${published.generation} (${published.form})`);
      for (const spec of specs) out(`ok ${spec.dst}`);
    } catch (err) {
      // The transaction is atomic, so a failure failed every ref in it. Report
      // it against each one rather than letting some look like they landed.
      const reason = describeError(err);
      for (const spec of specs) out(`error ${spec.dst} ${reason}`);
    }
    endBlock();
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
      default:
        // Includes dry-run, object-format, depth, cloning, check-connectivity,
        // followtags, pushcert: honestly unsupported rather than acknowledged.
        out("unsupported");
    }
  }

  let fetchBatch = [];
  let pushBatch = [];

  async function flushBatches() {
    if (fetchBatch.length > 0) {
      const batch = fetchBatch;
      fetchBatch = [];
      await runFetch(batch);
      return;
    }
    if (pushBatch.length > 0) {
      const batch = pushBatch;
      pushBatch = [];
      await runPush(batch);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        await flushBatches();
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
    await flushBatches();
    return 0;
  } finally {
    rl.close();
  }
}

// Never `process.exit()` mid-stream: that can truncate a pending stdout write
// on a pipe, which git reads as a protocol violation. Set the code and let Node
// flush and exit on its own.
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { note(describeError(err)); process.exitCode = 1; },
);
