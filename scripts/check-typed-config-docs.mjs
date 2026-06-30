#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const goldenDocs = [
  "README.md",
  "llms.txt",
  "cli/README.md",
  "cli/llms-cli.txt",
  "sdk/README.md",
  "sdk/llms-sdk.txt",
  "llms-mcp.txt",
  "openclaw/README.md",
  "SKILL.md",
];

const failures = [];

for (const file of goldenDocs) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf-8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/\brun402\s+config\s+\S+/.test(line)) {
      failures.push(`${file}:${index + 1}: golden docs must not introduce a run402 config command family`);
    }
    if (/\brun402\s+up\b.*--dry-run|--dry-run.*\brun402\s+up\b/.test(line)) {
      failures.push(`${file}:${index + 1}: use --check/--plan for up typed-config guidance, not bare --dry-run`);
    }
    if (/typed (?:deploy )?config/i.test(line) && /--dry-run|dryRun:\s*true/.test(line)) {
      failures.push(`${file}:${index + 1}: typed config docs must use check/plan/require-plan wording`);
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

