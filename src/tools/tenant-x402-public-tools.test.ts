import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let calls: Array<{ method: string; input: unknown }> = [];

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      org: (orgId: string) => ({
        setPayoutWallet: async (input: unknown) => {
          calls.push({ method: `org:${orgId}:setPayoutWallet`, input });
          return {
            status: "set",
            org_id: orgId,
            default_payout_wallet: "0xabc0000000000000000000000000000000000001",
            previous_default_payout_wallet: null,
            recovery: {
              status: "ready",
              active_wallet_count: 1,
              mode: "default",
              wallet_address: "0xabc0000000000000000000000000000000000001",
              next_actions: [],
            },
          };
        },
      }),
      projects: {
        listTenantPayments: async (projectId: string, input: unknown) => {
          calls.push({ method: `project:${projectId}:listTenantPayments`, input });
          return {
            project_id: projectId,
            payments: [
              {
                payment_id: "pay_1",
                status: "settled",
                route_method: "POST",
                route_pattern: "/api/credits",
                amount_usd_micros: 250000,
                payer: "0xpayer",
                settlement_tx_hash: "0xtx",
                request_id: "req_1",
              },
            ],
            has_more: false,
            next_cursor: null,
          };
        },
      },
    }),
    _resetSdk: () => {},
  },
});

const {
  handleSetOrgPayoutWallet,
} = await import("./orgs.js");
const {
  handleListTenantPayments,
} = await import("./list-tenant-payments.js");

beforeEach(() => {
  calls = [];
});

describe("tenant x402 public MCP tools", () => {
  it("sets org payout wallet through the SDK", async () => {
    const result = await handleSetOrgPayoutWallet({
      org_id: "org_1",
      wallet_address: "0xabc0000000000000000000000000000000000001",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        method: "org:org_1:setPayoutWallet",
        input: { walletAddress: "0xabc0000000000000000000000000000000000001" },
      },
    ]);
    assert.match(result.content[0]!.text, /Default payout wallet/);
    assert.match(result.content[1]!.text, /default_payout_wallet/);
  });

  it("lists tenant payments through the SDK", async () => {
    const result = await handleListTenantPayments({
      project_id: "prj_1",
      status: "settled",
      limit: 25,
      after: "cur_0",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        method: "project:prj_1:listTenantPayments",
        input: { status: "settled", limit: 25, after: "cur_0" },
      },
    ]);
    assert.match(result.content[0]!.text, /pay_1/);
    assert.match(result.content[1]!.text, /"payments"/);
  });
});
