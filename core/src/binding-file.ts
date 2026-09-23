/**
 * The per-directory binding file — `.run402.json`, and its gitignored personal
 * override `.run402.local.json`.
 *
 * A checkout binds itself to a wallet profile, an organization, a room, by
 * committing a small JSON file. That is a CHECKOUT-LEVEL CONTRACT, not a CLI
 * implementation detail: every agent working in the directory inherits the
 * same one, whichever surface it reaches Run402 through.
 *
 * It lives in core because two surfaces now read it. The CLI has always walked
 * this chain; the MCP server needs the same answer for the same directory, and
 * `run402-mcp` ships only `dist` + `core/dist` + `sdk/dist` — `cli/` is not in
 * the published package, so the MCP server cannot import the CLI's copy even
 * if it wanted to. One reader, in the one place both can see it, rather than
 * two that agree until they don't.
 *
 * Deliberately pure: `node:fs` + `node:path`, no logging, no process exit, no
 * validation of what a value MEANS. Callers decide whether a value is
 * well-shaped and what to do when it isn't — the CLI exits, the MCP server
 * returns an error, and neither behaviour belongs in a file reader.
 *
 * Unknown keys are ignored on purpose: that is what makes an older client
 * forward-compatible with a binding file written by a newer one.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The committed binding file. Safe to check in — it names, never authorizes. */
export const BINDING_FILE = ".run402.json";
/** The personal override. Gitignored; beats the committed file key-by-key. */
export const BINDING_LOCAL_FILE = ".run402.local.json";

export interface BindingKeyHit {
  /** The trimmed value found. */
  value: string;
  /** The file it came from — surfaced in provenance and conflict messages. */
  file: string;
}

/** Read one key from a single directory's binding files, override first. */
function readBindingKeyFrom(dir: string, key: string): BindingKeyHit | null {
  for (const fname of [BINDING_LOCAL_FILE, BINDING_FILE]) {
    const p = join(dir, fname);
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const v = parsed?.[key];
      if (typeof v === "string" && v.trim()) return { value: v.trim(), file: p };
    } catch {
      /* missing / unreadable / malformed → skip */
    }
  }
  return null;
}

/**
 * Nearest binding of `key`, walking up from `startDir` to the filesystem root.
 *
 * Resolution is PER KEY, not per file: the nearest file that carries the key
 * wins, so `/work/.run402.json` may supply the organization while
 * `/work/api/.run402.json` supplies the wallet. A worktree nested under a bound
 * checkout therefore inherits the binding without restating it.
 */
export function findBindingKey(startDir: string, key: string): BindingKeyHit | null {
  let dir = resolve(startDir);
  for (;;) {
    const hit = readBindingKeyFrom(dir, key);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Path of the committed binding file for a directory. */
export function bindingFilePath(dir: string = process.cwd()): string {
  return join(dir, BINDING_FILE);
}

/** Parse a directory's committed binding file, or `{}` when absent/unreadable. */
export function readBindingFile(dir: string = process.cwd()): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(bindingFilePath(dir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * MERGE keys into a directory's committed binding file. A `null` (or
 * `undefined`) value removes its key; a file left with no keys is deleted
 * rather than committed empty.
 *
 * The file is shared by tiers (`wallet` from `wallets bind`, `org`/`room` from
 * `orgs bind`) and unknown keys are preserved, so one tier can never clobber
 * another's binding.
 */
export function updateBindingFile(
  dir: string,
  patch: Record<string, unknown>,
): { file: string; contents: Record<string, unknown> | null; removed: boolean } {
  const file = bindingFilePath(dir);
  const next: Record<string, unknown> = { ...readBindingFile(dir) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length === 0) {
    const existed = existsSync(file);
    if (existed) rmSync(file, { force: true });
    return { file, contents: null, removed: existed };
  }
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return { file, contents: next, removed: false };
}
