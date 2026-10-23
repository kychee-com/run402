/**
 * A project-path method refuses a malformed project id locally, before any
 * request, with `BAD_PROJECT_ID`, the argument named in `details`, and one
 * `edit_request` next action showing the call shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
}

function mockFetch(): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ project_id: "x", rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return { anon_key: "anon_xxx", service_key: "service_xxx" };
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertBadProjectId(err: unknown, method: string): true {
  assert.ok(err instanceof LocalError, `expected LocalError, got ${String(err)}`);
  assert.equal(err.code, "BAD_PROJECT_ID");
  assert.match(err.message, new RegExp(`^${escape(method)}:`));
  const details = err.details as { argument?: string; method?: string } | undefined;
  assert.equal(details?.method, method);
  assert.ok(details?.argument, "details.argument names the argument");
  assert.equal(err.nextActions?.length, 1);
  const action = err.nextActions?.[0] as { type?: string; why?: string } | undefined;
  assert.equal(action?.type, "edit_request");
  assert.match(action?.why ?? "", new RegExp(`r\\.${escape(method)}\\(.*"prj_…"`), "the next action shows the call shape");
  return true;
}

describe("project id guard on project-path methods", () => {
  it("projects.sql refuses SQL passed as the project id, before any request", async () => {
    const { fetch, calls } = mockFetch();
    const sdk = makeSdk(fetch);
    await assert.rejects(
      // The arity mistake an agent makes from JavaScript: the SQL lands in `id`.
      (sdk.projects.sql as unknown as (id: string) => Promise<unknown>)("select count(*) from users"),
      (err: unknown) => {
        assertBadProjectId(err, "projects.sql");
        assert.doesNotMatch((err as Error).message, /select count/, "the rejected value is never echoed");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  const cases: Array<[string, (sdk: Run402, id: string) => Promise<unknown>]> = [
    ["projects.delete", (sdk, id) => sdk.projects.delete(id)],
    ["projects.rename", (sdk, id) => sdk.projects.rename(id, "n")],
    ["projects.setRepoName", (sdk, id) => sdk.projects.setRepoName(id, "n")],
    ["projects.listTenantPayments", (sdk, id) => sdk.projects.listTenantPayments(id)],
    ["projects.getUsage", (sdk, id) => sdk.projects.getUsage(id)],
    ["projects.getSchema", (sdk, id) => sdk.projects.getSchema(id)],
    ["projects.sql", (sdk, id) => sdk.projects.sql(id, "SELECT 1")],
    ["projects.sqlBatch", (sdk, id) => sdk.projects.sqlBatch(id, [{ sql: "SELECT 1" }])],
    ["projects.rest", (sdk, id) => sdk.projects.rest(id, "items")],
    ["projects.restResponse", (sdk, id) => sdk.projects.restResponse(id, "items", { keyType: "service" })],
    ["projects.applyExpose", (sdk, id) => sdk.projects.applyExpose(id, { version: "1" } as never)],
    ["projects.validateExpose", (sdk, id) => sdk.projects.validateExpose({ version: "1" } as never, { project: id })],
    ["projects.getExpose", (sdk, id) => sdk.projects.getExpose(id)],
    ["projects.get", (sdk, id) => sdk.projects.get(id)],
    ["projects.promoteUser", (sdk, id) => sdk.projects.promoteUser(id, "a@example.com")],
    ["projects.demoteUser", (sdk, id) => sdk.projects.demoteUser(id, "a@example.com")],
  ];

  for (const [method, call] of cases) {
    it(`${method} refuses a malformed or missing project id locally`, async () => {
      const { fetch, calls } = mockFetch();
      const sdk = makeSdk(fetch);
      const bad = ["", "my-project", "prj_", "prj_1/../../admin", "prj_1?x=1", undefined as unknown as string];
      for (const id of bad) {
        // validateExpose's project is optional: omitting it is projectless validation.
        if (id === undefined && method === "projects.validateExpose") continue;
        await assert.rejects(call(sdk, id), (err: unknown) => assertBadProjectId(err, method));
      }
      assert.equal(calls.length, 0);
    });
  }

  it("accepts every minted project id format and keeps it in the path", async () => {
    const { fetch, calls } = mockFetch();
    const sdk = makeSdk(fetch);
    await sdk.projects.get("prj_1761234567890_42");
    await sdk.projects.get("prj_0123456789abcdef");
    await sdk.project("prj_1761234567890_42").projects.get();
    await sdk.projects.sql("prj_1761234567890_42", "SELECT 1");
    assert.deepEqual(calls.map((c) => c.url), [
      "https://api.example.test/projects/v1/prj_1761234567890_42",
      "https://api.example.test/projects/v1/prj_0123456789abcdef",
      "https://api.example.test/projects/v1/prj_1761234567890_42",
      "https://api.example.test/projects/v1/prj_1761234567890_42/sql",
    ]);
  });
});
