import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { _setSnippetCheckerStart, checkSnippet, closeSnippetChecker, type SnippetCheck } from "./snippet-check.js";

after(async () => {
  await closeSnippetChecker();
});

function refused(check: SnippetCheck): Extract<SnippetCheck, { status: "refused" }> {
  assert.equal(check.status, "refused", JSON.stringify(check));
  return check as Extract<SnippetCheck, { status: "refused" }>;
}

describe("snippet type check", () => {
  afterEach(async () => {
    await _setSnippetCheckerStart(null);
  });

  it("passes correct snippets: the docs' examples, helpers, scoped clients, annotations", async () => {
    for (const code of [
      "const { projects } = await r.projects.list();\nprojects.filter((p) => !p.site_url).map((p) => ({ id: p.id, name: p.name }))",
      'const p = r.project("prj_1");\nconst [fns, release] = await Promise.all([p.functions.list(), p.apply.getActiveRelease()]);\n({ functions: fns.functions.map((f) => f.name), release_id: release.release_id })',
      "function short(id) { return id.slice(0, 8); }\nconst { projects } = await r.projects.list();\nconst meta = JSON.parse('{\"owner\":\"tal\"}');\nconsole.log('projects', projects.length, meta.owner);\n({ ids: projects.map((p) => short(p.id)), owner: meta.owner })",
      'const p = await r.project("prj_1");\nconst fns: { name: string }[] = (await p.functions.list()).functions;\nfns.map((f) => f.name)?.join(",")',
      "let x = 1",
      "Array.from({ length: 3 }, (_, i) => ({ i }))",
    ]) {
      assert.deepEqual(await checkSnippet(code), { status: "passed" }, code);
    }
  });

  it("names a misspelled method on an SDK object with the replay's did_you_mean", async () => {
    const check = refused(await checkSnippet('await r.rooms.sendMessage("org_1", "dev", { body: "starting" });\nconst { projects } = await r.projects.lst();\nprojects.length'));
    assert.equal(check.unknownMember?.path, "r.projects.lst");
    assert.ok(check.unknownMember?.suggestions.includes("r.projects.list"), JSON.stringify(check.unknownMember?.suggestions));
    assert.match(check.unknownMember!.message, /^r\.projects\.lst is not part of the SDK\. Did you mean /);
    assert.deepEqual(check.diagnostics[0], { line: 2, column: 39, code: "TS2551", message: "Property 'lst' does not exist on type 'Projects'. Did you mean 'list'?" });
  });

  it("points a member reached from the wrong parent at where it lives", async () => {
    const check = refused(await checkSnippet('await r.project("prj_1").sql("select 1")'));
    assert.equal(check.unknownMember?.path, "r.project(…).sql");
    const suggestions = check.unknownMember!.suggestions;
    assert.ok(suggestions.includes("r.project(…).projects.sql"), JSON.stringify(suggestions));
    assert.ok(suggestions.includes("r.projects.sql"), JSON.stringify(suggestions));
  });

  it("names a misspelled field of returned data as a type error, not an unknown member", async () => {
    const check = refused(await checkSnippet("const { projects } = await r.projects.list();\nprojects.filter((p) => !p.siteUrl)"));
    assert.equal(check.unknownMember, undefined);
    assert.equal(check.diagnostics[0]!.code, "TS2551");
    assert.equal(check.diagnostics[0]!.line, 2);
    assert.match(check.diagnostics[0]!.message, /Did you mean 'site_url'\?/);
  });

  it("names a wrong argument shape, a missing await, and a missing argument", async () => {
    const shape = refused(await checkSnippet('await r.rooms.sendMessage("org_1", "dev", { text: "hi" })'));
    assert.equal(shape.diagnostics[0]!.code, "TS2353");
    assert.match(shape.diagnostics[0]!.message, /'text' does not exist/);
    const noAwait = refused(await checkSnippet("const { projects } = r.projects.list();\nprojects.map((p) => p.id)"));
    assert.equal(noAwait.diagnostics[0]!.code, "TS2339");
    assert.match(noAwait.diagnostics[0]!.message, /Promise<ListProjectsResult>/);
    const arity = refused(await checkSnippet('await r.projects.sql("select count(*) from users")'));
    assert.equal(arity.diagnostics[0]!.code, "TS2554");
  });

  it("maps line 1's columns past the wrapper, and counts columns in characters", async () => {
    const check = refused(await checkSnippet('const s = "— ü —"; s.lenght'));
    assert.deepEqual(check.diagnostics.map((d) => [d.line, d.column, d.code]), [[1, 22, "TS2551"]]);
  });

  it("does not refuse what the sandbox runs: typeof probes and un-awaited r chains", async () => {
    assert.deepEqual(await checkSnippet("[typeof require, typeof process, typeof fetch, typeof setTimeout]"), { status: "passed" });
    assert.deepEqual(await checkSnippet("await r.project().functions.list()"), { status: "passed" });
    assert.deepEqual(await checkSnippet('(await r.project("prj_1").functions.list().functions).map((f) => f.name)'), { status: "passed" });
  });

  it("still refuses an un-awaited chain whose awaited value lacks the member", async () => {
    const check = refused(await checkSnippet("await r.project().nope"));
    assert.equal(check.diagnostics[0]!.code, "TS2339");
  });

  it("refuses a name the sandbox does not have outside typeof", async () => {
    const check = refused(await checkSnippet('await fetch("https://example.com")'));
    assert.equal(check.diagnostics[0]!.code, "TS2304");
  });

  it("reports every diagnostic, in source order", async () => {
    const code = Array.from({ length: 13 }, (_, i) => `const v${i}: number = "x";`).join("\n");
    const check = refused(await checkSnippet(code));
    assert.deepEqual(check.diagnostics.map((d) => d.line), Array.from({ length: 13 }, (_, i) => i + 1));
  });

  it("answers concurrent checks each with their own snippet's result", async () => {
    const [ok, bad] = await Promise.all([checkSnippet("1 + 1"), checkSnippet("const n: number = 'x'")]);
    assert.equal(ok.status, "passed");
    assert.equal(bad.status, "refused");
  });

  it("passes every example the run reference teaches", async () => {
    const doc = readFileSync(fileURLToPath(new URL("../docs-site/src/content/docs/mcp/run.md", import.meta.url)), "utf8");
    const examples = [...doc.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    // A run input is a JSON block whose only key is `code`; the error examples are outputs.
    for (const m of doc.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const block = JSON.parse(m[1]!) as Record<string, unknown>;
      if (Object.keys(block).join() === "code" && typeof block.code === "string") examples.push(block.code);
    }
    assert.ok(examples.length >= 4, `found ${examples.length} examples`);
    for (const code of examples) assert.deepEqual(await checkSnippet(code), { status: "passed" }, code);
  });

  it("is skipped, never thrown, when the checker cannot start", async () => {
    await _setSnippetCheckerStart(() => Promise.reject(new Error("no checker binary for this platform")));
    assert.deepEqual(await checkSnippet("const n: number = 'x'"), { status: "skipped", reason: "no checker binary for this platform" });
  });
});
