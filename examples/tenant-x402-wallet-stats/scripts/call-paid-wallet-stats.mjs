#!/usr/bin/env node

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const url = process.env.WALLET_STATS_URL || process.argv[2];
const buyerKey = process.env.BUYER_PRIVATE_KEY;
const network = process.env.X402_NETWORK || "eip155:84532";

if (!url) {
  fail("Missing WALLET_STATS_URL or positional URL.\nUsage: WALLET_STATS_URL=https://<host>/wallet-stats BUYER_PRIVATE_KEY=0x... node scripts/call-paid-wallet-stats.mjs");
}
if (!buyerKey) {
  fail("Missing BUYER_PRIVATE_KEY=0x... for the agent payer wallet.");
}
if (!buyerKey.startsWith("0x")) {
  fail("BUYER_PRIVATE_KEY must start with 0x.");
}

const chain = network === "eip155:8453" ? base : baseSepolia;
const rpcUrl = process.env.RPC_URL || process.env.BASE_RPC_URL;
const account = privateKeyToAccount(buyerKey);
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});
const signer = toClientEvmSigner(account, publicClient);

const x402 = new x402Client();
x402.register(network, new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, x402);
const httpClient = new x402HTTPClient(x402);

const payload = {
  agent_label: process.env.AGENT_LABEL || "tenant-x402-wallet-stats-smoke",
  wallet_address: signer.address,
  note: "Paid call from the minimal tenant x402 wallet-stats example.",
};

console.log(`Calling ${url}`);
console.log(`Agent payer wallet: ${signer.address}`);
console.log(`x402 network: ${network}`);

const res = await fetchPaid(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "run402-tenant-x402-wallet-stats-example/1.0",
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

const settlement = readSettlement(res);
if (!res.ok) {
  console.error(JSON.stringify({ status: res.status, body, settlement }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: res.status,
  settlement,
  result: body,
}, null, 2));

function readSettlement(response) {
  try {
    return httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
