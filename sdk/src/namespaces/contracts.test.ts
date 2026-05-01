import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject(id: string) {
      if (id === "prj_known") {
        return { anon_key: "anon_xxx", service_key: "service_xxx" };
      }
      return null;
    },
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("contracts.listWallets", () => {
  it("returns a typed wallets array with the documented fields", async () => {
    const wallets = [
      {
        wallet_id: "cwlt_abc",
        address: "0x1111111111111111111111111111111111111111",
        chain: "base-mainnet",
        status: "active",
        balance_wei: "1000000000000000",
        threshold_wei: "500000000000000",
        recovery_address: "0x2222222222222222222222222222222222222222",
        created_at: "2025-01-01T00:00:00Z",
      },
    ];
    const { fetch, calls } = mockFetch(() => jsonResponse({ wallets }));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.listWallets("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/wallets");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");

    assert.equal(result.wallets.length, 1);
    const w = result.wallets[0]!;
    assert.equal(w.wallet_id, "cwlt_abc");
    assert.equal(w.address, "0x1111111111111111111111111111111111111111");
    assert.equal(w.chain, "base-mainnet");
    assert.equal(w.status, "active");
    assert.equal(w.balance_wei, "1000000000000000");
    assert.equal(w.threshold_wei, "500000000000000");
    assert.equal(w.recovery_address, "0x2222222222222222222222222222222222222222");
    assert.equal(w.created_at, "2025-01-01T00:00:00Z");
  });

  it("throws ProjectNotFound for unknown ids before any fetch", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(sdk.contracts.listWallets("prj_missing"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("contracts.getWallet", () => {
  it("returns a typed wallet summary with documented fields", async () => {
    const wallet = {
      wallet_id: "cwlt_abc",
      address: "0x1111111111111111111111111111111111111111",
      chain: "base-sepolia",
      status: "suspended",
      balance_wei: "0",
      threshold_wei: null,
      recovery_address: null,
      created_at: "2025-01-01T00:00:00Z",
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(wallet));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.getWallet("prj_known", "cwlt_abc");

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/wallets/cwlt_abc");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(result.wallet_id, "cwlt_abc");
    assert.equal(result.chain, "base-sepolia");
    assert.equal(result.status, "suspended");
    assert.equal(result.threshold_wei, null);
    assert.equal(result.recovery_address, null);
  });
});

describe("contracts.provisionWallet", () => {
  it("returns at least wallet_id, address, chain", async () => {
    const provisioned = {
      wallet_id: "cwlt_new",
      address: "0xaaaa000000000000000000000000000000000000",
      chain: "base-mainnet",
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(provisioned));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.provisionWallet("prj_known", { chain: "base-mainnet" });

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/wallets");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { chain: "base-mainnet" });
    assert.equal(result.wallet_id, "cwlt_new");
    assert.equal(result.address, "0xaaaa000000000000000000000000000000000000");
    assert.equal(result.chain, "base-mainnet");
  });

  it("includes recovery_address in body when provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        wallet_id: "cwlt_new",
        address: "0xaaaa000000000000000000000000000000000000",
        chain: "base-mainnet",
      }),
    );
    const sdk = makeSdk(fetch);
    await sdk.contracts.provisionWallet("prj_known", {
      chain: "base-mainnet",
      recoveryAddress: "0x3333333333333333333333333333333333333333",
    });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      chain: "base-mainnet",
      recovery_address: "0x3333333333333333333333333333333333333333",
    });
  });
});

describe("contracts.call", () => {
  it("returns a typed result with call_id, status, tx_hash", async () => {
    const callRes = {
      call_id: "call_xyz",
      status: "submitted",
      tx_hash: null,
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(callRes));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.call("prj_known", {
      walletId: "cwlt_abc",
      chain: "base-mainnet",
      contractAddress: "0x4444444444444444444444444444444444444444",
      abiFragment: [{ type: "function", name: "ping", inputs: [], outputs: [] }],
      functionName: "ping",
      args: [],
    });

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/call");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.call_id, "call_xyz");
    assert.equal(result.status, "submitted");
    assert.equal(result.tx_hash, null);
  });

  it("sets the Idempotency-Key header when idempotencyKey is provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ call_id: "c", status: "submitted", tx_hash: null }),
    );
    const sdk = makeSdk(fetch);
    await sdk.contracts.call("prj_known", {
      walletId: "cwlt_abc",
      chain: "base-mainnet",
      contractAddress: "0x4444444444444444444444444444444444444444",
      abiFragment: [],
      functionName: "noop",
      args: [],
      idempotencyKey: "key-1",
    });
    assert.equal(calls[0]!.headers["Idempotency-Key"], "key-1");
  });

  it("accepts CLI-style aliases (to/abi/fn) and resolves to the same wire request", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ call_id: "c", status: "submitted", tx_hash: null }),
    );
    const sdk = makeSdk(fetch);
    await sdk.contracts.call("prj_known", {
      walletId: "cwlt_abc",
      chain: "base-mainnet",
      to: "0x4444444444444444444444444444444444444444",
      abi: [{ type: "function", name: "ping" }],
      fn: "ping",
      args: [],
    });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      wallet_id: "cwlt_abc",
      chain: "base-mainnet",
      contract_address: "0x4444444444444444444444444444444444444444",
      abi_fragment: [{ type: "function", name: "ping" }],
      function_name: "ping",
      args: [],
    });
  });

  it("throws LocalError when neither contractAddress nor to is provided", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.contracts.call("prj_known", {
        walletId: "cwlt_abc",
        chain: "base-mainnet",
        abiFragment: [],
        functionName: "ping",
        args: [],
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("contracts.read", () => {
  it("POSTs to /contracts/v1/read with snake_case fields and no auth", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ result: 42 }));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.read({
      chain: "base-mainnet",
      contractAddress: "0x4444444444444444444444444444444444444444",
      abiFragment: [{ type: "function", name: "ping" }],
      functionName: "ping",
      args: [],
    });

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/read");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      chain: "base-mainnet",
      contract_address: "0x4444444444444444444444444444444444444444",
      abi_fragment: [{ type: "function", name: "ping" }],
      function_name: "ping",
      args: [],
    });
    assert.equal(result.result, 42);
  });

  it("accepts CLI-style aliases (to/abi/fn) and resolves to the same wire request", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ result: "0x" }));
    const sdk = makeSdk(fetch);
    await sdk.contracts.read({
      chain: "base-mainnet",
      to: "0x4444444444444444444444444444444444444444",
      abi: [{ type: "function", name: "ping" }],
      fn: "ping",
      args: [],
    });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      chain: "base-mainnet",
      contract_address: "0x4444444444444444444444444444444444444444",
      abi_fragment: [{ type: "function", name: "ping" }],
      function_name: "ping",
      args: [],
    });
  });

  it("prefers the canonical field over the alias when both are given", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ result: null }));
    const sdk = makeSdk(fetch);
    await sdk.contracts.read({
      chain: "base-mainnet",
      contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      abiFragment: [{ canonical: true }],
      abi: [{ canonical: false }],
      functionName: "canonical",
      fn: "alias",
      args: [],
    });
    const wire = JSON.parse(calls[0]!.body as string);
    assert.equal(wire.contract_address, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepEqual(wire.abi_fragment, [{ canonical: true }]);
    assert.equal(wire.function_name, "canonical");
  });

  it("throws LocalError when neither contractAddress nor to is provided", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.contracts.read({
        chain: "base-mainnet",
        abiFragment: [],
        functionName: "ping",
        args: [],
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when neither abiFragment nor abi is provided", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.contracts.read({
        chain: "base-mainnet",
        contractAddress: "0x4444444444444444444444444444444444444444",
        functionName: "ping",
        args: [],
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError when neither functionName nor fn is provided", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.contracts.read({
        chain: "base-mainnet",
        contractAddress: "0x4444444444444444444444444444444444444444",
        abiFragment: [],
        args: [],
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("contracts.callStatus", () => {
  it("GETs /contracts/v1/calls/:id with bearer auth", async () => {
    const callStatus = {
      call_id: "call_xyz",
      status: "confirmed",
      tx_hash: "0xdeadbeef",
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(callStatus));
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.callStatus("prj_known", "call_xyz");

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/calls/call_xyz");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.call_id, "call_xyz");
    assert.equal(result.status, "confirmed");
    assert.equal(result.tx_hash, "0xdeadbeef");
  });
});

describe("contracts.drain", () => {
  it("POSTs the destination_address with the X-Confirm-Drain header", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ call_id: "call_drain", status: "submitted", tx_hash: null }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.drain(
      "prj_known",
      "cwlt_abc",
      "0x5555555555555555555555555555555555555555",
    );

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/wallets/cwlt_abc/drain");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["X-Confirm-Drain"], "cwlt_abc");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      destination_address: "0x5555555555555555555555555555555555555555",
    });
    assert.equal(result.call_id, "call_drain");
  });
});

describe("contracts.deleteWallet", () => {
  it("DELETEs /contracts/v1/wallets/:id with X-Confirm-Delete header", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ wallet_id: "cwlt_abc", deleted_at: "2025-01-02T00:00:00Z" }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.contracts.deleteWallet("prj_known", "cwlt_abc");

    assert.equal(calls[0]!.url, "https://api.example.test/contracts/v1/wallets/cwlt_abc");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers["X-Confirm-Delete"], "cwlt_abc");
    assert.equal(result.wallet_id, "cwlt_abc");
  });
});
