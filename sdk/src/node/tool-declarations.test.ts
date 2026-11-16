/**
 * Tool declaration extraction: conformance vectors.
 *
 * Source in, declarations out, or one refusal with its code, file, line and
 * field path. The property that matters most: extraction never runs the
 * source. The rest pins every accepted literal form, every refusal an agent
 * can hit, and the endpoint-file rules `@run402/astro` relies on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  endpointToolPath,
  extractToolDeclarations,
  liftFunctionTools,
  type ExtractToolDeclarationsOptions,
} from "./tool-declarations.js";
import { findDuplicateToolName, isValidMcpToolName } from "../function-tools.js";
import { isDeployError } from "../index.js";
import type { FunctionToolSpec } from "../namespaces/deploy.types.js";

const INPUT = `{ type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] }`;
const INPUT_VALUE = { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] };

function tools(source: string, options: ExtractToolDeclarationsOptions = { file: "fn.ts" }): FunctionToolSpec[] {
  const result = extractToolDeclarations(source, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.tools : [];
}

function problem(source: string, options: ExtractToolDeclarationsOptions = { file: "fn.ts" }) {
  const result = extractToolDeclarations(source, options);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("unreachable");
  return result.problem;
}

describe("extractToolDeclarations: a function file's accepted forms", () => {
  it("returns no tools when the file exports none", () => {
    assert.deepEqual(tools(`export default async () => new Response("x");`), []);
    assert.deepEqual(tools(`const tool = 1; export default tool;`), []);
    assert.deepEqual(tools(`// this tool is great\nexport const handler = 1;`), []);
    assert.deepEqual(tools(`module.exports = { tool: {} };`), []);
    assert.deepEqual(tools(``), []);
  });

  it("reads a single `tool`, as written, with no name", () => {
    assert.deepEqual(
      tools(`export const tool = { description: "Cancel one of the caller's bookings.", input: ${INPUT} };
export default async function handler(req) { return new Response("ok"); }`, { file: "cancel.js" }),
      [{ description: "Cancel one of the caller's bookings.", input: INPUT_VALUE }],
    );
  });

  it("reads `tools`: one entry per key, the key as the name, in source order, fields in a fixed order", () => {
    assert.deepEqual(
      JSON.stringify(tools(`export const tools = {
  list_events: { method: "GET", path: "/api/events", input: { type: "object", properties: { tag: { type: "string" } } }, description: "List events." },
  "create-event": { annotations: { destructiveHint: false }, title: "Create", description: "Create an event.", input: { type: "object" } },
};`)),
      JSON.stringify([
        { name: "list_events", description: "List events.", input: { type: "object", properties: { tag: { type: "string" } } }, method: "GET", path: "/api/events" },
        { name: "create-event", title: "Create", description: "Create an event.", input: { type: "object" }, annotations: { destructiveHint: false } },
      ]),
    );
  });

  it("reads an empty `tools` as none", () => {
    assert.deepEqual(tools(`export const tools = {};`), []);
  });

  it("reads a declaration written with `satisfies`", () => {
    const got = tools(`import type { ToolDeclaration } from "@run402/functions";
export const tool = { title: "Cancel", description: 'Cancel.', input: ${INPUT}, annotations: { destructiveHint: true } } satisfies ToolDeclaration;
export default async function handler(req: Request): Promise<Response> { return new Response("ok"); }`);
    assert.deepEqual(got, [{ title: "Cancel", description: "Cancel.", input: INPUT_VALUE, annotations: { destructiveHint: true } }]);
  });

  it("reads a declaration with a type annotation, and one written `as const`", () => {
    assert.equal(tools(`import type { ToolDeclaration } from "@run402/functions";
export const tool: ToolDeclaration = { description: "d", input: { type: "object" } };`).length, 1);
    assert.deepEqual(
      tools(`export const tools = { a: { description: "d", input: { type: "object" } } } as const;`).map((t) => t.name),
      ["a"],
    );
    assert.deepEqual(
      tools(`export const tools = { a: { description: "d", input: { type: "object" } } } as const satisfies Record<string, unknown>;`).map((t) => t.name),
      ["a"],
    );
  });

  it("reads a file with an `enum`, which type stripping cannot erase", () => {
    assert.deepEqual(
      tools(`enum Color { Red, Green }
export const tool = { description: "d", input: { type: "object" } };
export default async () => new Response(String(Color.Red));`),
      [{ description: "d", input: { type: "object" } }],
    );
  });

  it("follows a local binding through an `export { }` clause", () => {
    assert.equal(tools(`const tool = { description: "d", input: { type: "object" } };\nexport { tool };`, { file: "fn.mjs" }).length, 1);
    assert.deepEqual(
      tools(`const declared = { description: "d", input: { type: "object" } };\nexport { declared as tool };`),
      [{ description: "d", input: { type: "object" } }],
    );
    assert.deepEqual(
      tools(`const x = { a: { description: "d", input: { type: "object" } } };\nexport { x as tools };`).map((t) => t.name),
      ["a"],
    );
  });

  it("accepts a `let` or `var` binding the module never reassigns", () => {
    assert.equal(tools(`export let tool = { description: "d", input: { type: "object" } };`).length, 1);
    assert.equal(tools(`var tool = { description: "d", input: { type: "object" } };\nexport { tool };`).length, 1);
  });

  it("accepts templates without substitutions, negative numbers, null, and nested arrays", () => {
    assert.deepEqual(
      tools("export const tool = { description: `Plain template`, input: { type: \"object\", properties: { n: { type: \"number\", minimum: -5, default: null, enum: [1, 2.5, -3] } } } };"),
      [{ description: "Plain template", input: { type: "object", properties: { n: { type: "number", minimum: -5, default: null, enum: [1, 2.5, -3] } } } }],
    );
  });

  // Recorded from esbuild 0.28.2: `transform` and `build` of one TypeScript
  // function file, bundled and bundled + minified. A minifier writes `true`
  // as `!0` and `false` as `!1`, and exports a renamed local.
  it("reads esbuild bundle output", () => {
    const bundled = [
      `// <stdin>`,
      `var helper = (n) => n + 1;`,
      `var tools = {`,
      `  list_notes: {`,
      `    method: "GET",`,
      `    description: "List the caller's notes.",`,
      `    input: { type: "object", properties: { tag: { type: "string" } } },`,
      `    annotations: { readOnlyHint: true, destructiveHint: false }`,
      `  },`,
      `  add_note: {`,
      "    description: `Add a note.`,",
      `    input: { type: "object", properties: { title: { type: "string", maxLength: 200 }, n: { type: "number", minimum: -5 } }, required: ["title"] }`,
      `  }`,
      `};`,
      `var stdin_default = async (req) => new Response(String(helper(1)));`,
      `export {`,
      `  stdin_default as default,`,
      `  tools`,
      `};`,
    ].join("\n");
    const minified = `var e=t=>t+1,n={list_notes:{method:"GET",description:"List the caller's notes.",input:{type:"object",properties:{tag:{type:"string"}}},annotations:{readOnlyHint:!0,destructiveHint:!1}},add_note:{description:"Add a note.",input:{type:"object",properties:{title:{type:"string",maxLength:200},n:{type:"number",minimum:-5}},required:["title"]}}},o=async t=>new Response(String(e(1)));export{o as default,n as tools};`;
    const expected = [
      { name: "list_notes", description: "List the caller's notes.", input: { type: "object", properties: { tag: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false }, method: "GET" },
      { name: "add_note", description: "Add a note.", input: { type: "object", properties: { title: { type: "string", maxLength: 200 }, n: { type: "number", minimum: -5 } }, required: ["title"] } },
    ];
    assert.deepEqual(tools(bundled, { file: "index.js" }), expected);
    assert.deepEqual(tools(minified, { file: "index.js" }), expected);
    assert.equal(
      tools(`function greet(n) { return "hi " + n; }
var tool = { description: "d", input: { type: "object", properties: {} } };
var index_default = async (req) => Response.json({ greeting: greet("x") });
export { index_default as default, tool };`, { file: "index.js" }).length,
      1,
    );
  });
});

describe("extractToolDeclarations: never runs the source", () => {
  it("parses a file whose top level would throw or change globals", () => {
    const marker = "__run402_tool_extraction_side_effect__";
    delete (globalThis as Record<string, unknown>)[marker];
    const got = tools(`globalThis.${marker} = true;
throw new Error("top-level side effect ran");
export const tool = { description: "x", input: { type: "object" } };`, { file: "evil.js" });
    assert.equal(got.length, 1);
    assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  });
});

describe("extractToolDeclarations: MCP_TOOL_NOT_STATIC", () => {
  const cases: Array<[string, string, string, number]> = [
    ["a call", `export const tool = {\n  description: buildDescription(),\n  input: { type: "object" } };`, "tool.description", 2],
    ["a variable", `const schema = { type: "object" };\nexport const tool = { description: "d",\n  input: schema };`, "tool.input", 3],
    ["a spread", `const base = {};\nexport const tool = { ...base, description: "d", input: { type: "object" } };`, "tool", 2],
    ["a computed key", `const k = "description";\nexport const tool = { [k]: "d", input: { type: "object" } };`, "tool", 2],
    ["a template substitution", "const n = 1;\nexport const tool = { description: `d${n}`, input: { type: \"object\" } };", "tool.description", 2],
    ["a shorthand property", `const description = "d";\nexport const tool = { description, input: { type: "object" } };`, "tool.description", 2],
    ["a nested call", `export const tool = { description: "d", input: { type: "object", properties: {\n a: make() } } };`, "tool.input.properties.a", 2],
    ["a spread in an array", `const more = [];\nexport const tool = { description: "d", input: { type: "object", required: [...more] } };`, "tool.input.required[0]", 2],
    ["a method", `export const tool = { description: "d", input: { type: "object" }, run() {} };`, "tool", 1],
    ["a getter", `export const tool = { description: "d", get input() { return {}; } };`, "tool", 1],
    ["a regular expression", `export const tool = { description: "d", input: { type: "object", pattern: /a/ } };`, "tool.input.pattern", 1],
    ["a BigInt", `export const tool = { description: "d", input: { type: "object", maximum: 5n } };`, "tool.input.maximum", 1],
    ["`undefined`", `export const tool = { description: "d", input: { type: "object" }, title: undefined };`, "tool.title", 1],
    ["string concatenation", `export const tool = { description: "a" + "b", input: { type: "object" } };`, "tool.description", 1],
    ["a wrapped call", `export const tool = Object.freeze({ description: "d", input: { type: "object" } });`, "tool", 1],
    ["a variable inside `tools`", `const add = { description: "d", input: { type: "object" } };\nexport const tools = {\n  list: { description: "d", input: { type: "object" } },\n  add,\n};`, "tools.add", 4],
    ["a computed tool name", `const name = "add";\nexport const tools = { [name]: { description: "d", input: { type: "object" } } };`, "tools", 2],
    ["`tools` assigned from a variable", `const all = {};\nexport const tools = all;`, "tools", 2],
  ];
  for (const [name, source, fieldPath, line] of cases) {
    it(`refuses ${name} with the file, the line and the field path`, () => {
      const p = problem(source, { file: "functions/api.ts" });
      assert.equal(p.code, "MCP_TOOL_NOT_STATIC", JSON.stringify(p));
      assert.equal(p.file, "functions/api.ts");
      assert.equal(p.field_path, fieldPath);
      assert.equal(p.line, line);
    });
  }

  it("refuses a reassigned binding, a function or class named tool, and a re-export from another module", () => {
    for (const source of [
      `export let tool = { description: "d", input: { type: "object" } }; tool = {};`,
      `var tool = { description: "d", input: { type: "object" } }; function f() { tool++; } export { tool };`,
      `var tool = { description: "d", input: { type: "object" } }; [tool] = [1]; export { tool };`,
      `var tool = { description: "d", input: { type: "object" } }; ({ a: tool } = {}); export { tool };`,
      `var tool = { description: "d", input: { type: "object" } }; for (tool of []) {} export { tool };`,
      `var x = { a: { description: "d", input: { type: "object" } } }; x = {}; export { x as tools };`,
      `export function tool() {}`,
      `export class tools {}`,
      `export { tool } from "./elsewhere.js";`,
      `import { tools } from "./elsewhere.js"; export { tools };`,
      `export * as tools from "./elsewhere.js";`,
      `export let tool;`,
      `export const { tool } = make();`,
    ]) {
      const p = problem(source);
      assert.equal(p.code, "MCP_TOOL_NOT_STATIC", source);
      assert.equal(p.line, 1, source);
    }
  });

  it("reports no line for a file read in transform mode, where lines have moved", () => {
    const p = problem(`enum Color { Red, Green }
export const tool = { description: describe(), input: { type: "object" } };`);
    assert.equal(p.code, "MCP_TOOL_NOT_STATIC");
    assert.equal(p.field_path, "tool.description");
    assert.equal(p.line, undefined);
  });

  it("keeps the source's line numbers through type stripping", () => {
    const p = problem(`import type { ToolDeclaration } from "@run402/functions";
interface Booking {
  id: string;
}
export const tool = {
  description: "d",
  input: schemaFor<Booking>(),
} satisfies ToolDeclaration;`);
    assert.equal(p.line, 7);
    assert.equal(p.field_path, "tool.input");
  });

  it("refuses a file it cannot parse when the file exports a tool, and reads none from one that does not", () => {
    const jsx = `export const tool = { description: "d", input: { type: "object" } };\nexport default () => <div />;`;
    const p = problem(jsx, { file: "fn.tsx" });
    assert.equal(p.code, "MCP_TOOL_NOT_STATIC");
    assert.equal(p.field_path, "tool");
    assert.match(p.message, /could not be parsed/);
    assert.deepEqual(tools(`// a tool to render\nexport default () => <div />;`, { file: "fn.tsx" }), []);
  });
});

describe("extractToolDeclarations: MCP_TOOL_SCHEMA_INVALID", () => {
  const one = (fields: string) => `export const tool = {\n${fields}\n};`;
  const cases: Array<[string, string, string, number | undefined]> = [
    ["a missing description", one(`  input: { type: "object" },`), "tool.description", 1],
    ["an empty description", one(`  description: " ",\n  input: { type: "object" },`), "tool.description", 2],
    ["a description over 1024 characters", one(`  description: "${"x".repeat(1025)}",\n  input: { type: "object" },`), "tool.description", 2],
    ["a missing input", one(`  description: "d",`), "tool.input", 1],
    ["an input that is not an object", one(`  description: "d",\n  input: "object",`), "tool.input", 3],
    ["an input whose root type is not object", one(`  description: "d",\n  input: {\n    type: "string" },`), "tool.input.type", 4],
    ["an input with no root type", one(`  description: "d",\n  input: { properties: {} },`), "tool.input.type", 3],
    ["an unknown annotation", one(`  description: "d",\n  input: { type: "object" },\n  annotations: { sneaky: true },`), "tool.annotations.sneaky", 4],
    ["an annotation that is not a boolean", one(`  description: "d",\n  input: { type: "object" },\n  annotations: {\n    readOnlyHint: "yes" },`), "tool.annotations.readOnlyHint", 5],
    ["an unknown method", one(`  description: "d",\n  input: { type: "object" },\n  method: "HEAD",`), "tool.method", 4],
    ["a method in lower case", one(`  description: "d",\n  input: { type: "object" },\n  method: "get",`), "tool.method", 4],
    ["an unknown field", one(`  description: "d",\n  input: { type: "object" },\n  handler: "x",`), "tool.handler", 4],
    ["an empty title", one(`  description: "d",\n  input: { type: "object" },\n  title: "",`), "tool.title", 4],
    ["a path that is not absolute", one(`  description: "d",\n  input: { type: "object" },\n  path: "api/notes",`), "tool.path", 4],
    ["a path parameter that input does not declare", one(`  description: "d",\n  input: { type: "object", properties: {} },\n  path: "/api/notes/{note_id}",`), "tool.input.properties.note_id", 3],
    ["a path parameter that is not required", one(`  description: "d",\n  input: { type: "object", properties: { note_id: { type: "string" } } },\n  path: "/api/notes/{note_id}",`), "tool.input.required", 3],
    ["a path parameter that is an object", one(`  description: "d",\n  input: { type: "object", properties: { note_id: {\n    type: "object" } }, required: ["note_id"] },\n  path: "/api/notes/{note_id}",`), "tool.input.properties.note_id.type", 4],
    ["a declaration that is an array", `export const tool = [];`, "tool", 1],
    ["`tools` that is an array", `export const tools = [{ description: "d", input: { type: "object" } }];`, "tools", 1],
    ["a `name` under `tools`", `export const tools = {\n  add: {\n    name: "add", description: "d", input: { type: "object" } },\n};`, "tools.add.name", 3],
  ];
  for (const [name, source, fieldPath, line] of cases) {
    it(`refuses ${name}`, () => {
      const p = problem(source, { file: "functions/api.ts" });
      assert.equal(p.code, "MCP_TOOL_SCHEMA_INVALID", JSON.stringify(p));
      assert.equal(p.field_path, fieldPath);
      assert.equal(p.line, line);
      assert.equal(p.file, "functions/api.ts");
    });
  }

  it("refuses a file that exports both `tool` and `tools`, at the second", () => {
    const p = problem(`export const tool = { description: "d", input: { type: "object" } };
export const tools = { a: { description: "d", input: { type: "object" } } };`);
    assert.equal(p.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(p.field_path, "tools");
    assert.equal(p.line, 2);
    assert.match(p.message, /never both/);
  });

  it("names the tool a refusal belongs to", () => {
    const p = problem(`export const tools = { list: { description: "d", input: { type: "object" } }, add: { description: "", input: { type: "object" } } };`);
    assert.equal(p.tool, "add");
    assert.equal(p.field_path, "tools.add.description");
  });

  it("accepts a function file's path with a declared, required parameter", () => {
    assert.deepEqual(
      tools(`export const tool = { name: "get_note", method: "GET", path: "/api/notes/{note_id}", description: "d", input: { type: "object", properties: { note_id: { type: "integer" } }, required: ["note_id"] } };`),
      [{ name: "get_note", description: "d", input: { type: "object", properties: { note_id: { type: "integer" } }, required: ["note_id"] }, method: "GET", path: "/api/notes/{note_id}" }],
    );
  });
});

describe("extractToolDeclarations: names and paths", () => {
  it("refuses a tool name that is not a valid MCP tool name", () => {
    const p = problem(`export const tools = {\n  "has space": { description: "d", input: { type: "object" } },\n};`);
    assert.equal(p.code, "MCP_TOOL_NAME_INVALID");
    assert.equal(p.field_path, "tools.has space");
    assert.equal(p.line, 2);
    const q = problem(`export const tool = { name: "a/b", description: "d", input: { type: "object" } };`);
    assert.equal(q.code, "MCP_TOOL_NAME_INVALID");
    assert.equal(q.field_path, "tool.name");
  });

  it("refuses the same name twice in one `tools`", () => {
    const p = problem(`export const tools = {\n  a: { description: "d", input: { type: "object" } },\n  "a": { description: "e", input: { type: "object" } },\n};`);
    assert.equal(p.code, "MCP_TOOL_NAME_DUPLICATE");
    assert.equal(p.tool, "a");
    assert.equal(p.line, 3);
  });

  it("refuses a wildcard, a rest segment and a partial parameter in a path", () => {
    for (const path of ["/api/*", "/files/{...rest}", "/post-{id}"]) {
      const p = problem(`export const tool = { description: "d", input: { type: "object" }, path: "${path}" };`);
      assert.equal(p.code, "MCP_TOOL_PATH_UNSUPPORTED", path);
      assert.equal(p.field_path, "tool.path");
    }
  });

  it("isValidMcpToolName accepts function-style names and refuses the rest", () => {
    assert.ok(isValidMcpToolName("cancel_booking"));
    assert.ok(isValidMcpToolName("list-bookings.v2"));
    assert.ok(!isValidMcpToolName(""));
    assert.ok(!isValidMcpToolName("has space"));
    assert.ok(!isValidMcpToolName("x".repeat(129)));
  });

  it("findDuplicateToolName names both owners, counting a default name", () => {
    assert.equal(findDuplicateToolName([{ owner: "a", tools: [{ name: "x" }] }, { owner: "b", tools: [{ name: "y" }] }]), null);
    assert.deepEqual(
      findDuplicateToolName([{ owner: "search", tools: [{}], defaultName: "search" }, { owner: "portal", tools: [{ name: "list" }, { name: "search" }] }]),
      { name: "search", owners: ["search", "portal"] },
    );
  });
});

describe("extractToolDeclarations: an Astro endpoint file", () => {
  const endpoint = (route: string, extra: Partial<NonNullable<ExtractToolDeclarationsOptions["endpoint"]>> = {}): ExtractToolDeclarationsOptions => ({
    file: `src/pages${route}.ts`,
    endpoint: { route, ...extra },
  });

  it("binds a single `tool` to the one handler the file exports, on the endpoint's own route", () => {
    assert.deepEqual(
      tools(`import type { APIRoute } from "astro";
export const tool = { name: "update_note", description: "Update a note.", input: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id"] } };
export const POST: APIRoute = async ({ params, request }) => new Response(null, { status: 204 });`, endpoint("/api/notes/[note_id]")),
      [{
        name: "update_note",
        description: "Update a note.",
        input: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id"] },
        method: "POST",
        path: "/api/notes/{note_id}",
      }],
    );
  });

  it("binds `tools` to the handlers they state, in source order", () => {
    assert.deepEqual(
      tools(`export const tools = {
  list_notes: { method: "GET", description: "List notes.", input: { type: "object", properties: { tag: { type: "string" } } } },
  add_note: { method: "POST", description: "Add a note.", input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
};
export async function GET() { return Response.json([]); }
export const POST = async () => new Response(null, { status: 201 });`, endpoint("/api/notes")),
      [
        { name: "list_notes", description: "List notes.", input: { type: "object", properties: { tag: { type: "string" } } }, method: "GET", path: "/api/notes" },
        { name: "add_note", description: "Add a note.", input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, method: "POST", path: "/api/notes" },
      ],
    );
  });

  it("applies the project's base and a required trailing slash", () => {
    const source = `export const tool = { name: "ping", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");`;
    assert.equal(tools(source, endpoint("/api/ping", { base: "/docs/" }))[0]!.path, "/docs/api/ping");
    assert.equal(tools(source, endpoint("/api/ping", { base: "/" }))[0]!.path, "/api/ping");
    assert.equal(tools(source, endpoint("/api/ping", { trailingSlash: true }))[0]!.path, "/api/ping/");
    assert.equal(tools(source, endpoint("/", { base: "/docs" }))[0]!.path, "/docs");
    assert.equal(tools(source, endpoint("/"))[0]!.path, "/");
    assert.equal(tools(source, endpoint("/feed.json"))[0]!.path, "/feed.json");
  });

  it("accepts a stated method that `ALL` answers, and a handler exported through a clause", () => {
    assert.equal(
      tools(`export const tool = { name: "ping", method: "PUT", description: "d", input: { type: "object" } };\nexport const ALL = () => new Response("ok");`, endpoint("/api/ping"))[0]!.method,
      "PUT",
    );
    assert.equal(
      tools(`const handler = () => new Response("ok");\nexport const tool = { name: "ping", description: "d", input: { type: "object" } };\nexport { handler as DELETE };`, endpoint("/api/ping"))[0]!.method,
      "DELETE",
    );
    // HEAD and OPTIONS are not tool methods, so they do not make the default ambiguous.
    assert.equal(
      tools(`export const tool = { name: "ping", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\nexport const HEAD = GET;\nexport const OPTIONS = GET;`, endpoint("/api/ping"))[0]!.method,
      "GET",
    );
  });

  it("refuses a `tool` with no name", () => {
    const p = problem(`export const tool = { description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");`, endpoint("/api/ping"));
    assert.equal(p.code, "MCP_TOOL_NAME_INVALID");
    assert.equal(p.field_path, "tool.name");
    assert.equal(p.file, "src/pages/api/ping.ts");
    assert.equal(p.line, 1);
  });

  it("refuses a missing method when the file exports several handlers, or `ALL`", () => {
    const several = problem(`export const tool = { name: "ping", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");\nexport const POST = GET;`, endpoint("/api/ping"));
    assert.equal(several.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(several.field_path, "tool.method");
    assert.match(several.message, /GET, POST/);
    const all = problem(`export const tool = { name: "ping", description: "d", input: { type: "object" } };\nexport const ALL = () => new Response("ok");`, endpoint("/api/ping"));
    assert.equal(all.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(all.field_path, "tool.method");
  });

  it("refuses a stated method the file does not export, and a file with no handler", () => {
    const p = problem(`export const tools = {\n  ping: {\n    method: "PATCH", description: "d", input: { type: "object" } },\n};\nexport const GET = () => new Response("ok");`, endpoint("/api/ping"));
    assert.equal(p.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(p.field_path, "tools.ping.method");
    assert.equal(p.line, 3);
    assert.equal(p.tool, "ping");
    const none = problem(`export const tool = { name: "ping", description: "d", input: { type: "object" } };`, endpoint("/api/ping"));
    assert.equal(none.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(none.field_path, "tool.method");
  });

  it("refuses a written `path`: it is the endpoint's own route", () => {
    const p = problem(`export const tool = { name: "ping", path: "/api/ping", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");`, endpoint("/api/ping"));
    assert.equal(p.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(p.field_path, "tool.path");
  });

  it("refuses a route parameter that input does not declare as required", () => {
    const p = problem(`export const tool = { name: "get_note", description: "d", input: { type: "object", properties: {} } };\nexport const GET = () => new Response("ok");`, endpoint("/api/notes/[note_id]"));
    assert.equal(p.code, "MCP_TOOL_SCHEMA_INVALID");
    assert.equal(p.field_path, "tool.input.properties.note_id");
  });

  it("refuses a tool on a prerendered endpoint: a static file answers that path", () => {
    const p = problem(`export const prerender = true;\nexport const tool = { name: "feed", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("[]");`, endpoint("/feed.json", { prerendered: true }));
    assert.equal(p.code, "MCP_TOOL_ROUTE_ELSEWHERE");
    assert.equal(p.file, "src/pages/feed.json.ts");
    assert.equal(p.line, 2);
    assert.equal(p.field_path, "tool");
    assert.match(p.message, /static file answers/);
  });

  it("refuses a tool on a route with a rest segment or a partial parameter", () => {
    for (const route of ["/files/[...rest]", "/post-[id]"]) {
      const p = problem(`export const tool = { name: "x", description: "d", input: { type: "object" } };\nexport const GET = () => new Response("ok");`, endpoint(route));
      assert.equal(p.code, "MCP_TOOL_PATH_UNSUPPORTED", route);
      assert.equal(p.line, 1);
    }
  });

  it("reads none from an endpoint that declares none, prerendered or not", () => {
    assert.deepEqual(tools(`export const GET = () => new Response("ok");`, endpoint("/api/ping")), []);
    assert.deepEqual(tools(`export const prerender = true;\nexport const GET = () => new Response("ok");`, endpoint("/feed.json", { prerendered: true })), []);
  });

  it("endpointToolPath turns a route into a tool path", () => {
    assert.deepEqual(endpointToolPath("/api/notes/[note_id]"), { ok: true, path: "/api/notes/{note_id}", params: ["note_id"] });
    assert.deepEqual(endpointToolPath("/[org]/items/[item]", { base: "/app" }), { ok: true, path: "/app/{org}/items/{item}", params: ["org", "item"] });
    assert.deepEqual(endpointToolPath("/files/[...rest]"), { ok: false, segment: "[...rest]" });
  });
});

describe("liftFunctionTools: the reader the Node entry installs", () => {
  it("returns the declarations, or none", () => {
    assert.deepEqual(liftFunctionTools({ functionName: "api", source: `export default async () => new Response("x");`, file: null, sourceField: "functions.replace.api.source" }), []);
    assert.deepEqual(
      liftFunctionTools({ functionName: "cancel", source: `export const tool = { description: "d", input: { type: "object" } };`, file: "/app/functions/cancel.ts", sourceField: "functions.replace.cancel.source" }),
      [{ description: "d", input: { type: "object" } }],
    );
  });

  it("throws the deploy error an agent can act on: code, resource, file, line, field path, edit_request", () => {
    try {
      liftFunctionTools({
        functionName: "portal",
        source: `export const tools = {\n  list_events: { description: "d", input: { type: "object" } },\n  create_event: { description: describe(), input: { type: "object" } },\n};`,
        file: "/app/functions/portal.ts",
        sourceField: "functions.replace.portal.source",
      });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(isDeployError(err));
      assert.equal(err.code, "MCP_TOOL_NOT_STATIC");
      assert.equal(err.status, null);
      assert.equal(err.phase, "validate");
      assert.equal(err.resource, "functions.portal.tools.create_event");
      assert.deepEqual(err.details, { function: "portal", tool: "create_event", file: "/app/functions/portal.ts", line: 3, field_path: "tools.create_event.description" });
      assert.equal(err.nextActions?.[0]?.type, "edit_request");
      assert.equal(err.nextActions?.[0]?.file, "/app/functions/portal.ts");
      assert.equal(err.nextActions?.[0]?.line, 3);
      assert.match(err.message, /\/app\/functions\/portal\.ts:3/);
    }
  });

  it("names the source field when the source has no file", () => {
    assert.throws(
      () => liftFunctionTools({ functionName: "api", source: `export const tool = { description: "", input: { type: "object" } };`, file: null, sourceField: "functions.patch.set.api.source" }),
      (err: unknown) => isDeployError(err) && err.code === "MCP_TOOL_SCHEMA_INVALID" && /functions\.patch\.set\.api\.source:1/.test(err.message) && err.resource === "functions.api.tools",
    );
  });

  it("refuses a single `tool` whose function name is not a valid MCP tool name", () => {
    assert.throws(
      () => liftFunctionTools({ functionName: "has space", source: `export const tool = { description: "d", input: { type: "object" } };`, file: null, sourceField: "functions.replace.has space.source" }),
      (err: unknown) => isDeployError(err) && err.code === "MCP_TOOL_NAME_INVALID",
    );
    assert.equal(
      liftFunctionTools({ functionName: "has space", source: `export const tool = { name: "fine", description: "d", input: { type: "object" } };`, file: null, sourceField: "x" }).length,
      1,
    );
  });
});
