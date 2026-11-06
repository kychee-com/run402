import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { argumentError, strictInput } from "./input-guard.js";
import { upSchema } from "./tools/up.js";
import { runSchema } from "./tools/run.js";
import { toolErrorSchema } from "./structured.js";

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
