#!/usr/bin/env node
/**
 * `git-remote-run402` — the THIN CLIENT (gitvault-persistent-helper).
 *
 * git spawns a fresh helper process per remote operation, so everything warm
 * dies per command — Node boot, the SDK graph, the signer, the paid stack,
 * and the API connection. This entry therefore does as little as possible:
 * it tries to forward the whole session (argv, cwd, an env allowlist, and
 * stdio) to the per-config-dir resident daemon over a local socket, and ONLY
 * when that is impossible does it load the full session module and run
 * in-process — which is byte-identical to the pre-daemon behavior.
 *
 * INVARIANTS (spec: gitvault-client-surface, "A resident helper engine…"):
 *   - The daemon is never load-bearing: any failure to use it — absent,
 *     busy, stale, mismatched, dying mid-handshake — falls back silently to
 *     the in-process path. The handshake completes BEFORE this client
 *     commits to the daemon (before one byte of stdin is consumed), so
 *     fallback never replays a half-consumed session.
 *   - The fast path stays THIN, mechanically: its import graph is node
 *     builtins + `./lib/daemon-path.mjs` only, pinned by a source-level
 *     gate test (design D7). The heavy graph loads only on fallback.
 *   - `RUN402_DAEMON=0` disables the daemon entirely (dev/CI toggle,
 *     positively named, default on, only "0" disables); any other value
 *     behaves as unset.
 *
 * The remote-helper doctrine (fail-closed repository resolution, wallet
 * selection, protocol semantics) lives with the session implementation in
 * `cli/lib/remote-helper-session.mjs` — ONE implementation, two hosts.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as nodeModule from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";
import { daemonSocketPath, daemonRunnerPath, DAEMON_PROTOCOL_VERSION, cliVersion, forwardableEnv } from "./lib/daemon-path.mjs";

// gitvault-startup-amortization (D2): on-disk V8 compile cache for every
// module loaded from here on. Feature-guarded (Node 22.8+) and try/caught
// (a read-only install dir degrades silently).
try {
  nodeModule.enableCompileCache?.();
} catch {
  /* silent by contract */
}

const CONNECT_TIMEOUT_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 750;

/** Frame codec: newline-delimited JSON; binary rides base64. */
function frame(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * Try to run the whole session through the resident daemon. Resolves the
 * process exit code on success, or `null` for "fall back in-process" — the
 * ONLY two outcomes; nothing here ever surfaces an error of its own.
 * Not one byte of stdin is consumed before the daemon says `ready`.
 */
function tryDaemonSession(argv) {
  return new Promise((resolve) => {
    let settled = false;
    let committed = false; // ready received — stdin piping started, no fallback past here
    const socketPath = (() => {
      try {
        return daemonSocketPath();
      } catch {
        return null;
      }
    })();
    if (!socketPath) return resolve(null);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      // After a DAEMON-served session, a resumed stdin would hold the
      // process open. On FALLBACK (value === null) stdin must stay exactly
      // as git handed it to us — the in-process session is about to read
      // it, and an unref'd stdin lets the event loop drain mid-session
      // (observed live: "unsettled top-level await" + git exit 128).
      if (value !== null) {
        try {
          process.stdin.pause();
          process.stdin.unref?.();
        } catch {
          /* never fatal */
        }
      }
      resolve(value);
    };

    const socket = net.connect(socketPath);
    socket.setNoDelay(true);
    const connectTimer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
    let handshakeTimer = null;
    socket.once("error", () => (committed ? finish(1) : finish(null)));
    socket.once("close", () => {
      // A close after `exit` already resolved is normal; a close mid-session
      // is the crashed-helper shape (D3) — surface exit 1, never a hang.
      if (committed) finish(1);
      else finish(null);
    });
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      handshakeTimer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
      socket.write(
        frame({
          t: "hello",
          proto: DAEMON_PROTOCOL_VERSION,
          version: cliVersion(),
          argv,
          cwd: process.cwd(),
          env: forwardableEnv(process.env),
        }),
      );
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(committed ? 1 : null);
        }
        if (msg.t === "ready") {
          clearTimeout(handshakeTimer);
          committed = true;
          // Only NOW does stdin start flowing — fallback before this point
          // replays the session from byte zero (D3).
          process.stdin.on("data", (d) => socket.write(frame({ t: "in", d: d.toString("base64") })));
          process.stdin.on("end", () => socket.write(frame({ t: "in_end" })));
          process.stdin.resume();
        } else if (msg.t === "reject") {
          return finish(null);
        } else if (msg.t === "out") {
          process.stdout.write(Buffer.from(msg.d, "base64"));
        } else if (msg.t === "err") {
          process.stderr.write(Buffer.from(msg.d, "base64"));
        } else if (msg.t === "exit") {
          return finish(typeof msg.code === "number" ? msg.code : 1);
        }
      }
    });
  });
}

/** Best-effort, detached, single-shot daemon spawn so the NEXT invocation is warm. */
function spawnDaemon() {
  try {
    const child = spawn(process.execPath, [daemonRunnerPath()], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* the daemon is an accelerator, never a dependency */
  }
}

// Symlink-safe invoked-directly guard — unchanged from the pre-daemon entry
// (4.39.0 shipped without realpath and the helper silently no-opped for every
// real npm install, where the bin is a symlink).
const invokedDirectly = (() => {
  try {
    if (process.argv[1] === undefined) return false;
    const argvReal = (() => {
      try {
        return realpathSync(process.argv[1]);
      } catch {
        return process.argv[1];
      }
    })();
    return import.meta.url === pathToFileURL(argvReal).href;
  } catch {
    return false;
  }
})();

// Never `process.exit()` mid-stream: that can truncate a pending stdout write
// on a pipe, which git reads as a protocol violation. Set the code and let
// Node flush and exit on its own.
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const daemonEnabled = process.env.RUN402_DAEMON !== "0";
  const code = daemonEnabled ? await tryDaemonSession(argv) : null;
  if (code !== null) {
    process.exitCode = code;
  } else {
    // Fallback: today's in-process path, byte-identical. Fire the prewarm
    // BEFORE the heavy graph evaluates (gitvault-startup-amortization D1),
    // and leave a daemon behind for next time.
    if (daemonEnabled) spawnDaemon();
    const { prewarmGitvaultConnection } = await import("./sdk/dist/node/gitvault-prewarm.js");
    prewarmGitvaultConnection();
    const { runHelperSession } = await import("./lib/remote-helper-session.mjs");
    process.exitCode = await runHelperSession(argv);
  }
}
