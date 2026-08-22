/**
 * expand_result tool behaviour.
 *
 * The affordance is only worth anything if it TELLS the agent where it is: which
 * slice it just got, how much remains, and the exact next call. And an
 * unreachable ref must not read as an empty result — an empty answer that means
 * "expired" is the failure this surface exists to avoid.
 *
 * Run: node --test --import tsx src/tools/expand-result.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _resetResultStore, _setResultStoreClock, RESULT_STORE_TTL_MS, storeResult } from "../result-store.js";
import { handleExpandResult } from "./expand-result.js";

const textOf = (result: { content: Array<{ text: string }> }): string => result.content.map((c) => c.text).join("\n");

let clock = 5_000_000;

beforeEach(() => {
  _resetResultStore();
  clock = 5_000_000;
  _setResultStoreClock(() => clock);
});

afterEach(() => {
  _setResultStoreClock(null);
  _resetResultStore();
});

describe("expand_result", () => {
  it("returns a window and names the exact next call", async () => {
    const view = storeResult("gitvault_heads", Array.from({ length: 137 }, (_, i) => ({ i })));
    const out = textOf(await handleExpandResult({ ref: view.ref!, offset: 20, limit: 50 }));
    assert.match(out, new RegExp(`${view.ref} \\(gitvault_heads\\) — items 20\\.\\.69 of 137\\.`));
    assert.match(out, new RegExp(`67 more: expand_result with ref ${view.ref} and offset 70\\.`));
    assert.match(out, /"i": 20/);
    assert.match(out, /"i": 69/);
    assert.equal(/"i": 70\b/.test(out), false, "the window must stop where it says it stops");
  });

  it("says when a window reaches the end", async () => {
    const view = storeResult("probe", [{ a: 1 }, { a: 2 }]);
    const out = textOf(await handleExpandResult({ ref: view.ref! }));
    assert.match(out, /items 0\.\.1 of 2\./);
    assert.match(out, /This window reaches the end of the result\./);
  });

  it("an unknown ref is an ERROR, never an empty result", async () => {
    const result = await handleExpandResult({ ref: "res_deadbeefdeadbeef" });
    assert.equal(result.isError, true);
    const out = textOf(result);
    assert.match(out, /No result is held under ref res_deadbeefdeadbeef/);
    assert.match(out, /re-run the tool that produced the ref/);
  });

  it("an expired ref reads the same as an unknown one, and says why", async () => {
    const view = storeResult("probe", [{ a: 1 }]);
    clock += RESULT_STORE_TTL_MS + 1;
    const result = await handleExpandResult({ ref: view.ref! });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /expire 30 minutes after the tool ran/);
  });

  it("explains that a secret-bearing result has no ref to expand", async () => {
    const secret = storeResult("credential", [{ holder_token: "never-stored" }], { secret: true });
    assert.equal(secret.ref, null);
    const out = textOf(await handleExpandResult({ ref: "res_0000000000000000" }));
    assert.match(out, /carried a secret never has a ref at all/);
    assert.equal(out.includes("never-stored"), false, "nothing about a secret result may be reachable from here");
  });
});
