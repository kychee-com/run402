/**
 * Runs the client-side x402 shared `exact` lnbtc vectors (`exact_lnbtc.vectors.json`,
 * a copy of `specs/schemes/exact/vectors/exact_lnbtc.json` at the vendored
 * commit) against this vendored copy: the request bindings and the client
 * cases. The server and facilitator cases run in the Run402 gateway's copy.
 * It proves the local edits in VENDORED.md changed no outcome.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired } from "@x402/core/types";
import { httpRequestBinding, mcpToolCallBinding, type RequestBinding } from "./binding.js";
import { ExactLnbtcScheme as LnbtcClient } from "./exact/client/scheme.js";
import type { LightningPayer, LightningPayment } from "./types.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Expect = Record<string, Json>;
type PatchOp = { op: "add" | "remove" | "replace"; path: string; value?: Json };

interface HttpInput {
  method: string;
  url: string;
  body_hex: string;
  bound_headers: string[];
  header_lines: [string, string][];
}
interface McpInput {
  server: string;
  bound_metadata: string[];
  params?: Record<string, unknown>;
  params_json?: string;
}
interface Case {
  id: string;
  note: string;
  expect: Expect;
}
interface Vectors {
  fixture_version: number;
  http_binding: (Case & { input: HttpInput })[];
  http_server_adapter: (Case & {
    config: { public_origin: string; bound_headers: string[] };
    input: { method: string; url: string; header_lines: [string, string][]; body_hex: string };
  })[];
  mcp_binding: (Case & { input: McpInput })[];
  client: { base: Json; cases: (Case & { now: number; skew: number; patch: PatchOp[] })[] };
  facilitator_settle: {
    base: Json;
    cases: {
      id: string;
      group: string;
      steps: { now: number; skew: number; patch: PatchOp[]; expect: Expect }[];
    }[];
  };
}

const VECTORS = JSON.parse(
  readFileSync(new URL("./exact_lnbtc.vectors.json", import.meta.url), "utf8"),
) as Vectors;

/** The outcome upstream pins on each case the specification leaves open. */
const OPEN_OUTCOMES: Record<string, string> = {
  "http_binding/url-port-zero": "bind",
  "mcp_binding/integer-2-53-plus-1": "bind_as_double",
  "mcp_binding/integer-2-64": "bind_as_double",
  "client/invoice-at-end": "reject",
};

function applyPatch<T>(base: Json, ops: PatchOp[]): T {
  const doc = structuredClone(base) as Record<string, Json>;
  for (const { op, path, value } of ops) {
    const parts = path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = parts.pop()!;
    let node = doc;
    for (const part of parts) node = node[part] as Record<string, Json>;
    if (op === "remove") delete node[last];
    else node[last] = structuredClone(value as Json);
  }
  return doc as T;
}

const lookup = (lines: [string, string][]) => (name: string): string[] | undefined => {
  const values = lines.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
  return values.length === 0 ? undefined : values;
};

const httpBinding = (input: HttpInput) =>
  httpRequestBinding({
    method: input.method,
    url: input.url,
    body: hexToBytes(input.body_hex),
    boundHeaders: input.bound_headers,
    getHeader: lookup(input.header_lines),
  });

const mcpBinding = (input: McpInput) => {
  const params = (input.params_json === undefined ? input.params : JSON.parse(input.params_json)) as Record<string, unknown>;
  return mcpToolCallBinding({
    server: input.server,
    name: params.name as string,
    arguments: params.arguments,
    meta: params._meta,
    boundMetadata: input.bound_metadata,
  });
};

type Outcome = { value?: RequestBinding; error?: string };

async function attempt(fn: () => RequestBinding | Promise<RequestBinding>): Promise<Outcome> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const bindingMatches = (result: Outcome, want: Expect) =>
  "request_hash" in want
    ? result.value?.requestHash === want.request_hash
    : result.error !== undefined && result.error.includes(want.error as string);

function assertExpect(key: string, want: Expect, matches: (e: Expect) => boolean): void {
  if (!("open" in want)) {
    assert.equal(matches(want), true, key);
    return;
  }
  const outcomes = want.outcomes as Record<string, Expect>;
  const taken = Object.keys(outcomes).filter((name) => matches(outcomes[name]));
  assert.deepEqual(taken, [OPEN_OUTCOMES[key]], key);
}

describe("lnbtc shared vectors: file", () => {
  it("is fixture version 1", () => {
    assert.equal(VECTORS.fixture_version, 1);
  });
});

describe("lnbtc shared vectors: http_binding", () => {
  for (const c of VECTORS.http_binding) {
    it(c.id, async () => {
      const result = await attempt(() => httpBinding(c.input));
      assertExpect(`http_binding/${c.id}`, c.expect, (e) => bindingMatches(result, e));
      if ("canonical_description" in c.expect) {
        const description = new TextEncoder().encode(c.expect.canonical_description as string);
        assert.equal(bytesToHex(sha256(description)), c.expect.request_hash);
      }
    });
  }
});

describe("lnbtc shared vectors: mcp_binding", () => {
  for (const c of VECTORS.mcp_binding) {
    it(c.id, async () => {
      const result = await attempt(() => mcpBinding(c.input));
      assertExpect(`mcp_binding/${c.id}`, c.expect, (e) => bindingMatches(result, e));
    });
  }
});

interface ClientDoc {
  intended_request: { profile: "http:1"; http: HttpInput } | { profile: "mcp:1"; mcp: McpInput };
  payment_required: PaymentRequired;
  payer_result: {
    status: LightningPayment["status"];
    invoice: string;
    payment_hash: string;
    amount_msat: string;
    preimage: string | null;
  };
}

describe("lnbtc shared vectors: client", () => {
  for (const c of VECTORS.client.cases) {
    it(c.id, async () => {
      const doc = applyPatch<ClientDoc>(VECTORS.client.base, c.patch);
      const intended = doc.intended_request;
      const result = doc.payer_result;
      let calls = 0;
      const payer: LightningPayer = {
        payInvoice: async () => {
          calls += 1;
          return {
            invoice: result.invoice,
            paymentHash: result.payment_hash,
            amountMsat: BigInt(result.amount_msat),
            status: result.status,
            preimage: result.preimage,
          } as LightningPayment;
        },
      };
      const client = new x402Client().setSpendControls(false).register(
        doc.payment_required.accepts[0].network as Network,
        new LnbtcClient({
          payer,
          requestBinding: () => (intended.profile === "http:1" ? httpBinding(intended.http) : mcpBinding(intended.mcp)),
          clock: () => c.now,
          clockSkewSeconds: c.skew,
        }),
      );
      let outcome: { payload?: PaymentPayload; error?: string };
      try {
        outcome = { payload: await client.createPaymentPayload(doc.payment_required) };
      } catch (error) {
        outcome = { error: (error as Error).message };
      }
      assertExpect(`client/${c.id}`, c.expect, (e) =>
        "error" in e
          ? outcome.error !== undefined && outcome.error.includes(e.error as string) && calls === (e.payer_called ? 1 : 0)
          : outcome.payload?.payload.preimage === e.preimage && calls === 1,
      );
    });
  }
});
