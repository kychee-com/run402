/**
 * first-deploy-front-door gates: the front door has a line budget and the CLI
 * reference keeps expert sections after the command reference. Both are
 * generator errors, so a regen that would violate them fails loudly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertByteBudget, assertCliSectionOrder, assertLineBudget, listAgentFlatFiles, renderSliceTable } from "./build-agent-flat-docs.mjs";

describe("build-agent-flat-docs — front-door line budget", () => {
  it("passes at the budget and fails one line past it, naming budget and count", () => {
    const bundle = { out: "llms.txt", lineBudget: 3 };
    assertLineBudget(bundle, "a\nb\nc\n");
    assert.throws(() => assertLineBudget(bundle, "a\nb\nc\nd\n"), /llms\.txt is 4 lines; the front-door budget is 3/);
  });

  it("the committed llms.txt is within budget and leads with up", () => {
    const text = readFileSync(new URL("../llms.txt", import.meta.url), "utf-8");
    assertLineBudget({ out: "llms.txt", lineBudget: 180 }, text);
    assert.match(text, /run402 up --name my-app -y/);
    assert.doesNotMatch(text, /--rehearse\b/);
    assert.doesNotMatch(text, /projects provision/);
    assert.match(text, /_run402\/config\.js/);
  });
});

describe("build-agent-flat-docs — CLI reference section order", () => {
  it("rejects an expert section before the command reference, naming it", () => {
    const bad = "# x\n\n## Buzz community control plane\n\nstuff\n\n## Command Reference\n\nref\n";
    assert.throws(() => assertCliSectionOrder(bad), /expert section\(s\) precede the command reference.*Buzz/);
  });

  it("accepts expert sections after the command reference", () => {
    const ok = "# x\n\n## TL;DR\n\n## Command Reference\n\nref\n\n## Buzz community control plane\n\n## Portable Project Archives (Cloud -> Core)\n";
    assertCliSectionOrder(ok);
  });

  it("the committed llms-cli-full.txt obeys the order", () => {
    assertCliSectionOrder(readFileSync(new URL("../cli/llms-cli-full.txt", import.meta.url), "utf-8"));
  });
});

// agent-docs-slices: llms-cli.txt is an INDEX (the first-deploy contract plus a
// table of fetchable slices); a fetch that truncates near 60 KB must still hand
// the agent a complete contract, so the index and every slice carry a budget.
describe("build-agent-flat-docs — sliced CLI reference", () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");
  const INDEX_BUDGET = 48 * 1024;
  const SLICE_BUDGET = 56 * 1024;

  it("assertByteBudget passes at the budget and fails one byte past it, naming both", () => {
    assertByteBudget("x", "abc", 3);
    assert.throws(() => assertByteBudget("x", "abcd", 3), /x is 4 bytes; the slice budget is 3/);
  });

  it("the generator lists the index, every slice, and the full reference as served files", () => {
    const files = listAgentFlatFiles();
    const assets = files.map((f) => f.asset);
    assert.ok(assets.includes("llms-cli.txt"));
    assert.ok(assets.includes("llms-cli-full.txt"));
    assert.ok(assets.includes("llms-cli-deploy.txt"));
    assert.ok(assets.includes("llms-sdk.txt"));
    assert.ok(assets.includes("llms-mcp.txt"));
    assert.ok(!assets.includes("llms.txt"), "the front door is apex-owned, never a docs-project asset");
    for (const f of files) assert.equal(f.asset, f.path.split("/").pop());
  });

  it("the committed index is within budget, keeps the first-deploy contract, and names every slice", () => {
    const index = read("cli/llms-cli.txt");
    assertByteBudget("cli/llms-cli.txt", index, INDEX_BUDGET);
    for (const heading of ["## TL;DR", "## Output Contract", "## `run402 up`", "## Error JSON and Safe Retry", "## Step 3: Subscribe to a Tier", "## Fetchable reference slices"]) {
      assert.ok(index.includes(`\n${heading}`), `index must carry ${heading}`);
    }
    assert.ok(!index.includes("\n## Command Reference"), "the command reference lives in slices, not the index");
    const slices = listAgentFlatFiles().filter((f) => /^llms-cli-.+\.txt$/.test(f.asset) && f.asset !== "llms-cli-full.txt");
    assert.ok(slices.length >= 8, "expected the reference to be split into topic slices");
    for (const s of slices) {
      assert.ok(index.includes(`https://docs.run402.com/${s.asset}`), `index must link ${s.asset}`);
    }
    assert.ok(index.includes("https://docs.run402.com/llms-cli-full.txt"));
  });

  it("every committed slice is within budget and links back to the index", () => {
    for (const f of listAgentFlatFiles()) {
      if (!/^llms-cli-.+\.txt$/.test(f.asset) || f.asset === "llms-cli-full.txt") continue;
      const text = read(f.path);
      assertByteBudget(f.path, text, SLICE_BUDGET);
      assert.match(text, /^# Run402 CLI -- Agent Reference — /, `${f.path} must open with the generator-owned slice H1`);
      assert.ok(text.includes("https://docs.run402.com/llms-cli.txt"), `${f.path} must link the index`);
    }
  });

  it("the slice table is deterministic and derived from the rendered slice bytes", () => {
    const cfg = { urlFor: (s) => `https://x/${s}.txt`, fullUrl: "https://x/full.txt" };
    const slices = [{ slice: "a", title: "A", summary: "covers a", bytes: 2048 }];
    const once = renderSliceTable(slices, cfg);
    assert.equal(once, renderSliceTable(slices, cfg));
    assert.ok(once.includes("| A | https://x/a.txt | covers a | ~2 KB |"));
    assert.ok(once.includes("https://x/full.txt"));
  });
});
