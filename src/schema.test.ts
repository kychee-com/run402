import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { toJsonSchema, z } from "./schema.js";
import { strictInput } from "./input-guard.js";
import { OUTPUT_SCHEMAS } from "./structured.js";
import { upSchema } from "./tools/up.js";
import { deploySchema } from "./tools/deploy.js";
import { statusSchema } from "./tools/status.js";
import { whoamiSchema } from "./tools/whoami.js";
import { doctorSchema } from "./tools/doctor.js";
import { docsSchema } from "./tools/docs.js";
import { runSchema } from "./tools/run.js";
import { expandResultSchema } from "./tools/expand-result.js";

// The tools/list run402-mcp 4.142.0 published (zod 3 through
// zod-to-json-schema), recorded before the builder replaced zod.
type Published = { name: string; inputSchema: unknown; outputSchema: unknown };
const PUBLISHED = JSON.parse(readFileSync(new URL("./fixtures/tools-list-4.142.0.json", import.meta.url), "utf8")) as Published[];

const INPUTS = {
  up: upSchema,
  deploy: deploySchema,
  status: statusSchema,
  whoami: whoamiSchema,
  doctor: doctorSchema,
  docs: docsSchema,
  run: runSchema,
  expand_result: expandResultSchema,
} as const;

describe("tool schemas publish what 4.142.0 published", () => {
  it("the fixture holds the eight tools", () => {
    assert.deepEqual(PUBLISHED.map((t) => t.name).sort(), Object.keys(INPUTS).sort());
  });
  for (const tool of PUBLISHED) {
    const name = tool.name as keyof typeof INPUTS;
    it(`${name} inputSchema, byte for byte`, () => {
      assert.equal(JSON.stringify(toJsonSchema(strictInput(INPUTS[name]))), JSON.stringify(tool.inputSchema));
    });
    it(`${name} outputSchema, byte for byte`, () => {
      assert.equal(JSON.stringify(toJsonSchema(OUTPUT_SCHEMAS[name])), JSON.stringify(tool.outputSchema));
    });
  }
});

describe("parse", () => {
  const schema = z
    .object({
      name: z.string().min(1),
      count: z.number().int().optional(),
      kind: z.enum(["a", "b"]).optional(),
      nested: z.object({ keep: z.string() }).optional(),
      open: z.object({ id: z.string() }).loose().optional(),
      either: z.union([z.literal("x"), z.number()]).optional(),
      maybe: z.string().nullable().optional(),
      map: z.record(z.string(), z.boolean()).optional(),
      list: z.array(z.string()).min(1).optional(),
      anything: z.unknown(),
    })
    .strict();

  it("accepts a valid value, strips undeclared keys of a plain object, keeps a loose one's", () => {
    const parsed = schema.safeParse({ name: "n", nested: { keep: "k", drop: 1 }, open: { id: "i", extra: 2 }, either: 3, maybe: null, map: { a: true }, list: ["x"] });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data, { name: "n", nested: { keep: "k" }, open: { id: "i", extra: 2 }, either: 3, maybe: null, map: { a: true }, list: ["x"] });
  });

  it("names undeclared keys of a strict object as unrecognized_keys", () => {
    const parsed = schema.safeParse({ name: "n", bogus: 1, other: 2 });
    assert.equal(parsed.success, false);
    assert.deepEqual(!parsed.success && parsed.issues.map((i) => [i.code, i.keys, i.path]), [["unrecognized_keys", ["bogus", "other"], []]]);
  });

  it("reports each failure at its path", () => {
    const parsed = schema.safeParse({ name: "", count: 1.5, kind: "c", list: [], map: { a: "no" } });
    assert.equal(parsed.success, false);
    assert.deepEqual(!parsed.success && parsed.issues.map((i) => i.path.join(".")).sort(), ["count", "kind", "list", "map.a", "name"]);
  });

  it("refuses a missing required member and a wrong type", () => {
    const parsed = schema.safeParse({ count: "1" });
    assert.equal(parsed.success, false);
    assert.deepEqual(!parsed.success && parsed.issues.map((i) => i.path.join(".")).sort(), ["count", "name"]);
  });

  it("runs a refinement on the parsed value, at its declared path", () => {
    const pair = z.object({ id: z.string().optional(), name: z.string().optional() }).strict().refine((v) => (v.id === undefined) !== (v.name === undefined), { message: "exactly one", path: ["id"] });
    assert.equal(pair.safeParse({ id: "a" }).success, true);
    const both = pair.safeParse({ id: "a", name: "b" });
    assert.deepEqual(!both.success && both.issues.map((i) => [i.path.join("."), i.message]), [["id", "exactly one"]]);
  });

  it("keeps a member named __proto__ as an own property", () => {
    const open = z.object({}).loose();
    const parsed = open.safeParse(JSON.parse(`{"__proto__":{"x":1}}`));
    assert.equal(parsed.success, true);
    assert.equal(Object.getPrototypeOf(parsed.success && parsed.data), Object.prototype);
    assert.deepEqual(Object.keys(parsed.success ? parsed.data : {}), ["__proto__"]);
  });
});
