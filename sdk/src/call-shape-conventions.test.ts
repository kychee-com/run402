/**
 * Cross-cutting tests for the `sdk-call-shape-conventions` change: the new
 * scope handles (`r.wallet`, `r.admin.org`, `r.admin.project`) and the
 * options-object call shapes, pinning the exact wire body each one sends.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "./index.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sdkCapturing(
  bodies: unknown[],
  project: { anon_key: string; service_key: string } | null = { anon_key: "anon", service_key: "svc" },
) {
  return new Run402({
    apiBase: "https://api.example.com",
    fetch: async (_url, init) => {
      const raw = (init as RequestInit | undefined)?.body;
      bodies.push(typeof raw === "string" ? JSON.parse(raw) : raw);
      return jsonResponse(200, { ok: true });
    },
    credentials: {
      async getAuth() {
        return { "X-Allowance": "sig" };
      },
      async getProject() {
        return project;
      },
    },
  });
}

describe("scope handles exist", () => {
  const r = sdkCapturing([]);
  it("r.wallet(address) exposes getLabel/setLabel", () => {
    const w = r.wallet("0xabc");
    assert.equal(typeof w.getLabel, "function");
    assert.equal(typeof w.setLabel, "function");
  });
  it("r.admin.org(id) exposes pinLease/unpinLease", () => {
    const o = r.admin.org("org_1");
    assert.equal(typeof o.pinLease, "function");
    assert.equal(typeof o.unpinLease, "function");
  });
  it("r.admin.project(id) exposes archive/reactivate/finance", () => {
    const p = r.admin.project("prj_1");
    assert.equal(typeof p.archive, "function");
    assert.equal(typeof p.reactivate, "function");
    assert.equal(typeof p.finance, "function");
  });
});

describe("wallet handle", () => {
  it("r.wallet(addr).setLabel(label) PUTs { label }", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.wallet("0xabc").setLabel("kychon");
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], { label: "kychon" });
  });
});

describe("admin lease verb-split", () => {
  it("pinLease() sends lease_perpetual:true, unpinLease() false", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.admin.org("org_1").pinLease();
    await r.admin.org("org_1").unpinLease();
    assert.deepEqual(bodies[0], { lease_perpetual: true });
    assert.deepEqual(bodies[1], { lease_perpetual: false });
  });
});

describe("options-object call shapes send the expected wire body", () => {
  it("domains.ensure", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.domains.ensure("prj_1", "ex.com", {
      desired: {
        web: { enabled: true, target: "sub" },
        email: { send: { enabled: true } },
      },
    });
    assert.deepEqual(bodies[0], {
      desired: {
        web: { enabled: true, target: "sub" },
        email: { send: { enabled: true } },
      },
    });
  });

  it("secrets.set", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.secrets.set("prj_1", "API_KEY", { value: "v1" });
    assert.deepEqual(bodies[0], { key: "API_KEY", value: "v1" });
  });

  it("subdomains.claim", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.subdomains.claim({ name: "foo", deploymentId: "dep_1", projectId: "prj_1" });
    assert.deepEqual(bodies[0], { name: "foo", deployment_id: "dep_1" });
  });

  it("org.members.setRole", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.org("org_1").members.setRole("prc_1", { role: "admin" });
    assert.deepEqual(bodies[0], { role: "admin" });
  });

  it("transfers.cancel", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.admin.transfers.cancel("tr_1", { reason: "oops" });
    assert.deepEqual(bodies[0], { reason: "oops" });
  });
});

describe("scoped wrappers use the canonical form", () => {
  it("r.project(id).secrets.set(key, { value }) sends key+value", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    const p = await r.project("prj_1");
    await p.secrets.set("API_KEY", { value: "v1" });
    assert.deepEqual(bodies[0], { key: "API_KEY", value: "v1" });
  });

  it("r.project(id).domains.ensure(domain, { desired }) sends the desired state", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    const p = await r.project("prj_1");
    await p.domains.ensure("ex.com", { desired: { email: { receive: { enabled: true } } } });
    assert.deepEqual(bodies[0], { desired: { email: { receive: { enabled: true } } } });
  });
});

