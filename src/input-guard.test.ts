import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { argumentError, strictInput } from "./input-guard.js";
import { upSchema } from "./tools/up.js";
import { runSchema } from "./tools/run.js";
import { toolErrorSchema } from "./structured.js";
import { deploySchema } from "./tools/deploy.js";
import { statusSchema } from "./tools/status.js";
import { whoamiSchema } from "./tools/whoami.js";
import { doctorSchema } from "./tools/doctor.js";
import { docsSchema } from "./tools/docs.js";
import { expandResultSchema } from "./tools/expand-result.js";
import { ArraySchema, ObjectSchema, RecordSchema, UnionSchema } from "./schema.js";

describe("argumentError", () => {
  const up = strictInput(upSchema);

  it("passes declared arguments", () => {
    assert.equal(argumentError("up", up, {}), null);
    assert.equal(argumentError("up", up, undefined), null);
  });

  it("refuses an unknown argument and names the closest declared one", () => {
    const declared = Object.keys(upSchema);
    const near = declared[0]!;
    const typo = near.slice(0, -1) + near.slice(-1).repeat(2);
    const error = argumentError("up", up, { bogus: 1, [typo]: "x" })!;
    toolErrorSchema.parse(error);
    assert.equal(error.code, "UNKNOWN_ARGUMENT");
    assert.match(error.message, /^up does not take the arguments /);
    const next = error.next_actions[0]!;
    assert.equal(next.type, "edit_request");
    assert.deepEqual((next.unknown as string[]).sort(), ["bogus", typo].sort());
    assert.ok((next.did_you_mean as Record<string, string[]>)[typo]!.includes(near));
    assert.deepEqual(next.accepted, declared);
  });

  it("reports a wrongly typed argument as INVALID_ARGUMENTS", () => {
    const error = argumentError("run", strictInput(runSchema), { code: 42 })!;
    toolErrorSchema.parse(error);
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.deepEqual((error.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path), ["code"]);
  });
});

describe("argumentError for a key nested inside an argument", () => {
  const deploy = strictInput(deploySchema);
  const fn = { source: "export default async () => new Response('ok');" };

  it("names the key by its path, with the keys declared beside it", () => {
    const error = argumentError("deploy", deploy, {
      project_id: "prj_1",
      functions: { patch: { set: { api: { ...fn, klass: "run" } } } },
    })!;
    toolErrorSchema.parse(error);
    assert.equal(error.code, "UNKNOWN_ARGUMENT");
    assert.match(error.message, /^deploy does not take the key functions\.patch\.set\.api\.klass \(did you mean class\?\)\. functions\.patch\.set\.api takes: runtime, source, /);
    assert.doesNotMatch(error.message, /argument/);
    assert.doesNotMatch(error.message, /It takes: project_id/);
    const next = error.next_actions[0]!;
    assert.deepEqual(next.unknown, ["functions.patch.set.api.klass"]);
    assert.deepEqual((next.did_you_mean as Record<string, string[]>)["functions.patch.set.api.klass"], ["functions.patch.set.api.class"]);
    assert.deepEqual(next.accepted, Object.keys(deploySchema));
    const acceptedAt = next.accepted_at as Record<string, string[]>;
    assert.deepEqual(Object.keys(acceptedAt), ["functions.patch.set.api"]);
    assert.ok(acceptedAt["functions.patch.set.api"]!.includes("class"));
    assert.deepEqual((error.details as { unknown: string[] }).unknown, ["functions.patch.set.api.klass"]);
  });

  it("names a top-level and a nested unknown key together, each with what its object takes", () => {
    const error = argumentError("deploy", deploy, {
      project_id: "prj_1",
      spec: {},
      functions: { replace: { api: { ...fn, require_auht: true } } },
    })!;
    assert.equal(error.code, "UNKNOWN_ARGUMENT");
    assert.match(error.message, /^deploy does not take the keys /);
    assert.match(error.message, /It takes: project_id, /);
    assert.match(error.message, /functions\.replace\.api takes: /);
    const next = error.next_actions[0]!;
    assert.deepEqual((next.unknown as string[]).sort(), ["functions.replace.api.require_auht", "spec"]);
    assert.ok((next.did_you_mean as Record<string, string[]>)["functions.replace.api.require_auht"]!.includes("functions.replace.api.require_auth"));
  });

  it("keeps a top-level refusal's wording and fields unchanged", () => {
    const error = argumentError("deploy", deploy, { project_id: "prj_1", bogus: 1 })!;
    assert.match(error.message, /^deploy does not take the argument bogus\. It takes: project_id, /);
    assert.equal(error.next_actions[0]!.accepted_at, undefined);
  });
});

describe("no tool argument is silently dropped", () => {
  // An object that strips undeclared keys would pass a typo to the handler
  // as if it were absent; every object in every tool's input is strict
  // (refuses) or loose (keeps and forwards).
  const tools = { up: upSchema, deploy: deploySchema, status: statusSchema, whoami: whoamiSchema, doctor: doctorSchema, docs: docsSchema, run: runSchema, expand_result: expandResultSchema };
  function stripping(schema: unknown, path: string, out: string[]): void {
    let at = schema as { inner?: unknown };
    while (at && at.inner) at = at.inner as { inner?: unknown };
    if (at instanceof ObjectSchema) {
      if (at.unknownKeys === "strip") out.push(path || "(arguments)");
      for (const [key, member] of Object.entries(at.shape as Record<string, unknown>)) stripping(member, path ? `${path}.${key}` : key, out);
    } else if (at instanceof ArraySchema) stripping(at.item, `${path}[]`, out);
    else if (at instanceof RecordSchema) stripping(at.valueSchema, `${path}.*`, out);
    else if (at instanceof UnionSchema) for (const option of at.options) stripping(option, path, out);
  }
  for (const [name, shape] of Object.entries(tools)) {
    it(`${name} strips no key`, () => {
      const out: string[] = [];
      stripping(strictInput(shape), "", out);
      assert.deepEqual(out, []);
    });
  }
});
