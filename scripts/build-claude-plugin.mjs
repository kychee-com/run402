#!/usr/bin/env node
/**
 * build-claude-plugin.mjs — generates the Claude plugin (`plugins/run402/`)
 * and this repository's plugin marketplace (`.claude-plugin/marketplace.json`)
 * from the sources they mirror, so neither can drift:
 *
 *   - the version (plugin.json, marketplace.json, and the exact `run402-mcp`
 *     pin in `.mcp.json`) is the root package.json version. The directory's
 *     validator blocks an unpinned `npx` launcher, and the publish workflow
 *     regenerates this file in the same commit that bumps the version, so the
 *     pin always names a version that is on npm.
 *   - `skills/run402/SKILL.md` is the root SKILL.md body with the frontmatter
 *     reduced to the `name` and `description` a Claude skill reads (the root
 *     frontmatter also carries OpenClaw install metadata).
 *
 * `plugins/run402/README.md` is hand-written and not generated.
 *
 * Usage:
 *   node scripts/build-claude-plugin.mjs          # regenerate the files
 *   node scripts/build-claude-plugin.mjs --check   # CI: fail if stale
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "plugins", "run402");

const NAME = "run402";
const DISPLAY_NAME = "Run402";
const DESCRIPTION =
  "Build, deploy and operate full-stack apps from Claude: Postgres with REST and row-level security, auth, storage, serverless functions and static hosting, with a free prototype tier.";
const AUTHOR = { name: "Kychee", url: "https://run402.com" };

function readSkillParts() {
  const raw = readFileSync(join(ROOT, "SKILL.md"), "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  const [, frontmatter, body] = match;
  const field = (key) => {
    const line = frontmatter.split("\n").find((l) => l.startsWith(`${key}:`));
    if (!line) throw new Error(`SKILL.md frontmatter has no ${key}`);
    return line.slice(key.length + 1).trim();
  };
  return { name: field("name"), description: field("description"), body };
}

/** Pure builder: every generated path mapped to its bytes. No writes. */
export function buildClaudePlugin() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const skill = readSkillParts();
  const json = (value) => JSON.stringify(value, null, 2) + "\n";

  const plugin = {
    name: NAME,
    displayName: DISPLAY_NAME,
    version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: "https://run402.com",
    repository: "https://github.com/kychee-com/run402",
    license: "MIT",
    keywords: ["postgres", "database", "deploy", "hosting", "serverless", "auth", "storage", "mcp"],
  };

  const mcp = {
    mcpServers: {
      run402: { command: "npx", args: ["-y", `run402-mcp@${version}`] },
    },
  };

  const marketplace = {
    name: NAME,
    owner: AUTHOR,
    metadata: { description: "The Run402 plugin for Claude.", version },
    plugins: [
      {
        name: NAME,
        source: "./plugins/run402",
        description: DESCRIPTION,
        version,
        author: AUTHOR,
        homepage: "https://run402.com",
        license: "MIT",
      },
    ],
  };

  const skillMd = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}`;

  return new Map([
    [join(ROOT, ".claude-plugin", "marketplace.json"), json(marketplace)],
    [join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), json(plugin)],
    [join(PLUGIN_DIR, ".mcp.json"), json(mcp)],
    [join(PLUGIN_DIR, "skills", "run402", "SKILL.md"), skillMd],
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [path, bytes] of buildClaudePlugin()) {
    let current = null;
    try {
      current = readFileSync(path, "utf-8");
    } catch {}
    if (current === bytes) continue;
    if (check) {
      stale.push(relative(ROOT, path));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      console.log(`wrote ${relative(ROOT, path)}`);
    }
  }
  if (stale.length) {
    console.error(`Claude plugin files are stale: ${stale.join(", ")}\nRun: node scripts/build-claude-plugin.mjs`);
    process.exit(1);
  }
}
