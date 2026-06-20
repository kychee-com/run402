import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deprecatePositional, _resetDeprecationWarnings } from "./deprecate.js";

describe("deprecatePositional", () => {
  let writes: string[];
  let originalWrite: typeof process.stderr.write;
  let originalEnv: string | undefined;

  beforeEach(() => {
    _resetDeprecationWarnings();
    writes = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    originalEnv = process.env.RUN402_SUPPRESS_DEPRECATIONS;
    delete process.env.RUN402_SUPPRESS_DEPRECATIONS;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (originalEnv === undefined) delete process.env.RUN402_SUPPRESS_DEPRECATIONS;
    else process.env.RUN402_SUPPRESS_DEPRECATIONS = originalEnv;
  });

  it("warns once per method to stderr, including the hint", () => {
    deprecatePositional("ns.foo", "use the object form");
    deprecatePositional("ns.foo", "use the object form");
    assert.equal(writes.length, 1);
    assert.match(writes[0], /DEPRECATED: ns\.foo/);
    assert.match(writes[0], /use the object form/);
  });

  it("warns separately for distinct methods", () => {
    deprecatePositional("ns.foo");
    deprecatePositional("ns.bar");
    assert.equal(writes.length, 2);
  });

  it("is silenced by RUN402_SUPPRESS_DEPRECATIONS", () => {
    process.env.RUN402_SUPPRESS_DEPRECATIONS = "1";
    deprecatePositional("ns.foo");
    assert.equal(writes.length, 0);
  });

  it("never writes to stdout", () => {
    const stdoutWrites: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      deprecatePositional("ns.baz");
    } finally {
      process.stdout.write = origStdout;
    }
    assert.equal(stdoutWrites.length, 0);
    assert.equal(writes.length, 1);
  });
});
