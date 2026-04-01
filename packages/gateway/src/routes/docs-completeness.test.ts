import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");
const llmsCliTxt = readFileSync(join(REPO_ROOT, "site/llms-cli.txt"), "utf-8");

describe("llms-cli.txt — binary file documentation", () => {
  it("documents the 'encoding' field for binary files in the manifest", () => {
    assert.ok(
      llmsCliTxt.includes('"encoding"') || llmsCliTxt.includes("encoding"),
      "llms-cli.txt should mention the 'encoding' field for binary files",
    );
    assert.ok(
      llmsCliTxt.includes("base64"),
      "llms-cli.txt should mention base64 encoding for binary files",
    );
  });

  it("documents that binary files (images, fonts) use base64 encoding", () => {
    // Should have an example or description showing binary file handling
    assert.ok(
      llmsCliTxt.includes("image") || llmsCliTxt.includes("binary") || llmsCliTxt.includes("font"),
      "llms-cli.txt should mention binary file types (images, fonts, etc.)",
    );
  });
});
