/**
 * Daemon identity + transport addressing (gitvault-persistent-helper D4/D5)
 * — the ONE module the thin client's fast path may import beside node
 * builtins (pinned by the import-graph gate test), so it must stay tiny.
 *
 * The socket lives INSIDE the client configuration directory — the same
 * 0700 trust boundary that already holds the allowance private key and the
 * gitvault keystore — and its path is keyed by CLI version, so a CLI
 * upgrade resolves a NEW path: the new client never reaches the old daemon,
 * which idles out on its own. Windows uses a named pipe whose name carries
 * a hash of the config dir (pipes have no filesystem home) plus the same
 * version key.
 */
import { readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/** Mirrors core config's base-dir resolution without importing its graph. */
export function configBaseDir() {
  return process.env.RUN402_CONFIG_DIR || join(homedir(), ".config", "run402");
}

let cachedVersion = null;
export function cliVersion() {
  if (cachedVersion) return cachedVersion;
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  cachedVersion = String(pkg.version);
  return cachedVersion;
}

/** Bump when the client↔daemon frame protocol changes shape. */
export const DAEMON_PROTOCOL_VERSION = 1;

/**
 * Unix domain sockets cap `sun_path` around 104 bytes (macOS) — a long
 * RUN402_CONFIG_DIR (test tmpdirs, deep homes) makes the config-dir socket
 * un-listenable, which the fallback would silently mask forever. So the
 * home is the config dir when the path FITS, else an owner-only per-user
 * directory under tmpdir whose socket NAME still keys on the config dir —
 * the trust boundary (0700 dir the daemon creates and verifies) travels
 * with it either way.
 */
const SUN_PATH_BUDGET = 100;

function fallbackDir() {
  let who;
  try {
    who = String(userInfo().uid ?? userInfo().username);
  } catch {
    who = "u";
  }
  return join(tmpdir(), `run402-gvd-${who}`);
}

/** The socket's full address — preferred home when it fits the budget, else the owner-only fallback with a config-keyed name. */
function resolveSocket() {
  const version = cliVersion().replace(/[^0-9A-Za-z.]/g, "_");
  if (process.platform === "win32") {
    const key = createHash("sha256").update(configBaseDir()).digest("hex").slice(0, 12);
    return { dir: null, path: `\\\\.\\pipe\\run402-gvd-${key}-${version}` };
  }
  const preferredDir = join(configBaseDir(), "daemon");
  const preferred = join(preferredDir, `gv-${version}.sock`);
  if (Buffer.byteLength(preferred) <= SUN_PATH_BUDGET) return { dir: preferredDir, path: preferred };
  const dir = fallbackDir();
  const key = createHash("sha256").update(configBaseDir()).digest("hex").slice(0, 12);
  return { dir, path: join(dir, `g${key}${version.replace(/\./g, "")}.sock`) };
}

/** Directory holding the socket (created 0700 by the daemon). */
export function daemonDir() {
  return resolveSocket().dir;
}

export function daemonSocketPath() {
  return resolveSocket().path;
}

export function daemonRunnerPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "gitvault-daemon-run.mjs");
}

/**
 * The env allowlist a session forwards (D1): everything run402- or
 * git-shaped, plus the locale pair git itself respects. Deliberately NOT
 * the whole environment — the daemon runs with its own HOME/PATH (same
 * user, same machine), and forwarding arbitrary env would make the daemon's
 * behavior depend on whichever client spoke last in ways nothing re-reads.
 */
export function forwardableEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith("RUN402_") || k.startsWith("GIT_") || k === "LC_ALL" || k === "LANG") out[k] = v;
  }
  return out;
}
