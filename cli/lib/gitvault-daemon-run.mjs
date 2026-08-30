/**
 * Daemon process entry (gitvault-persistent-helper) — spawned detached by
 * the thin client's fallback path; never invoked by users directly. Enables
 * the compile cache (the daemon compiles the heavy graph exactly once, so
 * this mostly benefits the NEXT daemon after an upgrade), then runs the
 * listener. A second copy losing the listen race exits quietly — the socket
 * winner serves everyone.
 */
import * as nodeModule from "node:module";

try {
  nodeModule.enableCompileCache?.();
} catch {
  /* silent by contract */
}

const { runDaemon } = await import("./gitvault-daemon.mjs");
try {
  await runDaemon();
} catch {
  process.exit(0);
}
