/**
 * gitvault-persistent-helper — the resident engine's behavioral contract
 * (tasks 3.1/3.3 + design D7).
 *
 * Equivalence is the whole game: a session served by the daemon must be
 * byte-identical to the same session served in-process, and every way the
 * daemon can be unusable must degrade to in-process silently. The protocol
 * scripts here deliberately reuse the shapes `cli-gitvault-remote-helper.
 * test.mjs` pins in-process, so the two suites together are the both-hosts
 * matrix.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { daemonSocketPath, DAEMON_PROTOCOL_VERSION, cliVersion } from "./cli/lib/daemon-path.mjs";

const HELPER = fileURLToPath(new URL("./cli/git-remote-run402.mjs", import.meta.url));
const DAEMON_RUNNER = fileURLToPath(new URL("./cli/lib/gitvault-daemon-run.mjs", import.meta.url));
const DEAD_API = "http://127.0.0.1:9";
const ADDRESS = "11111111-1111-4111-8111-111111111111/prj_test";

function socketPathFor(configDir) {
  const prev = process.env.RUN402_CONFIG_DIR;
  process.env.RUN402_CONFIG_DIR = configDir;
  try {
    return daemonSocketPath();
  } finally {
    if (prev === undefined) delete process.env.RUN402_CONFIG_DIR;
    else process.env.RUN402_CONFIG_DIR = prev;
  }
}

/** Drive the helper binary exactly as git does; `daemon` picks the host. */
function runHelper({ configDir, stdin, env = {}, daemon }) {
  return spawnSync(process.execPath, [HELPER, "run402", ADDRESS], {
    input: stdin,
    encoding: "utf-8",
    // Windows CI gets a wider cap: the in-process arm's cold NTFS + AV disk
    // load of the SDK graph was measured at 9.3s on a green run and >30s on
    // a cold runner (run 33414903319) — the cap should catch a genuine hang,
    // not a slow disk.
    timeout: process.platform === "win32" ? 120_000 : 30_000,
    env: {
      ...process.env,
      RUN402_API_BASE: DEAD_API,
      RUN402_CONFIG_DIR: configDir,
      RUN402_DAEMON: daemon ? "1" : "0",
      ...env,
    },
  });
}

function startDaemon(configDir) {
  const child = spawn(process.execPath, [DAEMON_RUNNER], {
    env: { ...process.env, RUN402_API_BASE: DEAD_API, RUN402_CONFIG_DIR: configDir },
    stdio: "ignore",
  });
  const sock = socketPathFor(configDir);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      const probe = net.connect(sock);
      probe.once("connect", () => {
        probe.destroy();
        resolve({ child, sock });
      });
      probe.once("error", () => {
        if (Date.now() > deadline) reject(new Error("daemon never came up"));
        else setTimeout(poll, 100);
      });
    };
    setTimeout(poll, 100);
  });
}

function sendFrames(sock, frames, { holdOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    let data = "";
    socket.on("data", (c) => {
      data += c.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      for (const f of frames) socket.write(`${JSON.stringify(f)}\n`);
    });
    if (holdOpen) {
      setTimeout(() => resolve({ socket, data: () => data }), 300);
    } else {
      socket.once("close", () => resolve({ socket: null, data: () => data }));
      setTimeout(() => socket.end(), 500);
    }
  });
}

describe("gitvault daemon — equivalence with the in-process host (task 3.1)", () => {
  let cfg;
  let daemon;
  before(async () => {
    cfg = mkdtempSync(join(tmpdir(), "run402-gvd-eq-"));
    daemon = await startDaemon(cfg);
  });
  after(() => {
    daemon?.child.kill();
    rmSync(cfg, { recursive: true, force: true });
  });

  // The protocol scripts the in-process suite pins, re-driven through BOTH
  // hosts here and diffed byte-for-byte.
  const SCRIPTS = [
    ["capabilities", "capabilities\n\n"],
    ["unknown command", "definitely-not-a-command\n"],
    ["option verbosity", "option verbosity 2\ncapabilities\n\n"],
    ["fetch outside a repository (fail-closed)", "fetch 0000000000000000000000000000000000000000 refs/heads/main\n\n"],
  ];

  for (const [label, stdin] of SCRIPTS) {
    it(`"${label}" is byte-identical across hosts`, () => {
      const viaDaemon = runHelper({ configDir: cfg, stdin, daemon: true });
      const inProcess = runHelper({ configDir: cfg, stdin, daemon: false });
      assert.equal(viaDaemon.stdout, inProcess.stdout, "stdout");
      assert.equal(viaDaemon.stderr, inProcess.stderr, "stderr");
      assert.equal(viaDaemon.status, inProcess.status, "exit code");
    });
  }

  it("the daemon genuinely served the equivalence sessions (not double-fallback)", async () => {
    const res = await sendFrames(daemon.sock, [{ t: "status" }]);
    const status = JSON.parse(res.data().trim().split("\n").pop());
    assert.ok(status.sessions_served >= SCRIPTS.length, `daemon served ${status.sessions_served} sessions — the equivalence runs must have gone THROUGH it, or the comparison proves nothing`);
  });

  it("per-invocation env is re-read fresh per session (D2 staleness)", () => {
    // GIT_DIR names a repository for session 2 only — if the daemon served
    // session 2 with session 1's env, both would fail identically.
    const repo = mkdtempSync(join(tmpdir(), "run402-gvd-repo-"));
    spawnSync("git", ["init", "-q", "--bare", repo]);
    const withoutRepo = runHelper({ configDir: cfg, stdin: "fetch 0000000000000000000000000000000000000000 refs/heads/main\n\n", daemon: true });
    const withRepo = runHelper({ configDir: cfg, stdin: "fetch 0000000000000000000000000000000000000000 refs/heads/main\n\n", daemon: true, env: { GIT_DIR: repo } });
    assert.notEqual(withoutRepo.stderr, withRepo.stderr, "the two sessions must observe different repository resolutions");
    rmSync(repo, { recursive: true, force: true });
  });

  it("a busy daemon rejects and the client completes in-process anyway (D6)", async () => {
    // Occupy the daemon with a held-open session…
    const held = await sendFrames(daemon.sock, [{ t: "hello", proto: DAEMON_PROTOCOL_VERSION, version: cliVersion(), argv: ["run402", ADDRESS], cwd: process.cwd(), env: {} }], { holdOpen: true });
    assert.match(held.data(), /"t":"ready"/, "the held session must own the daemon");
    try {
      const result = runHelper({ configDir: cfg, stdin: "capabilities\n\n", daemon: true });
      assert.match(result.stdout, /fetch\n/, "the busy-rejected client must still answer capabilities");
      assert.equal(result.status, 0);
    } finally {
      held.socket.destroy();
    }
  });

  it("status + stop frames work and stop removes the socket", async () => {
    const cfg2 = mkdtempSync(join(tmpdir(), "run402-gvd-stop-"));
    const d2 = await startDaemon(cfg2);
    const status = await sendFrames(d2.sock, [{ t: "status" }]);
    assert.match(status.data(), new RegExp(`"version":"${cliVersion().replace(/\./g, "\\.")}"`));
    await sendFrames(d2.sock, [{ t: "stop" }]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(d2.sock), false, "stop must remove the socket");
    d2.child.kill();
    rmSync(cfg2, { recursive: true, force: true });
  });
});

describe("gitvault daemon — fallback matrix (task 3.3)", () => {
  it("no daemon + RUN402_DAEMON=0: pure in-process, no socket created", () => {
    const cfg = mkdtempSync(join(tmpdir(), "run402-gvd-off-"));
    const result = runHelper({ configDir: cfg, stdin: "capabilities\n\n", daemon: false });
    assert.match(result.stdout, /fetch\n/);
    assert.equal(existsSync(socketPathFor(cfg)), false, "RUN402_DAEMON=0 must not spawn anything");
    rmSync(cfg, { recursive: true, force: true });
  });

  /** A stub listener standing where the daemon would: each variant breaks differently. */
  function withStub(behavior, fn) {
    const cfg = mkdtempSync(join(tmpdir(), "run402-gvd-stub-"));
    const sock = socketPathFor(cfg);
    spawnSync("mkdir", ["-p", join(sock, "..")]);
    const server = net.createServer((socket) => behavior(socket));
    return new Promise((resolve, reject) => {
      server.listen(sock, async () => {
        try {
          resolve(await fn(cfg));
        } catch (e) {
          reject(e);
        } finally {
          server.close();
          rmSync(cfg, { recursive: true, force: true });
        }
      });
    });
  }

  it("a daemon that rejects (wrong version shape) → silent in-process completion", async () => {
    await withStub(
      (socket) => socket.on("data", () => socket.end(`${JSON.stringify({ t: "reject", reason: "version" })}\n`)),
      async (cfg) => {
        const result = runHelper({ configDir: cfg, stdin: "capabilities\n\n", daemon: true });
        assert.match(result.stdout, /fetch\n/);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stderr, /daemon/i, "fallback must be silent");
      },
    );
  });

  it("a daemon that accepts and never answers → handshake timeout → in-process", async () => {
    await withStub(
      () => {},
      async (cfg) => {
        const result = runHelper({ configDir: cfg, stdin: "capabilities\n\n", daemon: true });
        assert.match(result.stdout, /fetch\n/);
        assert.equal(result.status, 0);
      },
    );
  });

  it("a daemon that dies on connect → in-process", async () => {
    await withStub(
      (socket) => socket.destroy(),
      async (cfg) => {
        const result = runHelper({ configDir: cfg, stdin: "capabilities\n\n", daemon: true });
        assert.match(result.stdout, /fetch\n/);
        assert.equal(result.status, 0);
      },
    );
  });

  it("the real daemon rejects a WRONG-VERSION hello at the protocol level", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "run402-gvd-ver-"));
    const d = await startDaemon(cfg);
    const res = await sendFrames(d.sock, [{ t: "hello", proto: DAEMON_PROTOCOL_VERSION, version: "0.0.0-not-this", argv: [], cwd: process.cwd(), env: {} }]);
    assert.match(res.data(), /"t":"reject"/);
    assert.match(res.data(), /"reason":"version"/);
    d.child.kill();
    rmSync(cfg, { recursive: true, force: true });
  });
});

describe("gitvault daemon — trust boundary + thin fast path (D5/D7)", () => {
  it("the socket and its directory carry owner-only permissions", { skip: process.platform === "win32" }, async () => {
    const cfg = mkdtempSync(join(tmpdir(), "run402-gvd-perm-"));
    const d = await startDaemon(cfg);
    assert.equal(statSync(d.sock).mode & 0o777, 0o600, "socket 0600");
    assert.equal(statSync(join(d.sock, "..")).mode & 0o777, 0o700, "daemon dir 0700");
    await sendFrames(d.sock, [{ t: "stop" }]);
    d.child.kill();
    rmSync(cfg, { recursive: true, force: true });
  });

  it("the socket path is keyed by CLI version", () => {
    assert.ok(daemonSocketPath().includes(cliVersion().replace(/[^0-9A-Za-z.]/g, "_")), "a CLI upgrade must resolve a different daemon address");
  });

  it("the thin fast path's STATIC import graph is node builtins + daemon-path only (D7 gate)", () => {
    const src = readFileSync(HELPER, "utf-8");
    const staticImports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    for (const spec of staticImports) {
      assert.ok(spec.startsWith("node:") || spec === "./lib/daemon-path.mjs", `thin-path import "${spec}" widens the fast path — the whole projected win is this graph staying empty. Load it dynamically on the fallback branch instead.`);
    }
    const pathSrc = readFileSync(fileURLToPath(new URL("./cli/lib/daemon-path.mjs", import.meta.url)), "utf-8");
    for (const m of pathSrc.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("node:"), `daemon-path.mjs import "${m[1]}" must be a node builtin`);
    }
  });
});
