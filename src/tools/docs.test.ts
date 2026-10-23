import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCS_SEARCH_MAX_SECTIONS, DOCS_WINDOW_LINES, handleDocs } from "./docs.js";
import { _resetResultStore, expandResult } from "../result-store.js";
import { loadDeployManifest } from "../../sdk/dist/node/index.js";

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

  it("serves the run402.json manifest as its own topic, with a verbatim static-site example", async () => {
    const result = await handleDocs({ topic: "manifest" });
    assert.equal(result.isError, undefined);
    const body = text(result);
    assert.match(body.split("\n")[2]!, /^## Manifest \(`run402\.json`\)$/);
    for (const needle of [
      "https://run402.com/schemas/release-spec.v1.json",
      '"__source": "local-dir"',
      '"subdomains"',
      '"noindex": true',
      '"public_paths"',
    ]) {
      assert.ok(body.includes(needle), `the manifest topic names ${needle}`);
    }
  });

  it("the manifest topic's static-site example validates against the release-spec schema and loads", async () => {
    const body = text(await handleDocs({ topic: "manifest" }));
    const examples = [...body.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    assert.ok(examples.length >= 2, "a static-site example and a public_paths example");
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = JSON.parse(readFileSync(join(root, "schemas", "release-spec.v1.json"), "utf8"));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    for (const json of examples) assert.equal(validate(JSON.parse(json)), true, JSON.stringify(validate.errors));
    const example = examples[0]!;
    const manifest = JSON.parse(example) as { site: { replace: { path: string } } };
    const dir = mkdtempSync(join(tmpdir(), "docs-manifest-"));
    try {
      mkdirSync(join(dir, manifest.site.replace.path));
      writeFileSync(join(dir, manifest.site.replace.path, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(dir, "run402.json"), example);
      const loaded = await loadDeployManifest(join(dir, "run402.json"), { project: "prj_docs_fixture" });
      assert.deepEqual(loaded.spec.subdomains, { set: ["family"] });
      assert.equal(loaded.spec.site && "noindex" in loaded.spec.site ? loaded.spec.site.noindex : undefined, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("search matches run402.json and local-dir in the manifest topic", async () => {
    for (const query of ["run402.json manifest site", "run402.json site dir subdomains", "local-dir", "run402.json noindex"]) {
      const result = await handleDocs({ search: query });
      assert.doesNotMatch(header(result), /no section matches/, `search "${query}"`);
      const page = expandResult(refOf(result), { limit: 10000 });
      assert.ok((page?.items as string[]).includes("(topic `manifest`)"), `search "${query}" returns the manifest topic`);
    }
  });

  it("the deploy topics and the index point at the manifest topic", async () => {
    for (const topic of ["bootstrap-and-deploy", "quick-start", "sites"]) {
      assert.match(text(await handleDocs({ topic })), /docs\(\{ topic: "manifest" \}\)/, `topic ${topic}`);
    }
    assert.match(text(await handleDocs({})), /docs\(\{ topic: "manifest" \}\)/, "the index");
  });

  it("is packaged by the build: the MCP package copies both sources into dist/docs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[] };
    assert.match(pkg.scripts.build!, /cp sdk\/llms-sdk\.txt docs-site\/src\/content\/docs\/mcp\/run\.md dist\/docs\//);
    assert.ok(pkg.files.includes("dist"));
  });
});
