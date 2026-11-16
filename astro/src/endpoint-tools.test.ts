/**
 * Endpoint tools: read at build, from each endpoint's source file, with the
 * extractor `@run402/sdk/node` exports.
 *
 * The fixture site under `test/fixtures/endpoint-tools/` declares a tool on a
 * static-path endpoint, on a dynamic `[param]` endpoint and on a prerendered
 * endpoint; the last must fail the build. These tests drive the adapter's
 * hooks with the route data Astro 7 hands `astro:routes:resolved` for that
 * site, against the real extractor.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  liftEndpointTools,
  Run402AstroToolDeclarationError,
  type EndpointRouteRecord,
} from "./endpoint-tools.js";
import { createRun402Adapter } from "./ssr-adapter.js";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/endpoint-tools/", import.meta.url));

const NOTES: EndpointRouteRecord = { pattern: "/api/notes", entrypoint: "src/pages/api/notes.ts", prerender: false };
const NOTE: EndpointRouteRecord = { pattern: "/api/notes/[note_id]", entrypoint: "src/pages/api/notes/[note_id].ts", prerender: false };
const FEED: EndpointRouteRecord = { pattern: "/feed.json", entrypoint: "src/pages/feed.json.ts", prerender: true };

const FIXTURE_TOOLS = [
  {
    name: "list_notes",
    description: "List the notes, newest first, optionally only those with one tag.",
    input: { type: "object", properties: { tag: { type: "string" } } },
    method: "GET",
    path: "/api/notes",
  },
  {
    name: "add_note",
    title: "Add a note",
    description: "Add a note with a title.",
    input: { type: "object", properties: { title: { type: "string", maxLength: 200 } }, required: ["title"] },
    method: "POST",
    path: "/api/notes",
  },
  {
    name: "update_note",
    description: "Replace the text of one note.",
    input: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id", "text"] },
    method: "POST",
    path: "/api/notes/{note_id}",
  },
];

async function refusal(run: Promise<unknown>): Promise<Run402AstroToolDeclarationError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof Run402AstroToolDeclarationError, String(err));
    return err;
  }
  assert.fail("expected the build to be refused");
}

describe("the fixture site's endpoint tools", () => {
  it("reads a tool from a static-path endpoint and from a dynamic [param] endpoint", async () => {
    // Given in the order Astro lists them (dynamic first): the result is in route order.
    const tools = await liftEndpointTools({ root: FIXTURE, routes: [NOTE, NOTES] });
    assert.deepEqual(tools, FIXTURE_TOOLS);
  });

  it("fails the build on the prerendered endpoint with MCP_TOOL_ROUTE_ELSEWHERE, the file and the line", async () => {
    const err = await refusal(liftEndpointTools({ root: FIXTURE, routes: [NOTE, NOTES, FEED] }));
    assert.equal(err.code, "MCP_TOOL_ROUTE_ELSEWHERE");
    assert.equal(err.file, "src/pages/feed.json.ts");
    assert.equal(err.line, 8);
    assert.equal(err.fieldPath, "tool");
    assert.match(err.message, /^\[MCP_TOOL_ROUTE_ELSEWHERE\] .*static file answers `\/feed\.json`.*\(src\/pages\/feed\.json\.ts:8, tool\)$/);
    assert.equal(err.docs, "https://docs.run402.com/errors#MCP_TOOL_ROUTE_ELSEWHERE");
  });

  it("applies the project's base, and the trailing slash Astro's matcher requires", async () => {
    const based = await liftEndpointTools({
      root: FIXTURE,
      base: "/docs",
      trailingSlash: "always",
      routes: [
        { ...NOTES, patternRegex: /^\/api\/notes\/$/ },
        { ...NOTE, patternRegex: /^\/api\/notes\/([^/]+?)\/$/ },
      ],
    });
    assert.deepEqual(based.map((t) => t.path), ["/docs/api/notes/", "/docs/api/notes/", "/docs/api/notes/{note_id}/"]);

    // The matcher decides, not the config value: a route that answers without
    // the slash keeps its path whatever `trailingSlash` says.
    const lenient = await liftEndpointTools({
      root: FIXTURE,
      base: "/",
      trailingSlash: "always",
      routes: [{ ...NOTES, patternRegex: /^\/api\/notes\/?$/ }],
    });
    assert.deepEqual(lenient.map((t) => t.path), ["/api/notes", "/api/notes"]);
  });
});

describe("createRun402Adapter writes endpoint tools into adapter.json", () => {
  type Hooks = Record<string, ((params: unknown) => unknown) | undefined>;

  function resolvedRoute(route: EndpointRouteRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { pattern: route.pattern, isPrerendered: route.prerender, type: "endpoint", origin: "project", entrypoint: route.entrypoint, ...extra };
  }

  async function build(resolvedRoutes: unknown[], outRoot: string): Promise<Record<string, unknown>> {
    const hooks = createRun402Adapter().hooks as Hooks;
    await hooks["astro:config:done"]!({
      setAdapter() {},
      config: { outDir: pathToFileURL(outRoot + "/"), root: pathToFileURL(FIXTURE), base: "/", trailingSlash: "ignore" },
      logger: { info() {}, warn() {}, error() {} },
    });
    await hooks["astro:routes:resolved"]!({ routes: resolvedRoutes, logger: {} });
    await hooks["astro:build:start"]!({ logger: {} });
    await hooks["astro:build:done"]!({ pages: [], logger: { warn() {} } });
    return JSON.parse(readFileSync(path.join(outRoot, "run402", "adapter.json"), "utf-8"));
  }

  let out: string;
  before(() => {
    out = mkdtempSync(path.join(tmpdir(), "r402-endpoint-tools-"));
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("records the tools of the project's server-rendered endpoints", async () => {
    const manifest = await build(
      [
        resolvedRoute(NOTE, { patternRegex: /^\/api\/notes\/([^/]+?)\/?$/ }),
        resolvedRoute(NOTES, { pathname: "/api/notes", patternRegex: /^\/api\/notes\/?$/ }),
        { pattern: "/", isPrerendered: false, type: "page", origin: "project", entrypoint: "src/pages/index.astro" },
        // An endpoint an integration injects is not the project's file.
        { pattern: "/_image", isPrerendered: false, type: "endpoint", origin: "internal", entrypoint: "astro/assets/endpoint/generic" },
      ],
      out,
    );
    assert.deepEqual(manifest.tools, FIXTURE_TOOLS);
    assert.equal(manifest.version, "1.0");
    // Routes are still recorded for the release slice; tools add no route entry.
    assert.deepEqual((manifest.routes as Array<{ pattern: string }>).map((r) => r.pattern), ["/api/notes/[note_id]", "/api/notes", "/"]);
  });

  it("fails at astro:build:start, before anything is built, when a prerendered endpoint declares a tool", async () => {
    const hooks = createRun402Adapter().hooks as Hooks;
    await hooks["astro:config:done"]!({
      setAdapter() {},
      config: { outDir: pathToFileURL(out + "/"), root: pathToFileURL(FIXTURE) },
      logger: { info() {}, warn() {}, error() {} },
    });
    await hooks["astro:routes:resolved"]!({ routes: [resolvedRoute(NOTES), resolvedRoute(NOTE), resolvedRoute(FEED, { pathname: "/feed.json" })], logger: {} });
    const err = await refusal(hooks["astro:build:start"]!({ logger: {} }) as Promise<unknown>);
    assert.equal(err.code, "MCP_TOOL_ROUTE_ELSEWHERE");
    assert.equal(err.file, "src/pages/feed.json.ts");
  });

  it("writes `tools: []` for a build whose endpoints declare none", async () => {
    const manifest = await build([{ pattern: "/", isPrerendered: false, type: "page", origin: "project", entrypoint: "src/pages/index.astro" }], out);
    assert.deepEqual(manifest.tools, []);
  });
});

describe("liftEndpointTools: refusals carry the SDK's code, the file and the line", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "r402-endpoint-tools-src-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function endpoint(route: string, source: string, prerender = false): EndpointRouteRecord {
    const entrypoint = `src/pages${route}.ts`;
    const abs = path.join(root, entrypoint);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source);
    return { pattern: route, entrypoint, prerender };
  }

  it("a declaration that is not static", async () => {
    const route = endpoint(
      "/api/report",
      `import type { APIRoute } from "astro";\nconst schema = { type: "object" };\nexport const tool = {\n  name: "report",\n  description: "d",\n  input: schema,\n};\nexport const GET: APIRoute = () => new Response("ok");\n`,
    );
    const err = await refusal(liftEndpointTools({ root, routes: [route] }));
    assert.equal(err.code, "MCP_TOOL_NOT_STATIC");
    assert.equal(err.file, "src/pages/api/report.ts");
    assert.equal(err.line, 6);
    assert.equal(err.fieldPath, "tool.input");
  });

  it("a `tool` with no name, a missing method, and a rest segment", async () => {
    const unnamed = endpoint("/api/a", `export const tool = { description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\n`);
    assert.equal((await refusal(liftEndpointTools({ root, routes: [unnamed] }))).code, "MCP_TOOL_NAME_INVALID");

    const ambiguous = endpoint("/api/b", `export const tool = { name: "b", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\nexport const POST = GET;\n`);
    const err = await refusal(liftEndpointTools({ root, routes: [ambiguous] }));
    assert.equal(err.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(err.fieldPath, "tool.method");
    assert.equal(err.tool, "b");

    const rest = endpoint("/files/[...rest]", `export const tool = { name: "files", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\n`);
    assert.equal((await refusal(liftEndpointTools({ root, routes: [rest] }))).code, "MCP_TOOL_PATH_UNSUPPORTED");
  });

  it("two files that declare the same tool name", async () => {
    const one = endpoint("/api/one", `export const tool = { name: "search", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\n`);
    const two = endpoint("/api/two", `export const tools = { search: { description: "d", input: { type: "object" } } };\nexport const POST = () => new Response("ok");\n`);
    const err = await refusal(liftEndpointTools({ root, routes: [two, one] }));
    assert.equal(err.code, "MCP_TOOL_NAME_DUPLICATE");
    assert.equal(err.file, "src/pages/api/two.ts");
    assert.equal(err.tool, "search");
    assert.match(err.message, /src\/pages\/api\/one\.ts declares one/);
  });

  it("reads nothing, and never loads the SDK, when no endpoint may declare a tool", async () => {
    const plain = endpoint("/api/plain", `export const GET = () => new Response("ok");\n`);
    const tools = await liftEndpointTools({
      root,
      routes: [plain, { pattern: "/api/virtual", entrypoint: "virtual:not-a-file", prerender: false }],
      loadExtractor: async () => {
        throw new Error("the extractor must not be loaded");
      },
    });
    assert.deepEqual(tools, []);
  });

  it("names the SDK when the installed one cannot read declarations", async () => {
    const declared = endpoint("/api/old", `export const tool = { name: "old", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\n`);
    for (const loadExtractor of [async () => ({}), async () => { throw new Error("Cannot find package '@run402/sdk'"); }]) {
      const err = await refusal(liftEndpointTools({ root, routes: [declared], loadExtractor }));
      assert.equal(err.code, "R402_ASTRO_SDK_VERSION_TOO_OLD");
      assert.equal(err.file, "src/pages/api/old.ts");
      assert.match(err.message, /npm install @run402\/sdk@latest/);
    }
  });
});
