import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_SEARCH_MAX_SECTIONS, DOCS_WINDOW_LINES, handleDocs } from "./docs.js";
import { _resetResultStore, expandResult } from "../result-store.js";

const root = join(import.meta.dirname, "..", "..");
const originalFetch = globalThis.fetch;

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

function header(result: { content: Array<{ text: string }> }): string {
  return text(result).split("\n")[0]!;
}

function refOf(result: { content: Array<{ text: string }> }): string {
  return /ref (res_[0-9a-f]{16})/.exec(header(result))![1]!;
}

beforeEach(() => {
  _resetResultStore();
  globalThis.fetch = (async () => {
    throw new Error("docs must never fetch");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetResultStore();
});

describe("docs tool", () => {
  it("serves the index by default, whole, in one window", async () => {
    const result = await handleDocs({});
    assert.equal(result.isError, undefined);
    assert.match(header(result), /^docs: index — \d+ lines, all shown \(ref res_[0-9a-f]{16}\)\.$/);
    const lines = text(result).split("\n").length - 2;
    assert.ok(lines <= DOCS_WINDOW_LINES, `the index is ${lines} lines; the window is ${DOCS_WINDOW_LINES}`);
    const body = text(result);
    assert.match(body, /## `run`: a snippet against the SDK/, "the run primer");
    assert.match(body, /## `r` namespaces/, "the namespace table");
    assert.match(body, /\| `projects` \| provision, /);
    assert.match(body, /SECRET_REQUIRES_CLI/, "the secret rule");
    assert.ok((body.match(/```ts\n/g) ?? []).length >= 3, "at least three example snippets");
    assert.match(body, /## Other topics/, "the list of topics");
  });

  it("stores every answer so expand_result reaches it", async () => {
    const result = await handleDocs({});
    const page = expandResult(refOf(result), { offset: 0, limit: 3 });
    assert.equal(page?.kind, "docs");
    assert.equal(page?.items[0], "# run402-mcp docs: index");
  });

  it("answers a namespace topic with its SDK reference section", async () => {
    const result = await handleDocs({ topic: "assets" });
    assert.match(text(result), /### `r\.assets`/);
    const scoped = await handleDocs({ topic: "project.apply" });
    assert.match(text(scoped).split("\n")[2]!, /^### `r\.project\(id\)\.apply`$/);
  });

  it("answers `sdk` with the whole reference, windowed, the rest behind the ref", async () => {
    const result = await handleDocs({ topic: "sdk" });
    const total = readFileSync(join(root, "sdk", "llms-sdk.txt"), "utf8").replace(/\n+$/, "").split("\n").length;
    assert.match(header(result), new RegExp(`lines 1–${DOCS_WINDOW_LINES} of ${total};`));
    const rest = expandResult(refOf(result), { offset: DOCS_WINDOW_LINES, limit: 5 });
    assert.equal(rest?.total, total);
  });

  it("lists the topics for an unknown topic", async () => {
    const result = await handleDocs({ topic: "no-such-topic" });
    assert.equal(result.isError, true);
    assert.match(text(result), /No topic "no-such-topic"\. Topics: index, sdk, run, .*assets.*projects/);
  });

  it("caps a search and says how many sections matched", async () => {
    const result = await handleDocs({ search: "the" });
    assert.match(header(result), new RegExp(`showing the first ${DOCS_SEARCH_MAX_SECTIONS} of \\d+ matching sections`));
    const page = expandResult(refOf(result), { limit: 1000 });
    const sections = (page?.items as string[]).filter((l) => /^\(topic `/.test(l)).length;
    assert.equal(sections, DOCS_SEARCH_MAX_SECTIONS);
  });

  it("finds a section by every word", async () => {
    const result = await handleDocs({ search: "waitForMessages held read" });
    assert.match(text(result), /matching section/);
    assert.match(text(result), /waitForMessages/);
    const none = await handleDocs({ search: "zzz-not-a-word-anywhere" });
    assert.match(header(none), /no section matches/);
  });

  it("is packaged by the build: the MCP package copies both sources into dist/docs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] };
    assert.match(pkg.scripts.build!, /cp sdk\/llms-sdk\.txt docs-site\/src\/content\/docs\/mcp\/run\.md dist\/docs\//);
    assert.ok(pkg.files.includes("dist"));
  });
});
