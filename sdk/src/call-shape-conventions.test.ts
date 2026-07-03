/**
 * Cross-cutting tests for the `sdk-call-shape-conventions` change: the new
 * scope handles (`r.wallet`, `r.admin.org`, `r.admin.project`), the
 * options-object reshapes, and that each reshaped method's new form produces a
 * byte-identical request to its deprecated positional form.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "./index.js";
import { _resetDeprecationWarnings } from "./deprecate.js";

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

// Reshaped methods emit deprecation notices on the positional path; silence
// them here (the notice mechanism itself is covered in deprecate.test.ts).
let savedEnv: string | undefined;
beforeEach(() => {
  _resetDeprecationWarnings();
  savedEnv = process.env.RUN402_SUPPRESS_DEPRECATIONS;
  process.env.RUN402_SUPPRESS_DEPRECATIONS = "1";
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.RUN402_SUPPRESS_DEPRECATIONS;
  else process.env.RUN402_SUPPRESS_DEPRECATIONS = savedEnv;
});

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

describe("wallet handle parity", () => {
  it("r.wallet(addr).setLabel(label) PUTs the same body as r.wallets.setLabel", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.wallet("0xabc").setLabel("kychon");
    await r.wallets.setLabel("0xabc", "kychon");
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
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

describe("options-object reshapes match the deprecated positional wire body", () => {
  it("domains.add", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.domains.add("prj_1", { domain: "ex.com", subdomainName: "sub" });
    await r.domains.add("prj_1", "ex.com", "sub");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[0], { project_id: "prj_1", domain: "ex.com", subdomain_name: "sub" });
  });

  it("secrets.set", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.secrets.set("prj_1", "API_KEY", { value: "v1" });
    await r.secrets.set("prj_1", "API_KEY", "v1");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[0], { key: "API_KEY", value: "v1" });
  });

  it("subdomains.claim", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.subdomains.claim({ name: "foo", deploymentId: "dep_1", projectId: "prj_1" });
    await r.subdomains.claim("foo", "dep_1", { projectId: "prj_1" });
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[0], { name: "foo", deployment_id: "dep_1" });
  });

  it("org.members.setRole", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.org("org_1").members.setRole("prc_1", { role: "admin" });
    await r.org("org_1").members.setRole("prc_1", "admin");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[0], { role: "admin" });
  });

  it("transfers.cancel", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    await r.admin.transfers.cancel("tr_1", { reason: "oops" });
    await r.admin.transfers.cancel("tr_1", "oops");
    assert.deepEqual(bodies[0], bodies[1]);
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

  it("r.project(id).domains.add({ domain, subdomainName }) sends the mapped body", async () => {
    const bodies: unknown[] = [];
    const r = sdkCapturing(bodies);
    const p = await r.project("prj_1");
    await p.domains.add({ domain: "ex.com", subdomainName: "sub" });
    assert.deepEqual(bodies[0], { project_id: "prj_1", domain: "ex.com", subdomain_name: "sub" });
  });
});

describe("deprecation routing", () => {
  it("the deprecated positional form emits exactly one stderr notice", async () => {
    delete process.env.RUN402_SUPPRESS_DEPRECATIONS;
    _resetDeprecationWarnings();
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const r = sdkCapturing([]);
      await r.secrets.set("prj_1", "API_KEY", "v1");
      await r.secrets.set("prj_1", "API_KEY", "v2");
    } finally {
      process.stderr.write = origWrite;
    }
    const notices = writes.filter((w) => /DEPRECATED: secrets\.set/.test(w));
    assert.equal(notices.length, 1);
  });
});
