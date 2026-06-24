#!/usr/bin/env node
/**
 * build-docs-deploy-manifest.mjs — emit run402.docs.deploy.json for the portal.
 *
 * The CLI's `--dir` flag is ASTRO-SSR-ADAPTER ONLY (it reads dist/run402/adapter.json
 * and requires @run402/astro). For a PLAIN STATIC Starlight build (Fork 1) there is
 * no adapter manifest, and the CLI's site spec is per-file. So this script walks the
 * static `docs-site/dist/**` and enumerates every file into `site.replace` as a path
 * ref, then declares `public_paths: { mode: "implicit" }` so filename-derived URLs
 * (e.g. dist/getting-started/index.html -> /getting-started/) are reachable. The four
 * flat agent files are added from their canonical repo-root paths (preserving the
 * git-tag raw.githubusercontent.com pins) and become reachable at /llms-*.txt + /SKILL.md.
 *
 * The resulting manifest is fed to the SAME `run402 deploy apply --manifest ... --project ...`
 * OIDC invocation the docs project already uses — no SSR runtime, no new auth path.
 *
 * Usage:
 *   node scripts/build-docs-deploy-manifest.mjs            # write run402.docs.deploy.json
 *   node scripts/build-docs-deploy-manifest.mjs --dist X   # custom dist dir (tests)
 *   node scripts/build-docs-deploy-manifest.mjs --out Y     # custom output path (tests)
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ID = "prj_1780488560350_0018"; // run402-docs

const argv = process.argv.slice(2);
const distArg = argv.includes("--dist") ? argv[argv.indexOf("--dist") + 1] : "docs-site/dist";
const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "run402.docs.deploy.json";
const DIST = join(ROOT, distArg);
const OUT = join(ROOT, outArg);

// The four flat agent files keep their canonical repo-root source paths.
const FLAT_FILES = [
  { asset: "llms-cli.txt", path: "cli/llms-cli.txt" },
  { asset: "llms-sdk.txt", path: "sdk/llms-sdk.txt" },
  { asset: "llms-mcp.txt", path: "llms-mcp.txt" },
  { asset: "SKILL.md", path: "SKILL.md" },
];

/** Recursively list files under dir as repo-relative POSIX paths. */
function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`[build-docs-deploy-manifest] dist not found: ${relative(ROOT, dir)} — run \`astro build\` first`);
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const distFiles = walk(DIST);
if (distFiles.length === 0) throw new Error(`[build-docs-deploy-manifest] dist is empty: ${relative(ROOT, DIST)}`);

function cacheClassFor(rel) {
  if (rel.endsWith(".html")) return "html";
  if (rel.startsWith("_astro/")) return "immutable_versioned"; // content-hashed
  return "revalidating_asset";
}

const replace = {};
const publicPaths = {};

// Upload every dist file as a release asset AND expose it at an explicit browser
// path. EXPLICIT mode is deliberate: `implicit` + a root index.html makes the
// gateway set spa_fallback="/index.html" (see release-state.ts), which serves the
// home page with HTTP 200 for every unknown URL. A multi-page docs site wants real
// 404s, so we enumerate clean URLs instead of relying on filename-derived reach.
for (const full of distFiles) {
  const rel = relative(DIST, full).split(/[/\\]/).join(posix.sep);
  replace[rel] = { path: relative(ROOT, full).split(/[/\\]/).join(posix.sep) };
  const cache_class = cacheClassFor(rel);
  if (rel === "index.html") {
    publicPaths["/"] = { asset: rel, cache_class };
  } else if (rel.endsWith("/index.html")) {
    const dir = "/" + rel.slice(0, -"index.html".length); // "/getting-started/"
    publicPaths[dir] = { asset: rel, cache_class }; // canonical (trailing slash)
    publicPaths[dir.replace(/\/$/, "")] = { asset: rel, cache_class }; // no-slash convenience
  } else {
    publicPaths["/" + rel] = { asset: rel, cache_class };
  }
}
// The four flat agent files from the repo root → /llms-*.txt + /SKILL.md.
for (const f of FLAT_FILES) {
  replace[f.asset] = { path: f.path };
  publicPaths["/" + f.asset] = { asset: f.asset, cache_class: "revalidating_asset" };
}

const manifest = {
  $schema: "https://run402.com/schemas/release-spec.v1.json",
  project_id: PROJECT_ID,
  site: {
    replace,
    public_paths: { mode: "explicit", replace: publicPaths },
  },
};

writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `wrote ${relative(ROOT, OUT)} — ${distFiles.length} static assets + ${FLAT_FILES.length} flat files (explicit, ${Object.keys(publicPaths).length} public URLs)`,
);
