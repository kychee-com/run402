/**
 * result-store tests.
 *
 * The load-bearing behaviours, in the order they matter:
 *   - `total` always reports the DATA, `shown` the VIEW — the truncate-the-view
 *     contract is only honest if those two numbers can disagree;
 *   - a `secret: true` result is NEVER written, and returns `ref: null`;
 *   - the store is bounded by count and by TTL, so a long MCP session cannot
 *     grow it without limit;
 *   - an unknown / evicted / expired ref is indistinguishable (`null`), because
 *     the caller's recovery is identical in all three cases.
 *
 * Run: node --test --import tsx src/result-store.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  RESULT_STORE_DEFAULT_EXPAND_LIMIT,
  RESULT_STORE_DEFAULT_SHOWN,
  RESULT_STORE_MAX_ENTRIES,
  RESULT_STORE_MAX_EXPAND_LIMIT,
  RESULT_STORE_TTL_MS,
  _resetResultStore,
  _resultStoreSize,
  _setResultStoreClock,
  expandResult,
  storeResult,
} from "./result-store.js";

const rows = (n: number): Array<{ i: number }> => Array.from({ length: n }, (_, i) => ({ i }));

let clock = 1_000_000;

beforeEach(() => {
  _resetResultStore();
  clock = 1_000_000;
  _setResultStoreClock(() => clock);
});

afterEach(() => {
  _setResultStoreClock(null);
  _resetResultStore();
});

describe("storeResult — the bounded view", () => {
  it("shows a window and reports the full total", () => {
    const view = storeResult("probe", rows(137));
    assert.equal(view.shown, RESULT_STORE_DEFAULT_SHOWN);
    assert.equal(view.items.length, RESULT_STORE_DEFAULT_SHOWN);
    assert.equal(view.total, 137, "total must report the DATA, not the view");
    assert.match(view.ref ?? "", /^res_[0-9a-f]{16}$/);
  });

  it("honours an explicit window size", () => {
    const view = storeResult("probe", rows(10), { shown: 3 });
    assert.deepEqual(view.items, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    assert.equal(view.shown, 3);
    assert.equal(view.total, 10);
  });

  it("does not pretend a short result is truncated", () => {
    const view = storeResult("probe", rows(2));
    assert.equal(view.shown, 2);
    assert.equal(view.total, 2);
  });

  it("stores a snapshot — mutating the caller's array afterwards does not change the ref", () => {
    const items = rows(3);
    const view = storeResult("probe", items);
    items.push({ i: 99 });
    const expanded = expandResult(view.ref!);
    assert.equal(expanded?.total, 3);
  });

  it("an empty result still gets a usable ref", () => {
    const view = storeResult("probe", []);
    assert.equal(view.total, 0);
    assert.equal(expandResult(view.ref!)?.total, 0);
  });
});

describe("storeResult — the secret rule", () => {
  it("secret: true returns ref null and stores NOTHING", () => {
    const view = storeResult("credential", rows(50), { secret: true });
    assert.equal(view.ref, null, "a secret-bearing result must never get a ref");
    assert.equal(view.shown, RESULT_STORE_DEFAULT_SHOWN);
    assert.equal(view.total, 50, "the count is still honest — it is the CONTENT that is not retained");
    assert.equal(_resultStoreSize(), 0, "nothing may be written for a secret-bearing result");
  });

  it("secret: false is stored normally", () => {
    const view = storeResult("probe", rows(5), { secret: false });
    assert.notEqual(view.ref, null);
    assert.equal(_resultStoreSize(), 1);
  });

  it("a secret result cannot be reached by guessing an earlier ref", () => {
    const kept = storeResult("probe", rows(3));
    const secret = storeResult("credential", [{ token: "holder_token" }], { secret: true });
    assert.equal(secret.ref, null);
    // Only the non-secret result is addressable, and it is the one it says it is.
    assert.equal(expandResult(kept.ref!)?.kind, "probe");
    assert.equal(_resultStoreSize(), 1);
  });
});

describe("expandResult — windows over the full data", () => {
  it("pages with offset and limit", () => {
    const view = storeResult("probe", rows(137));
    const page = expandResult(view.ref!, { offset: 20, limit: 5 });
    assert.deepEqual(page, {
      ref: view.ref,
      kind: "probe",
      offset: 20,
      shown: 5,
      total: 137,
      items: [{ i: 20 }, { i: 21 }, { i: 22 }, { i: 23 }, { i: 24 }],
    });
  });

  it("defaults the limit and clamps it to the ceiling", () => {
    const view = storeResult("probe", rows(2000));
    assert.equal(expandResult(view.ref!)?.shown, RESULT_STORE_DEFAULT_EXPAND_LIMIT);
    assert.equal(expandResult(view.ref!, { limit: 99_999 })?.shown, RESULT_STORE_MAX_EXPAND_LIMIT);
  });

  it("clamps a negative or past-the-end offset instead of throwing", () => {
    const view = storeResult("probe", rows(10));
    assert.equal(expandResult(view.ref!, { offset: -5 })?.offset, 0);
    const past = expandResult(view.ref!, { offset: 999 });
    assert.equal(past?.offset, 10);
    assert.deepEqual(past?.items, []);
    assert.equal(past?.total, 10, "an empty window still reports the true total");
  });

  it("returns null for an unknown ref", () => {
    assert.equal(expandResult("res_0000000000000000"), null);
  });
});

describe("the store is bounded", () => {
  it("keeps at most RESULT_STORE_MAX_ENTRIES results, evicting oldest first", () => {
    const refs: string[] = [];
    for (let i = 0; i < RESULT_STORE_MAX_ENTRIES + 5; i += 1) {
      clock += 1;
      refs.push(storeResult(`probe-${i}`, rows(1)).ref!);
    }
    assert.equal(_resultStoreSize(), RESULT_STORE_MAX_ENTRIES);
    assert.equal(expandResult(refs[0]!), null, "the oldest ref is evicted");
    assert.equal(expandResult(refs[4]!), null);
    assert.notEqual(expandResult(refs[5]!), null, "the newest MAX entries survive");
    assert.notEqual(expandResult(refs.at(-1)!), null);
  });

  it("expires a ref after the TTL, measured from the store time", () => {
    const view = storeResult("probe", rows(3));
    clock += RESULT_STORE_TTL_MS - 1;
    assert.notEqual(expandResult(view.ref!), null, "still live just inside the TTL");
    clock += 2;
    assert.equal(expandResult(view.ref!), null, "gone once the TTL has passed");
    assert.equal(_resultStoreSize(), 0);
  });

  it("reading does not refresh the TTL — a ref cannot be kept alive by polling", () => {
    const view = storeResult("probe", rows(3));
    for (let i = 0; i < 5; i += 1) {
      clock += RESULT_STORE_TTL_MS / 10;
      assert.notEqual(expandResult(view.ref!), null);
    }
    clock += RESULT_STORE_TTL_MS;
    assert.equal(expandResult(view.ref!), null);
  });
});
