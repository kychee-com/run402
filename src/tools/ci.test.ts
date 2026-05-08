import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: Array<{ method: string; input: unknown }> = [];

const binding = {
  id: "cib_123",
  project_id: "prj_ci",
  provider: "github-actions",
  subject_match: "repo:tal/myapp:ref:refs/heads/main",
  allowed_actions: ["deploy"],
  allowed_events: ["push", "workflow_dispatch"],
  route_scopes: ["/admin", "/admin/*"],
  github_repository_id: "892341",
  expires_at: null,
  revoked_at: null,
};

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      ci: {
        createBinding: async (input: unknown) => {
          calls.push({ method: "create", input });
          return binding;
        },
        listBindings: async (input: unknown) => {
          calls.push({ method: "list", input });
          return { bindings: [binding] };
        },
        getBinding: async (input: unknown) => {
          calls.push({ method: "get", input });
          return binding;
        },
        revokeBinding: async (input: unknown) => {
          calls.push({ method: "revoke", input });
          return { ...binding, revoked_at: "2026-05-03T01:00:00Z" };
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const {
  handleCiCreateBinding,
  handleCiGetBinding,
  handleCiListBindings,
  handleCiRevokeBinding,
} = await import("./ci.js");

beforeEach(() => {
  calls = [];
});

describe("CI binding MCP tools", () => {
  it("creates bindings through the SDK and preserves returned route_scopes", async () => {
    const result = await handleCiCreateBinding({
      project_id: "prj_ci",
      subject_match: "repo:tal/myapp:ref:refs/heads/main",
      allowed_actions: ["deploy"],
      allowed_events: ["push", "workflow_dispatch"],
      route_scopes: ["/admin/*", "/admin"],
      github_repository_id: "892341",
      expires_at: null,
      nonce: "deadbeef00112233aabbccdd44556677",
      signed_delegation: "signed",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        method: "create",
        input: {
          project_id: "prj_ci",
          provider: "github-actions",
          subject_match: "repo:tal/myapp:ref:refs/heads/main",
          allowed_actions: ["deploy"],
          allowed_events: ["push", "workflow_dispatch"],
          route_scopes: ["/admin/*", "/admin"],
          github_repository_id: "892341",
          expires_at: null,
          nonce: "deadbeef00112233aabbccdd44556677",
          signed_delegation: "signed",
        },
      },
    ]);
    assert.match(result.content[0]!.text, /`\/admin`, `\/admin\/\*`/);
    assert.match(result.content[1]!.text, /"route_scopes"/);
  });

  it("lists bindings through the SDK and preserves route_scopes", async () => {
    const result = await handleCiListBindings({ project_id: "prj_ci" });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ method: "list", input: { project: "prj_ci" } }]);
    assert.match(result.content[0]!.text, /CI Bindings/);
    assert.match(result.content[0]!.text, /`\/admin`, `\/admin\/\*`/);
    assert.match(result.content[1]!.text, /"route_scopes"/);
  });

  it("gets bindings through the SDK", async () => {
    const result = await handleCiGetBinding({ binding_id: "cib_123" });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ method: "get", input: "cib_123" }]);
    assert.match(result.content[0]!.text, /CI Binding/);
    assert.match(result.content[0]!.text, /`\/admin`, `\/admin\/\*`/);
  });

  it("revokes bindings through the SDK and preserves returned route_scopes", async () => {
    const result = await handleCiRevokeBinding({ binding_id: "cib_123" });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ method: "revoke", input: "cib_123" }]);
    assert.match(result.content[0]!.text, /CI Binding Revoked/);
    assert.match(result.content[0]!.text, /2026-05-03T01:00:00Z/);
  });
});
