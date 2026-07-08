#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { NodeCredentialsProvider } from "@run402/sdk/node";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const url = process.env.WALLET_STATS_URL || process.argv[2];
const network = process.env.X402_NETWORK || "eip155:84532";

if (!url) {
  fail("Missing WALLET_STATS_URL or positional URL.\nUsage: WALLET_STATS_URL=https://<host>/wallet-stats node scripts/call-paid-wallet-stats.mjs");
}

const payer = await resolvePayerWallet();
const chain = network === "eip155:8453" ? base : baseSepolia;
const rpcUrl = process.env.RPC_URL || process.env.BASE_RPC_URL;
const account = privateKeyToAccount(payer.privateKey);
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
console.log(`Payer source: ${payer.source}${payer.name ? ` (${payer.name})` : ""}`);
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

async function resolvePayerWallet() {
  const buyerKey = process.env.BUYER_PRIVATE_KEY;
  if (buyerKey) {
    if (!buyerKey.startsWith("0x")) {
      fail("BUYER_PRIVATE_KEY must start with 0x.");
    }
    return { source: "BUYER_PRIVATE_KEY", name: null, privateKey: buyerKey };
  }

  const current = readCurrentRun402Wallet();
  const profile = current.local_label || current.server_label || null;
  if (profile) {
    process.env.RUN402_WALLET = profile;
  }

  const provider = new NodeCredentialsProvider();
  const allowance = await provider.readAllowance();
  if (!allowance?.privateKey) {
    fail(
      "Missing BUYER_PRIVATE_KEY and the active run402 wallet has no local allowance key.\n" +
        "Run `run402 wallets use <name>` and `run402 init`, or set BUYER_PRIVATE_KEY=0x...",
    );
  }
  if (!allowance.privateKey.startsWith("0x")) {
    fail("Active run402 wallet private key is malformed; expected a 0x-prefixed key.");
  }

  return {
    source: `run402 wallets current (${current.source || "unknown"})`,
    name: profile,
    privateKey: allowance.privateKey,
  };
}

function readCurrentRun402Wallet() {
  try {
    const stdout = execFileSync("run402", ["wallets", "current", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch {
    fail(
      "Missing BUYER_PRIVATE_KEY and could not resolve the active run402 wallet.\n" +
        "Run `run402 wallets current --json` to check your default wallet, or set BUYER_PRIVATE_KEY=0x...",
    );
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
