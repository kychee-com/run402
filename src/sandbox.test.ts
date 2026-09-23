import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_GLOBALS, prepareSnippet, runInSandbox, type SandboxExtension } from "./sandbox.js";

/** Stands in for the chain proxy so the inventory is the one a `run` snippet sees. */
const R_STUB: SandboxExtension = {
  install: "(function () { Object.defineProperty(globalThis, 'r', { value: {}, writable: true, configurable: true }); })",
};

async function run(code: string, timeoutMs = 5_000) {
  return runInSandbox({ code, timeoutMs, extensions: [R_STUB] });
}

function value(outcome: { status: string; value_json?: string; error?: unknown }): unknown {
  assert.equal(outcome.status, "ok", `expected ok, got ${JSON.stringify(outcome.error)}`);
  return outcome.value_json === undefined ? undefined : JSON.parse(outcome.value_json);
}

describe("sandbox global inventory", () => {
  it("is exactly SANDBOX_GLOBALS (a new global is a deliberate diff)", async () => {
    const names = value(await run("Object.getOwnPropertyNames(globalThis).sort()"));
    assert.deepEqual(names, [...SANDBOX_GLOBALS]);
  });

  it("pins the inventory snapshot itself", () => {
    assert.deepEqual([...SANDBOX_GLOBALS], [
      "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean",
      "DataView", "Date", "Error", "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array",
      "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array", "InternalError",
      "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
      "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError",
      "TextDecoder", "TextEncoder", "TypeError", "URIError", "URL", "Uint16Array", "Uint32Array", "Uint8Array",
      "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "console", "crypto", "decodeURI",
      "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis", "isFinite",
      "isNaN", "parseFloat", "parseInt", "r", "structuredClone", "undefined", "unescape",
    ]);
  });

  it("has no require, process, fetch, timers, or Node builtins", async () => {
    const got = value(await run(
      "[typeof require, typeof process, typeof fetch, typeof setTimeout, typeof setInterval, typeof queueMicrotask, typeof Buffer, typeof module, typeof globalThis.Run402]",
    ));
    assert.deepEqual(got, Array(9).fill("undefined"));
  });

  it("has no module loader: import() rejects and reaches nothing", async () => {
    const outcome = await run("await import('node:fs')");
    assert.equal(outcome.status, "error");
    assert.equal(outcome.error?.code, "RUN_EXCEPTION");
    assert.match(outcome.error?.message ?? "", /could not load module/);
  });

  it("refuses static import syntax as a syntax error", async () => {
    const outcome = await run("import fs from 'node:fs';\nfs");
    assert.equal(outcome.error?.code, "RUN_SYNTAX_ERROR");
  });

  it("offers the web builtins the design lists", async () => {
    const got = value(await run(
      "const u = new URL('/x?y=1#h', 'https://a.example');\n" +
      "[u.href, u.hostname, u.search, URL.canParse('nope'), new TextDecoder().decode(new TextEncoder().encode('héllo ✓ 😀')),\n" +
      " structuredClone({ a: [1, { b: 2 }] }), crypto.randomUUID().length]",
    ));
    assert.deepEqual(got, ["https://a.example/x?y=1#h", "a.example", "?y=1", false, "héllo ✓ 😀", { a: [1, { b: 2 }] }, 36]);
  });

  it("structuredClone refuses a function", async () => {
    const outcome = await run("structuredClone({ f() {} })");
    assert.equal(outcome.error?.code, "RUN_EXCEPTION");
    assert.match(outcome.error?.message ?? "", /DataCloneError/);
  });
});

describe("snippet contract", () => {
  it("returns the value of the last expression statement", async () => {
    assert.equal(value(await run("const a = 20;\na + 22")), 42);
  });

  it("honors an explicit return, including an early one", async () => {
    assert.equal(value(await run("if (true) { return 'early' }\n'late'")), "early");
    assert.deepEqual(value(await run("return { ok: true }")), { ok: true });
  });

  it("supports top-level await", async () => {
    assert.equal(value(await run("const v = await Promise.resolve(7);\nv * 6")), 42);
  });

  it("strips TypeScript types", async () => {
    assert.equal(value(await run("interface P { n: number }\nconst p: P = { n: 2 };\nconst f = <T,>(x: T): T => x;\nf<number>(p.n) * 21")), 42);
  });

  it("reports undefined as value_kind undefined, never as null data", async () => {
    const outcome = await run("let a = 1");
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.value_json, undefined);
    assert.equal(outcome.value_kind, "undefined");
  });

  it("captures console lines with their level and never prints them", async () => {
    const outcome = await run("console.log('hi', { a: 1 });\nconsole.warn(1, 2);\nconsole.error(new TypeError('bad'));\n5");
    assert.equal(value(outcome), 5);
    assert.deepEqual(outcome.logs, [
      { level: "log", line: 'hi {"a":1}' },
      { level: "warn", line: "1 2" },
      { level: "error", line: "TypeError: bad" },
    ]);
  });

  it("caps console lines and says how many it dropped", async () => {
    const outcome = await run("for (let i = 0; i < 510; i++) console.log(i);\nconsole.log('x'.repeat(3000))");
    assert.equal(outcome.logs.length, 500);
    assert.equal(outcome.logs_dropped, 11);
  });
});

describe("errors", () => {
  it("names the line and column of a syntax error", async () => {
    const outcome = await run("const a = 1;\nconst b = (;\n");
    assert.equal(outcome.error?.code, "RUN_SYNTAX_ERROR");
    assert.equal(outcome.error?.line, 2);
    assert.equal(outcome.error?.column, 12);
  });

  it("maps line-1 columns back past the wrapper", async () => {
    const outcome = await run("const = 3");
    assert.equal(outcome.error?.code, "RUN_SYNTAX_ERROR");
    assert.equal(outcome.error?.line, 1);
    assert.equal(outcome.error?.column, 7);
  });

  it("rejects TypeScript that needs transpilation (enum) with its line", async () => {
    const outcome = await run("const a = 1;\nenum X { A }\n");
    assert.equal(outcome.error?.code, "RUN_SYNTAX_ERROR");
    assert.equal(outcome.error?.line, 2);
    assert.match(outcome.error?.message ?? "", /enum/);
  });

  it("refuses a snippet that closes the wrapper early", () => {
    const prepared = prepareSnippet("}); (async function () {");
    assert.equal(prepared.ok, false);
  });

  it("stops a runaway loop at the deadline", async () => {
    const started = Date.now();
    const outcome = await run("for (;;) {}", 300);
    assert.equal(outcome.error?.code, "RUN_TIMEOUT");
    assert.equal(outcome.timed_out, true);
    assert.ok(Date.now() - started < 3_000);
  });

  it("stops at the memory limit", async () => {
    const outcome = await run("const s = 'x'.repeat(100 * 1024 * 1024);\ns.length", 30_000);
    assert.equal(outcome.error?.code, "RUN_MEMORY_EXCEEDED");
  });

  it("survives unbounded recursion, sync and async", async () => {
    for (const code of ["function f() { return f() }\nf()", "const g = async () => g();\nawait g()"]) {
      const outcome = await run(code);
      assert.equal(outcome.error?.code, "RUN_EXCEPTION", code);
      assert.match(outcome.error?.message ?? "", /stack overflow/, code);
    }
  });

  it("reports an uncaught exception with its location", async () => {
    const outcome = await run("const o: any = {};\no.x.y");
    assert.equal(outcome.error?.code, "RUN_EXCEPTION");
    assert.equal(outcome.error?.line, 2);
    assert.match(outcome.error?.message ?? "", /TypeError/);
  });

  it("reports a thrown value's code for the caller to interpret", async () => {
    const outcome = await run("throw Object.assign(new Error('nope'), { code: 'X_CODE' })");
    assert.equal(outcome.error?.thrown?.code, "X_CODE");
  });

  it("refuses a value that is not JSON", async () => {
    assert.equal((await run("1n")).error?.code, "RUN_VALUE_NOT_SERIALIZABLE");
    assert.equal((await run("const a: any = {};\na.a = a;\na")).error?.code, "RUN_VALUE_NOT_SERIALIZABLE");
    assert.equal((await run("() => 1")).error?.code, "RUN_VALUE_NOT_SERIALIZABLE");
  });

  it("refuses a value over the cap", async () => {
    const outcome = await runInSandbox({ code: "'x'.repeat(2000)", timeoutMs: 5_000, maxValueBytes: 1_000 });
    assert.equal(outcome.error?.code, "RUN_VALUE_TOO_LARGE");
  });

  it("names a promise nothing can settle instead of waiting out the deadline", async () => {
    const started = Date.now();
    const outcome = await run("await new Promise(() => {})", 10_000);
    assert.equal(outcome.error?.code, "RUN_EXCEPTION");
    assert.ok(Date.now() - started < 5_000);
  });

  it("waits for an in-flight host call at the deadline before returning", async () => {
    let settledAt = 0;
    const slow: SandboxExtension = {
      install: "(function (host) { globalThis.slow = () => host.slow(); })",
      async: {
        slow: () => new Promise((resolve) => setTimeout(() => { settledAt = Date.now(); resolve("done"); }, 400)),
      },
    };
    const outcome = await runInSandbox({ code: "await slow();\nfor (;;) {}", timeoutMs: 150, extensions: [slow] });
    assert.equal(outcome.error?.code, "RUN_TIMEOUT");
    assert.ok(settledAt > 0, "the in-flight call settled before the run returned");
  });
});
