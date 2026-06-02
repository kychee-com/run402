import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";

function sdkWithFetch(fetchImpl) {
  return new Run402({
    apiBase: "https://api.example.com",
    fetch: fetchImpl,
    credentials: {
      async getAuth() { return { "X-Allowance": "sig" }; },
      async getProject() { return null; },
    },
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("wallets.getLabel", () => {
  it("returns the label on success", async () => {
    const r = sdkWithFetch(async () => jsonResponse(200, { address: "0xabc", label: "kychon" }));
    assert.equal(await r.wallets.getLabel("0xabc"), "kychon");
  });
  it("returns null on 404 (endpoint not deployed)", async () => {
    const r = sdkWithFetch(async () => jsonResponse(404, { error: "not found" }));
    assert.equal(await r.wallets.getLabel("0xabc"), null);
  });
  it("returns null when the request throws (offline)", async () => {
    const r = sdkWithFetch(async () => { throw new Error("ECONNREFUSED"); });
    assert.equal(await r.wallets.getLabel("0xabc"), null);
  });
});

describe("wallets.setLabel", () => {
  it("returns { ok: true } on success and signs the request", async () => {
    let seen = null;
    const r = sdkWithFetch(async (url, init) => {
      seen = { url: String(url), method: init?.method, body: init?.body, auth: init?.headers?.["X-Allowance"] ?? (init?.headers && new Headers(init.headers).get("X-Allowance")) };
      return jsonResponse(200, { ok: true });
    });
    const res = await r.wallets.setLabel("0xabc", "kychon");
    assert.deepEqual(res, { ok: true });
    assert.equal(seen.method, "PUT");
    assert.match(seen.url, /\/wallets\/v1\/0xabc\/label$/);
    assert.match(String(seen.body), /kychon/);
  });
  it("returns { ok: false } on 404 instead of throwing", async () => {
    const r = sdkWithFetch(async () => jsonResponse(404, { error: "not found" }));
    assert.deepEqual(await r.wallets.setLabel("0xabc", "kychon"), { ok: false });
  });
  it("returns { ok: false } when the request throws", async () => {
    const r = sdkWithFetch(async () => { throw new Error("network"); });
    assert.deepEqual(await r.wallets.setLabel("0xabc", "kychon"), { ok: false });
  });
});
