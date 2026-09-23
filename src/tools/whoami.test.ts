import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleWhoami } from "./whoami.js";
import { _resetSdk } from "../sdk.js";
import { whoamiOutputSchema } from "../structured.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-whoami-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  writeFileSync(join(tempDir, "wallet.json"), JSON.stringify({
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    created: "2026-01-01T00:00:00Z",
    rail: "x402",
  }), { mode: 0o600 });
  _resetSdk();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetSdk();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("whoami tool", () => {
  it("returns r.orgs.whoami(): the principal, its memberships, and the session grade", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify({
        principal: { id: "prn_1", type: "agent", display_name: "builder", created_at: "2026-01-01T00:00:00Z" },
        authenticator_id: "auth_1",
        active_authenticator: { kind: "wallet", public_subject: "0xf39f" },
        linked_identities: [],
        memberships: [{ org_id: "00000000-0000-4000-8000-000000000001", display_name: "Acme", role: "owner", status: "active" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleWhoami();
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.match(text, /^## Principal `prn_1` \(agent, builder\)/);
    assert.match(text, /- memberships: `00000000-0000-4000-8000-000000000001` \("Acme"\) owner \(active\)/);
    assert.match(text, /- session: none \(wallet\)/);
    assert.deepEqual(paths.filter((p) => p.startsWith("/agent/")), ["/agent/v1/whoami"]);

    const structured = whoamiOutputSchema.parse(result.structuredContent);
    assert.equal(structured.status, "ok");
    assert.equal(structured.result?.principal.id, "prn_1");
    assert.deepEqual(result.structuredContent, JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!), "the fenced JSON is the structured object");
  });
});
