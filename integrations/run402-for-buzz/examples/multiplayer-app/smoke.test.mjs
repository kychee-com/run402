import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const files = [
  "package.json",
  "run402.deploy.ts",
  "db/001_feedback.sql",
  "db/002_feedback_roles.sql",
  "functions/feedback.js",
  "functions/feedback-admin.js",
  "site/index.html",
  "site/app.js",
  "site/styles.css",
  "README.md",
];

test("reference app contains each required surface and no embedded secret", () => {
  const source = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  for (const required of ["auth.requireUser", "auth.requireRole", "feedback_items", "feedback_votes", "feedback_comments", "attachment_url", "public_paths", "--require-plan", "transfer preview"]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /(?:0x)?[0-9a-f]{64}/i);
  assert.doesNotMatch(source, /(?:private[_ -]?key|mnemonic|nsec)\s*[:=]\s*["'][^"']+/i);
});

test("browser code renders API data with textContent, never innerHTML", () => {
  const source = readFileSync(new URL("site/app.js", import.meta.url), "utf8");
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
});

test("the deploy config declares its SDK loader dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
  assert.match(manifest.dependencies?.["@run402/sdk"], /^\^4\.13\./);
});

test("the admin action has an explicit, uncached gateway role gate", () => {
  const source = readFileSync(new URL("run402.deploy.ts", import.meta.url), "utf8");
  assert.match(source, /"feedback-admin"/);
  assert.match(source, /table:\s*"feedback_roles"/);
  assert.match(source, /allowed:\s*\["admin"\]/);
  assert.match(source, /cacheTtl:\s*0/);
});
