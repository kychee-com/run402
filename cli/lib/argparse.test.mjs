import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { positionalArgs } from "./argparse.mjs";

describe("positionalArgs", () => {
  it("keeps a bare dash as a positional: it is the stdin marker, never a flag", () => {
    assert.deepEqual(positionalArgs(["set", "-"]), ["set", "-"]);
    assert.deepEqual(positionalArgs(["-", "--uri", "x"], ["--uri"]), ["-"]);
  });

  it("still skips flags and the values of value-taking flags", () => {
    assert.deepEqual(positionalArgs(["a", "--org", "o", "-h", "--json", "b"], ["--org"]), ["a", "b"]);
  });
});
