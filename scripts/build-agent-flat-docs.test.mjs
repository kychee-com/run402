/**
 * first-deploy-front-door gates: the front door has a line budget and the CLI
 * reference keeps expert sections after the command reference. Both are
 * generator errors, so a regen that would violate them fails loudly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCliSectionOrder, assertLineBudget } from "./build-agent-flat-docs.mjs";

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

  it("the committed llms-cli.txt obeys the order", () => {
    assertCliSectionOrder(readFileSync(new URL("../cli/llms-cli.txt", import.meta.url), "utf-8"));
  });
});
