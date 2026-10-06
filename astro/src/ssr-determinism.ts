/**
 * Build-determinism helpers for the SSR adapter.
 *
 * The gateway redeploys a function whenever its `code_hash` changes, so
 * anything non-deterministic that reaches the SSR server bundle makes
 * the `ssr` function redeploy on every build of an unchanged commit.
 * Astro core contributes two such inputs to the serialized server
 * manifest it injects into the server output:
 *
 *   1. `key` — a fresh AES key minted every build unless `ASTRO_KEY` is
 *      set (core/build/index.js → core/encryption.js `createKey`). The
 *      adapter cannot derive one itself: the key encrypts server-island
 *      props and action payloads, so it must be a secret. It warns.
 *   2. `assets` — collected by an unsorted async glob over the client
 *      dir (core/build/plugins/plugin-manifest.js `createManifest`), so
 *      its order is a race. The runtime turns the list into a Set
 *      (core/app/manifest.js), so order carries no meaning; the adapter
 *      sorts it in `astro:build:done`, before `ssr-bundler` reads the
 *      server output.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Environment variable Astro reads its server encryption key from. */
export const ASTRO_KEY_ENV = "ASTRO_KEY";

/**
 * The warning to log when an SSR build runs without `ASTRO_KEY`, or
 * null when the key is set.
 */
export function astroKeyWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[ASTRO_KEY_ENV]) return null;
  return (
    `${ASTRO_KEY_ENV} is not set: Astro minted a random encryption key for this build, ` +
    `so the ssr function's code changes on every build and it will be redeployed on every ` +
    `deploy, even when no source changed. Generate a key once with \`npx astro create-key\`, ` +
    `store it as a CI secret, and export it as ${ASTRO_KEY_ENV} for every build.`
  );
}

/**
 * Sort the `assets` array of every serialized Astro manifest in `code`.
 *
 * The manifest is located by its field order — `"inlinedScripts": [...]`
 * immediately followed by `"assets": [...]` — so an unrelated `assets`
 * key elsewhere in the code is never touched. Whitespace-tolerant (it
 * also matches esbuild's reprinted `"assets": [\n  "/a",\n  "/b"\n]`),
 * and format-preserving: only the string elements are reordered; the
 * separators between them stay where they were. An array holding
 * anything but string literals is left alone.
 */
export function sortManifestAssets(code: string): string {
  const anchor = /"inlinedScripts"\s*:\s*\[/g;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(code)) !== null) {
    const inlinedEnd = findArrayEnd(code, match.index + match[0].length - 1);
    if (inlinedEnd === -1) break;
    const assetsKey = /^\s*,\s*"assets"\s*:\s*\[/.exec(code.slice(inlinedEnd + 1));
    if (!assetsKey) {
      anchor.lastIndex = inlinedEnd + 1;
      continue;
    }
    const open = inlinedEnd + assetsKey[0].length;
    const close = findArrayEnd(code, open);
    if (close === -1) break;
    const sorted = sortStringArrayBody(code.slice(open + 1, close));
    if (sorted !== null) {
      out += code.slice(cursor, open + 1) + sorted;
      cursor = close;
    }
    anchor.lastIndex = close + 1;
  }
  return cursor === 0 ? code : out + code.slice(cursor);
}

/**
 * Apply {@link sortManifestAssets} to every JS module under `serverDir`.
 * Returns the paths it rewrote.
 */
export async function normalizeServerOutput(serverDir: string): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await listJsFiles(serverDir)) {
    const code = await readFile(file, "utf-8");
    if (!code.includes('"inlinedScripts"')) continue;
    const next = sortManifestAssets(code);
    if (next !== code) {
      await writeFile(file, next, "utf-8");
      changed.push(file);
    }
  }
  return changed;
}

async function listJsFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsFiles(full)));
    else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/**
 * Index of the `]` closing the array whose `[` is at `open`, honoring
 * nested arrays/objects and JSON string literals. -1 when unbalanced.
 */
function findArrayEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      i = findStringEnd(code, i);
      if (i === -1) return -1;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return ch === "]" ? i : -1;
    }
  }
  return -1;
}

/** Index of the `"` closing the string literal opened at `open`. */
function findStringEnd(code: string, open: number): number {
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === '"') return i;
  }
  return -1;
}

/**
 * Reorder the string literals in an array body (the text between `[`
 * and `]`), keeping the separators in place. Null when the body holds
 * anything other than string literals separated by commas/whitespace.
 */
function sortStringArrayBody(body: string): string | null {
  const literals: { raw: string; value: string }[] = [];
  const gaps: string[] = [];
  let i = 0;
  let gapStart = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"') {
      const end = findStringEnd(body, i);
      if (end === -1) return null;
      const raw = body.slice(i, end + 1);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
      gaps.push(body.slice(gapStart, i));
      literals.push({ raw, value: value as string });
      i = end + 1;
      gapStart = i;
    } else if (ch === "," || /\s/.test(ch)) {
      i++;
    } else {
      return null;
    }
  }
  const tail = body.slice(gapStart);
  const sorted = [...literals].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return sorted.map((lit, idx) => gaps[idx] + lit.raw).join("") + tail;
}
