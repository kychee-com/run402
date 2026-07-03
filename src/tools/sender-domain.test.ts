import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

let calls: Array<{ method: string; args: unknown[] }> = [];

const domainAggregate = {
  project_id: "prj_123",
  domain: "kysigned.com",
  status: "waiting",
  desired: {},
  observed: {},
  effective: {},
  authority: { recommended_mode: "manual_dns", options: [] },
  dns_records: [],
  checks: [],
  next_action: null,
  alternate_actions: [],
  provenance: {},
};

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      domains: {
        ensure: async (...args: unknown[]) => {
          calls.push({ method: "ensure", args });
          return domainAggregate;
        },
        check: async (...args: unknown[]) => {
          calls.push({ method: "check", args });
          return { ...domainAggregate, status: "active" };
        },
        testReceive: async (...args: unknown[]) => {
          calls.push({ method: "testReceive", args });
          return {
            ...domainAggregate,
            receive_test: {
              id: "rt_1",
              local_part: "info",
              address: "info@kysigned.com",
              target_managed_address: "info@prj.mail.run402.com",
              token: "rt_abcdefabcdefabcdefabcdef",
              status: "pending",
              created_at: "2026-07-03T00:00:00Z",
            },
          };
        },
        disconnect: async (...args: unknown[]) => {
          calls.push({ method: "disconnect", args });
          return { status: "deleted", domain: "kysigned.com" };
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const {
  domainsEnsureSchema,
  handleDomainsEnsure,
  handleDomainsCheck,
  handleDomainsTestReceive,
  handleDomainsDisconnect,
} = await import("./domains.js");

beforeEach(() => {
  calls = [];
});

describe("project domain MCP tools", () => {
  it("accepts desired ProjectDomain state and forwards it to the SDK", async () => {
    const desired = {
      email: {
        send: { enabled: true },
        receive: { enabled: true, strategy: "forwarding_mode" },
      },
    };
    const parsed = z.object(domainsEnsureSchema).parse({
      project_id: "prj_123",
      domain: "kysigned.com",
      desired,
    });

    const result = await handleDomainsEnsure(parsed);

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        method: "ensure",
        args: ["prj_123", "kysigned.com", { desired }],
      },
    ]);
    assert.match(result.content[0]!.text, /Project Domain Ensured/);
    assert.match(result.content[0]!.text, /kysigned\.com/);
  });

  it("checks, creates receive tests, and disconnects through the ProjectDomain SDK", async () => {
    await handleDomainsCheck({ project_id: "prj_123", domain: "kysigned.com" });
    const testResult = await handleDomainsTestReceive({
      project_id: "prj_123",
      domain: "kysigned.com",
      to: "info",
    });
    const disconnectResult = await handleDomainsDisconnect({
      project_id: "prj_123",
      domain: "kysigned.com",
    });

    assert.deepEqual(calls, [
      { method: "check", args: ["prj_123", "kysigned.com"] },
      { method: "testReceive", args: ["prj_123", "kysigned.com", "info"] },
      { method: "disconnect", args: ["prj_123", "kysigned.com"] },
    ]);
    assert.match(testResult.content[0]!.text, /rt_abcdef/);
    assert.match(disconnectResult.content[0]!.text, /deleted/);
  });
});
