import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const credentials: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({
    apiBase: "https://api.example.test",
    credentials,
    fetch: fetchImpl,
  });
}

describe("ai.generateImage", () => {
  it("rejects unsupported image aspects before fetch", async () => {
    const calls: unknown[] = [];
    const sdk = makeSdk(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }));
    });

    await assert.rejects(
      sdk.ai.generateImage({ prompt: "a logo", aspect: "panorama" as any }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("sends the default square aspect when omitted", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdk(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        image: "aW1n",
        content_type: "image/png",
        aspect: "square",
      }), { headers: { "content-type": "application/json" } });
    });

    await sdk.ai.generateImage({ prompt: "a logo" });

    assert.equal(String(calls[0]!.input), "https://api.example.test/generate-image/v1");
    assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), {
      prompt: "a logo",
      aspect: "square",
    });
  });
});

// ─── Lightning rail: the paying org of a multi-org principal ────────────────

const ORG_A = "2002f5ec-69af-4b3c-a576-5c1fe6d1bdfe";
const ORG_B = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";

function selectionRequired(ids: string[]): Response {
  return new Response(JSON.stringify({
    error: "org_id is required for this principal",
    message: "org_id is required for this principal",
    code: "ORGANIZATION_SELECTION_REQUIRED",
    category: "billing",
    details: { organization_ids: ids, funds_moved: false },
    next_actions: [{ type: "edit_request", why: "Correct the request and retry before payment." }],
  }), { status: 400, headers: { "content-type": "application/json" } });
}

function imageOk(): Response {
  return new Response(JSON.stringify({ image: "aW1n", content_type: "image/png", aspect: "square" }), {
    headers: { "content-type": "application/json" },
  });
}

interface OrgContext {
  activeOrg?: string | null;
  activeProject?: string | null;
  projects?: Record<string, { anon_key: string; service_key: string; org_id?: string }>;
}

function makeSdkWithContext(
  fetchImpl: typeof globalThis.fetch,
  ctx: OrgContext,
): Run402 {
  const projects = ctx.projects ?? {};
  const credentials: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject(id: string) {
      return projects[id] ?? null;
    },
    async getProjectCredentials(id: string) {
      return projects[id] ?? null;
    },
    async listProjectCredentials() {
      return projects;
    },
    ...(ctx.activeProject !== undefined ? { async getActiveProject() { return ctx.activeProject ?? null; } } : {}),
    ...(ctx.activeOrg !== undefined ? { async getActiveOrg() { return ctx.activeOrg ?? null; } } : {}),
  };
  return new Run402({ apiBase: "https://api.example.test", credentials, fetch: fetchImpl });
}

function bodiesOf(calls: Array<{ init?: RequestInit }>): unknown[] {
  return calls.map((c) => JSON.parse(c.init!.body as string));
}

describe("ai.generateImage — ORGANIZATION_SELECTION_REQUIRED", () => {
  it("retries once with the one candidate that matches the active organization", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1 ? selectionRequired([ORG_A, ORG_B]) : imageOk();
    }, { activeOrg: ORG_B });

    const result = await sdk.ai.generateImage({ prompt: "a logo" });

    assert.equal(result.aspect, "square");
    assert.deepEqual(bodiesOf(calls), [
      { prompt: "a logo", aspect: "square" },
      { prompt: "a logo", aspect: "square", org_id: ORG_B },
    ]);
  });

  it("derives the candidate from the active project's cached owning org", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1 ? selectionRequired([ORG_A, ORG_B]) : imageOk();
    }, {
      activeProject: "prj_active",
      projects: {
        prj_active: { anon_key: "a", service_key: "s", org_id: ORG_A },
        prj_other: { anon_key: "a", service_key: "s", org_id: ORG_B },
      },
    });

    await sdk.ai.generateImage({ prompt: "a logo" });

    assert.equal(calls.length, 2);
    assert.deepEqual(bodiesOf(calls)[1], { prompt: "a logo", aspect: "square", org_id: ORG_A });
  });

  it("falls back to a single stored project's owning org when nothing is selected", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1 ? selectionRequired([ORG_A, ORG_B]) : imageOk();
    }, { projects: { prj_only: { anon_key: "a", service_key: "s", org_id: ORG_B } } });

    await sdk.ai.generateImage({ prompt: "a logo" });

    assert.deepEqual(bodiesOf(calls)[1], { prompt: "a logo", aspect: "square", org_id: ORG_B });
  });

  it("surfaces the candidates and a --org next action when several contexts match", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return selectionRequired([ORG_A, ORG_B]);
    }, {
      projects: {
        prj_a: { anon_key: "a", service_key: "s", org_id: ORG_A },
        prj_b: { anon_key: "a", service_key: "s", org_id: ORG_B },
      },
    });

    await assert.rejects(sdk.ai.generateImage({ prompt: "a logo" }), (err: any) => {
      assert.equal(err.code, "ORGANIZATION_SELECTION_REQUIRED");
      assert.equal(err.status, 400);
      assert.deepEqual(err.details.organization_ids, [ORG_A, ORG_B]);
      assert.deepEqual(err.details.matched_organization_ids, [ORG_A, ORG_B]);
      assert.match(err.message, new RegExp(`${ORG_A}, ${ORG_B}`));
      assert.match(err.message, /--org <org_id>/);
      assert.ok(err.nextActions.some((a: any) => /--org <org_id>/.test(a.command ?? "")), "names --org");
      return true;
    });
    assert.equal(calls.length, 1, "no blind retry");
  });

  it("surfaces the candidates when no local context matches", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return selectionRequired([ORG_A, ORG_B]);
    }, { activeOrg: "ffffffff-0000-0000-0000-ffffffffffff" });

    await assert.rejects(sdk.ai.generateImage({ prompt: "a logo" }), (err: any) => {
      assert.equal(err.code, "ORGANIZATION_SELECTION_REQUIRED");
      assert.deepEqual(err.details.organization_ids, [ORG_A, ORG_B]);
      assert.deepEqual(err.details.matched_organization_ids, []);
      assert.match(err.message, /none of them matches/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("does not retry when the caller named an org the gateway still refused", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return selectionRequired([ORG_A, ORG_B]);
    }, { activeOrg: ORG_B });

    await assert.rejects(sdk.ai.generateImage({ prompt: "a logo", orgId: ORG_A }), (err: any) => {
      assert.equal(err.code, "ORGANIZATION_SELECTION_REQUIRED");
      return true;
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(bodiesOf(calls)[0], { prompt: "a logo", aspect: "square", org_id: ORG_A });
  });

  it("gives up after the single retry instead of looping", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return selectionRequired([ORG_A, ORG_B]);
    }, { activeOrg: ORG_B });

    await assert.rejects(sdk.ai.generateImage({ prompt: "a logo" }), (err: any) => {
      assert.equal(err.code, "ORGANIZATION_SELECTION_REQUIRED");
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it("leaves every other error untouched (x402 path unchanged)", async () => {
    const calls: unknown[] = [];
    const sdk = makeSdkWithContext(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ code: "VALIDATION_FAILED", message: "prompt too long" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }, { activeOrg: ORG_B });

    await assert.rejects(sdk.ai.generateImage({ prompt: "a logo" }), (err: any) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      return true;
    });
    assert.equal(calls.length, 1);
  });
});
