#!/usr/bin/env node
/**
 * Run402 image generator — generate images via x402 micropayment.
 *
 * Usage:
 *   node image.mjs generate "a cat in a top hat"
 *   node image.mjs generate "a cat in a top hat" --aspect landscape --output cat.png
 *
 * Options:
 *   --aspect <square|landscape|portrait>  Aspect ratio (default: square)
 *   --output <path>                       Save PNG to file (otherwise outputs base64)
 *
 * Cost: $0.03 per image via x402.
 */

import { writeFileSync, existsSync } from "fs";
import { readWallet, API, WALLET_FILE } from "./config.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { command: null, prompt: null, aspect: "square", output: null };
  if (args.length === 0) return opts;
  opts.command = args[0];
  let i = 1;
  if (i < args.length && !args[i].startsWith("--")) opts.prompt = args[i++];
  while (i < args.length) {
    if (args[i] === "--aspect" && args[i + 1]) { opts.aspect = args[++i]; }
    else if (args[i] === "--output" && args[i + 1]) { opts.output = args[++i]; }
    i++;
  }
  return opts;
}

async function generate(opts) {
  if (!opts.prompt) {
    console.error(JSON.stringify({ status: "error", message: "Prompt required." }));
    process.exit(1);
  }
  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: node wallet.mjs create && node wallet.mjs fund" }));
    process.exit(1);
  }
  const wallet = readWallet();

  const { privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");

  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer));
  const fetchPaid = wrapFetchWithPayment(fetch, client);

  const res = await fetchPaid(`${API}/generate-image/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: opts.prompt, aspect: opts.aspect }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }

  if (opts.output) {
    const buf = Buffer.from(data.image, "base64");
    writeFileSync(opts.output, buf);
    console.log(JSON.stringify({ status: "ok", file: opts.output, size: buf.length, aspect: data.aspect }));
  } else {
    console.log(JSON.stringify({ status: "ok", aspect: data.aspect, content_type: data.content_type, image: data.image }));
  }
}

const opts = parseArgs();
switch (opts.command) {
  case "generate": await generate(opts); break;
  default:
    console.log("Usage: node image.mjs generate \"prompt\" [--aspect square|landscape|portrait] [--output file.png]");
    process.exit(1);
}
