/**
 * `git-remote-kygit` — the `kygit::` remote helper forwarder (design D8,
 * kygit-handoff).
 *
 * The behavioral claim under test is that this ~30-line forwarder reaches
 * the REAL `git-remote-run402.mjs` and gets a byte-identical answer over the
 * actual remote-helper wire protocol — proving the exec chain (resolve →
 * spawn → stdio-inherit) genuinely works, not just that it compiles. This
 * mirrors `cli-gitvault-remote-helper.test.mjs`'s own
 * "capabilities still answers with no repository at all" probe, run through
 * the forwarder instead of the helper directly.
 *
 * Run: npm test --workspace=kygit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHelperPath } from "./git-remote-kygit.mjs";

const FORWARDER = fileURLToPath(new URL("./git-remote-kygit.mjs", import.meta.url));
/** A closed port: any network attempt fails loudly and unmistakably. */
const DEAD_API = "http://127.0.0.1:9";
const ADDRESS = "11111111-1111-4111-8111-111111111111/prj_test";

function runForwarder({ cwd, env = {}, stdin }) {
  return spawnSync(process.execPath, [FORWARDER, "kygit", ADDRESS], {
    cwd,
    input: stdin,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      RUN402_API_BASE: DEAD_API,
      RUN402_CONFIG_DIR: env.RUN402_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), "kygit-grk-cfg-")),
      // In-process host, deterministically — same reasoning as the
      // run402-side fixture: a fresh config dir per call would otherwise
      // spawn a fresh daemon per call.
      RUN402_DAEMON: "0",
      ...env,
    },
  });
}

describe("resolveHelperPath — parity by construction", () => {
  it("resolves the REAL workspace sibling's remote-helper entry", () => {
    const path = resolveHelperPath();
    assert.ok(path.endsWith("git-remote-run402.mjs"), path);
  });

  it("throws when the run402 package cannot be resolved", () => {
    assert.throws(() =>
      resolveHelperPath({
        resolve() {
          throw new Error("Cannot find module 'run402/cli/git-remote-run402.mjs'");
        },
      }),
    );
  });
});

describe("git-remote-kygit — forwards to the real git-remote-run402 over the wire protocol", () => {
  it("capabilities answers with no repository at all, byte-identical to the run402 helper", () => {
    const root = mkdtempSync(join(tmpdir(), "kygit-grk-caps-"));
    try {
      const r = runForwarder({ cwd: root, env: { GIT_DIR: undefined }, stdin: "capabilities\n\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "fetch\npush\noption\n\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates a non-zero exit code from the forwarded process", () => {
    const root = mkdtempSync(join(tmpdir(), "kygit-grk-fail-"));
    try {
      // No GIT_DIR and a repository-scoped command: the real helper refuses
      // (GIT_INVOCATION_REPO_UNRESOLVED) rather than touching cwd — this
      // proves the forwarder propagates a REAL non-zero status, not just a
      // hardcoded 0/1.
      const r = runForwarder({
        cwd: root,
        env: { GIT_DIR: undefined },
        stdin: "capabilities\n\nfetch 0000000000000000000000000000000000000000 refs/heads/main\n\n",
      });
      assert.notEqual(r.status, 0, r.stderr);
      assert.match(r.stderr, /GIT_INVOCATION_REPO_UNRESOLVED/, r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("git-remote-kygit — the one-package cold install (npm i -g @kychee/kygit alone)", () => {
  // npm installs EVERY bin of a DIRECTLY-installed package as a symlink —
  // this is the real shape `npm i -g @kychee/kygit` alone produces for BOTH
  // `kygit` and `git-remote-kygit` (kygit.test.mjs pins the same shape for
  // the `kygit` bin under the heading "the 0.1.0 regression": a naive
  // invoked-directly guard comparing the symlink path to import.meta.url
  // silently no-ops for every real install). Proving `git-remote-kygit`
  // survives it too — AND that it still finds the real run402 helper with
  // nothing else installed globally — is the behavioral claim behind
  // "one package, one install" in kygit/README.md.
  it("answers real remote-helper protocol traffic when invoked through a bin-style symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "kygit-grk-bin-"));
    const root = mkdtempSync(join(tmpdir(), "kygit-grk-bin-cwd-"));
    try {
      const link = join(dir, "git-remote-kygit");
      symlinkSync(realpathSync(FORWARDER), link);
      const r = spawnSync(process.execPath, [link, "kygit", ADDRESS], {
        cwd: root,
        input: "capabilities\n\n",
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          RUN402_API_BASE: DEAD_API,
          RUN402_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kygit-grk-bin-cfg-")),
          RUN402_DAEMON: "0",
          GIT_DIR: undefined,
        },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "fetch\npush\noption\n\n", "a silent no-op (the 0.1.0 regression shape) would print nothing and still exit 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("git-remote-kygit — wiring (source-pinned, mirrors kygit.test.mjs's own convention)", () => {
  it("sets RUN402_REMOTE_SCHEME=kygit on the forwarded process's environment", () => {
    const src = readFileSync(fileURLToPath(new URL("./git-remote-kygit.mjs", import.meta.url)), "utf8");
    assert.match(src, /RUN402_REMOTE_SCHEME:\s*"kygit"/);
  });

  it("passes argv through unchanged — no flag rewriting, no argument insertion", () => {
    const src = readFileSync(fileURLToPath(new URL("./git-remote-kygit.mjs", import.meta.url)), "utf8");
    assert.match(src, /\[helperPath, \.\.\.process\.argv\.slice\(2\)\]/);
  });

  it("inherits stdio — the protocol stream is never buffered or reparsed here", () => {
    const src = readFileSync(fileURLToPath(new URL("./git-remote-kygit.mjs", import.meta.url)), "utf8");
    assert.match(src, /stdio:\s*"inherit"/);
  });

  it("resolve failure never calls process.exit() mid-stream — sets exitCode and returns", () => {
    const src = readFileSync(fileURLToPath(new URL("./git-remote-kygit.mjs", import.meta.url)), "utf8");
    assert.equal(src.includes("process.exit("), false, "must use process.exitCode, never process.exit(), so a pending stdout write is never truncated mid-protocol-stream");
  });
});
