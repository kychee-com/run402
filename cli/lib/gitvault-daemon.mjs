/**
 * The resident helper engine (gitvault-persistent-helper D2–D6).
 *
 * Holds the WARM things — the loaded session module (whose top-level await
 * pulls the whole SDK graph), the owned dispatcher's live h2 connection,
 * signer precomputation, the paid stack — and re-reads the SMALL things
 * (keystore, pins, wallet binding, allowance, env-derived config) fresh per
 * forwarded session, so no cache-invalidation class exists (D2).
 *
 * SINGLE-SESSION BY DESIGN (D6 as applied): a session is {cwd, env}
 * applied to THIS process (`process.chdir` + an env allowlist swap), and
 * the SDK reads both at call time throughout — two concurrent sessions
 * with different cwd/env would race process-global state. Concurrent git
 * helpers are rare; a `busy` rejection makes the second client fall back
 * in-process, which is exactly today's behavior. Correct and boring beats
 * clever here.
 *
 * Lifecycle (D4): idle exit after 15 minutes; the socket path is keyed by
 * CLI version so an upgraded client never reaches this daemon; a `hello`
 * carrying a different version or protocol is rejected (the client falls
 * back and spawns a fresh daemon at ITS path). Trust boundary (D5): the
 * socket lives in the 0700 config dir, 0600 where the OS honors socket
 * modes; no network listener exists or ever will in this module.
 */
import net from "node:net";
import { mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { daemonDir, daemonSocketPath, DAEMON_PROTOCOL_VERSION, cliVersion, forwardableEnv } from "./daemon-path.mjs";
import { PassThrough } from "node:stream";

const IDLE_EXIT_MS = 15 * 60 * 1000;

function frame(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/** Swap the allowlisted env to the session's view; returns a restore fn. */
function applySessionEnv(sessionEnv) {
  const mine = forwardableEnv(process.env);
  const keys = new Set([...Object.keys(mine), ...Object.keys(sessionEnv)]);
  for (const k of keys) {
    if (k in sessionEnv) process.env[k] = sessionEnv[k];
    else delete process.env[k];
  }
  return () => {
    for (const k of new Set([...keys, ...Object.keys(forwardableEnv(process.env))])) {
      if (k in mine) process.env[k] = mine[k];
      else delete process.env[k];
    }
  };
}

export async function runDaemon() {
  // Load the heavy module ONCE — this is the entire point of residency.
  // Its top-level await pulls the SDK graph; the prewarm dials the API
  // origin so the first forwarded session rides a warm h2 connection.
  const { prewarmGitvaultConnection } = await import("../sdk/dist/node/gitvault-prewarm.js");
  prewarmGitvaultConnection();
  const { runHelperSession } = await import("./remote-helper-session.mjs");

  const socketPath = daemonSocketPath();
  if (process.platform !== "win32") {
    mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  }

  let busy = false;
  let sessionsServed = 0;
  const startedAt = Date.now();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (busy) {
        // Never exit under a live session — re-arm and check again later.
        armIdle();
        return;
      }
      try {
        server.close();
        if (process.platform !== "win32") unlinkSync(socketPath);
      } catch {
        /* exiting anyway */
      }
      process.exit(0);
    }, IDLE_EXIT_MS);
    idleTimer.unref?.();
  };

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    armIdle();
    let buf = "";
    let session = null; // { stdin, restoreEnv, restoreCwd, restoreWrites, backgroundWork }

    const send = (obj) => {
      try {
        socket.write(frame(obj));
      } catch {
        /* client gone — session teardown happens on 'close' */
      }
    };

    /**
     * gitvault-checkpoint-cadence design D2: `session.backgroundWork` — set
     * by `onBackgroundWork` below when a push's auto-gc cycle was handed
     * off — is a promise this daemon keeps itself alive for BEFORE
     * restoring env/cwd/`busy`, even though the CLIENT already got its
     * `exit` and the socket is already ending. `session` is cleared and
     * write-redirection restored immediately and SYNCHRONOUSLY (so a stray
     * log line from the background cycle lands on the daemon's own
     * stdout/stderr, never an attempt to write into an already-closing
     * socket) — only `busy`/env/cwd/idle-arming wait on the promise. This
     * is what "keep the daemon alive through it" means structurally:
     * `busy` stays `true` (refusing a new `hello`, and holding off
     * idle-exit) for the ENTIRE compaction, not just the git protocol
     * exchange that preceded it — the single-session invariant this
     * module's whole design rests on would otherwise race a NEW session's
     * env/cwd swap against the still-running compaction's own SDK calls.
     * `backgroundWork` itself never rejects (`maybeRunAutoGc` swallows the
     * cycle's own failure before handing the promise off) — the `catch`
     * here is belt-and-suspenders, not a real error path.
     */
    const teardown = async () => {
      if (!session) return;
      const s = session;
      session = null;
      try {
        s.stdin.end();
      } catch {
        /* already ended */
      }
      s.restoreWrites();
      if (s.backgroundWork) {
        await s.backgroundWork.catch(() => undefined);
      }
      busy = false;
      s.restoreEnv();
      s.restoreCwd();
      armIdle();
    };
    socket.on("close", () => {
      void teardown();
    });
    socket.on("error", () => socket.destroy());

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
          socket.destroy();
          return;
        }
        if (msg.t === "hello") {
          if (msg.proto !== DAEMON_PROTOCOL_VERSION || msg.version !== cliVersion()) {
            send({ t: "reject", reason: "version" });
            socket.end();
            return;
          }
          if (busy) {
            // D6: one session at a time — the client falls back in-process,
            // which is exactly the pre-daemon behavior.
            send({ t: "reject", reason: "busy" });
            socket.end();
            return;
          }
          busy = true;
          sessionsServed += 1;
          const stdin = new PassThrough();
          const restoreEnv = applySessionEnv(msg.env ?? {});
          const prevCwd = process.cwd();
          let restoreCwd = () => {};
          try {
            process.chdir(msg.cwd);
            restoreCwd = () => {
              try {
                process.chdir(prevCwd);
              } catch {
                /* prev dir may be gone; daemon cwd is inert between sessions */
              }
            };
          } catch {
            restoreEnv();
            busy = false;
            send({ t: "reject", reason: "cwd" });
            socket.end();
            return;
          }
          // Redirect BOTH write streams for the session's duration: the
          // session's own out()/note() and every SDK trace/warn line reach
          // the CLIENT, exactly as they reach a standalone helper's pipes.
          const realOut = process.stdout.write.bind(process.stdout);
          const realErr = process.stderr.write.bind(process.stderr);
          const toBuffer = (data, rest) => (typeof data === "string" ? Buffer.from(data, typeof rest[0] === "string" ? rest[0] : "utf8") : Buffer.from(data));
          process.stdout.write = (data, ...rest) => {
            send({ t: "out", d: toBuffer(data, rest).toString("base64") });
            rest.find((a) => typeof a === "function")?.();
            return true;
          };
          process.stderr.write = (data, ...rest) => {
            send({ t: "err", d: toBuffer(data, rest).toString("base64") });
            rest.find((a) => typeof a === "function")?.();
            return true;
          };
          const restoreWrites = () => {
            process.stdout.write = realOut;
            process.stderr.write = realErr;
          };
          session = { stdin, restoreEnv, restoreCwd, restoreWrites, backgroundWork: null };
          send({ t: "ready" });
          // gitvault-checkpoint-cadence design D2: a push's auto-gc cycle
          // (if triggered) hands its ALREADY-STARTED promise here instead
          // of being awaited inline — `runHelperSession` itself still
          // resolves at push speed, so `exit`/`socket.end()` below reach
          // the client immediately; `teardown()` is what actually waits on
          // it (see its own doc comment) before this daemon looks idle or
          // accepts a new session.
          runHelperSession(Array.isArray(msg.argv) ? msg.argv : [], {
            stdin,
            onBackgroundWork: (promise) => {
              if (session) session.backgroundWork = promise;
            },
          })
            .then((code) => {
              send({ t: "exit", code });
              socket.end();
              void teardown();
            })
            .catch(() => {
              send({ t: "exit", code: 1 });
              socket.end();
              void teardown();
            });
        } else if (msg.t === "in") {
          session?.stdin.write(Buffer.from(msg.d, "base64"));
        } else if (msg.t === "in_end") {
          session?.stdin.end();
        } else if (msg.t === "status") {
          send({ t: "status", version: cliVersion(), proto: DAEMON_PROTOCOL_VERSION, pid: process.pid, started_at: startedAt, sessions_served: sessionsServed, busy });
          socket.end();
        } else if (msg.t === "stop") {
          send({ t: "stopping" });
          socket.end();
          try {
            server.close();
            if (process.platform !== "win32") unlinkSync(socketPath);
          } catch {
            /* exiting anyway */
          }
          process.exit(0);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    const tryListen = (attempt) => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt === 0 && process.platform !== "win32") {
          // A live daemon OR a stale socket file from a crash. Probe it: a
          // refused connection means stale — unlink and take the address.
          const probe = net.connect(socketPath);
          probe.once("connect", () => {
            probe.destroy();
            reject(new Error("daemon already running"));
          });
          probe.once("error", () => {
            try {
              unlinkSync(socketPath);
            } catch {
              /* raced */
            }
            tryListen(1);
          });
        } else {
          reject(err);
        }
      });
      server.listen(socketPath, () => {
        if (process.platform !== "win32") {
          try {
            chmodSync(socketPath, 0o600);
          } catch {
            /* the 0700 parent dir is the real boundary */
          }
        }
        resolve();
      });
    };
    tryListen(0);
  });

  armIdle();
  return server;
}
