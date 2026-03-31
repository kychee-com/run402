/**
 * AI Helpers E2E Test
 *
 * Tests the full AI helpers lifecycle against a running Run402 instance:
 *   0. Setup — subscribe to tier via x402, create project via wallet auth
 *   1. Activate translation add-on (admin)
 *   2. Deploy a function that calls ai.translate() and ai.moderate()
 *   3. Invoke translate — verify translated text returned
 *   4. Invoke moderate — verify flagged + categories + category_scores
 *   5. Check usage — verify words used > 0
 *   6. Translate without add-on — verify 402
 *   7. Translate with empty input — verify 400
 *   8. Moderate without add-on works — verify 200 (moderation is free)
 *   9. Cleanup — delete project
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npm run test:ai
 *   BASE_URL=http://localhost:4022 npm run test:ai
 *
 * Requires: BUYER_PRIVATE_KEY, ADMIN_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { ensureTestBalance } from "./ensure-balance.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

// x402 + SIWx setup
const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(path: string): Promise<Record<string, string>> {
  const baseUrl = new URL(BASE_URL);
  const uri = `${baseUrl.protocol}//${baseUrl.host}${path}`;
  const now = new Date();
  const info: CompleteSIWxInfo = {
    domain: baseUrl.hostname,
    uri,
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191",
  };
  const payload = createSIWxPayload(info);
  const header = await encodeSIWxHeader(payload, signer);
  return { "SIGN-IN-WITH-X": header };
}

// --- Test helpers ---
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// --- Main ---
(async () => {
  console.log(`\nAI Helpers E2E — ${BASE_URL}\n`);

  // 0. Setup — subscribe + create project
  console.log("0. Setup");

  await ensureTestBalance(fetchPaid, BASE_URL, account.address);

  const tierResp = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, { method: "POST" });
  ok("subscribe tier", tierResp.status === 200 || tierResp.status === 409, `status=${tierResp.status}`);

  const projResp = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await siwxHeaders("/projects/v1") },
    body: JSON.stringify({ name: "ai-e2e-test" }),
  });
  ok("create project", projResp.status === 201, `status=${projResp.status}`);
  const project = await projResp.json();
  const projectId = project.id;
  const serviceKey = project.service_key;
  console.log(`  project: ${projectId}`);

  // 1. Activate translation add-on
  console.log("\n1. Activate translation add-on");
  const addonResp = await fetch(`${BASE_URL}/ai/v1/addons`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ project_id: projectId, addon_type: "translation", included_words: 10000 }),
  });
  ok("activate add-on", addonResp.status === 201, `status=${addonResp.status}`);

  // 2. Deploy a function that uses ai.translate() and ai.moderate()
  console.log("\n2. Deploy AI test function");
  const fnCode = `
import { ai } from '@run402/functions';
export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  if (action === 'translate') {
    const result = await ai.translate('Hello world', 'es', { context: 'e2e test' });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }
  if (action === 'moderate') {
    const result = await ai.moderate('Hello world, this is a friendly message');
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
};
`;

  const deployResp = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ name: "ai-test", code: fnCode }),
  });
  ok("deploy function", deployResp.status === 201 || deployResp.status === 200, `status=${deployResp.status}`);

  // 3. Invoke translate
  console.log("\n3. Invoke translate");
  const translateResp = await fetch(`${BASE_URL}/projects/v1/${projectId}/functions/ai-test?action=translate`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  ok("translate status", translateResp.status === 200, `status=${translateResp.status}`);
  const translateResult = await translateResp.json();
  ok("translate has text", typeof translateResult.text === "string" && translateResult.text.length > 0, `text=${translateResult.text}`);
  ok("translate has to=es", translateResult.to === "es", `to=${translateResult.to}`);
  ok("translate has from", typeof translateResult.from === "string", `from=${translateResult.from}`);

  // 4. Invoke moderate
  console.log("\n4. Invoke moderate");
  const moderateResp = await fetch(`${BASE_URL}/projects/v1/${projectId}/functions/ai-test?action=moderate`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  ok("moderate status", moderateResp.status === 200, `status=${moderateResp.status}`);
  const moderateResult = await moderateResp.json();
  ok("moderate has flagged", typeof moderateResult.flagged === "boolean", `flagged=${moderateResult.flagged}`);
  ok("moderate has categories", typeof moderateResult.categories === "object", "has categories");
  ok("moderate has category_scores", typeof moderateResult.category_scores === "object", "has category_scores");
  ok("moderate not flagged (benign content)", moderateResult.flagged === false, `flagged=${moderateResult.flagged}`);

  // 5. Check usage
  console.log("\n5. Check usage");
  const usageResp = await fetch(`${BASE_URL}/ai/v1/usage`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  ok("usage status", usageResp.status === 200, `status=${usageResp.status}`);
  const usage = await usageResp.json();
  ok("usage active", usage.translation?.active === true, `active=${usage.translation?.active}`);
  ok("usage words > 0", usage.translation?.used_words > 0, `used_words=${usage.translation?.used_words}`);

  // 6. Test translate without add-on (deactivate first)
  console.log("\n6. Translate without add-on");
  await fetch(`${BASE_URL}/ai/v1/addons`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ project_id: projectId, addon_type: "translation" }),
  });

  const noAddonResp = await fetch(`${BASE_URL}/ai/v1/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ text: "Hello", to: "es" }),
  });
  ok("translate without add-on → 402", noAddonResp.status === 402, `status=${noAddonResp.status}`);

  // 7. Test translate with invalid input
  console.log("\n7. Translate with invalid input");
  // Re-activate for this test
  await fetch(`${BASE_URL}/ai/v1/addons`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ project_id: projectId, addon_type: "translation", included_words: 10000 }),
  });

  const emptyResp = await fetch(`${BASE_URL}/ai/v1/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ text: "", to: "es" }),
  });
  ok("empty text → 400", emptyResp.status === 400, `status=${emptyResp.status}`);

  const noToResp = await fetch(`${BASE_URL}/ai/v1/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ text: "Hello" }),
  });
  ok("missing 'to' → 400", noToResp.status === 400, `status=${noToResp.status}`);

  // 8. Moderate without add-on (should work — moderation is free)
  console.log("\n8. Moderate without add-on");
  const moderateFreeResp = await fetch(`${BASE_URL}/ai/v1/moderate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ text: "Hello world" }),
  });
  ok("moderate without add-on → 200", moderateFreeResp.status === 200, `status=${moderateFreeResp.status}`);

  // 9. Cleanup
  console.log("\n9. Cleanup");
  const deleteResp = await fetch(`${BASE_URL}/projects/v1/${projectId}`, {
    method: "DELETE",
    headers: { ...await siwxHeaders(`/projects/v1/${projectId}`) },
  });
  ok("delete project", deleteResp.status === 200 || deleteResp.status === 204, `status=${deleteResp.status}`);

  // --- Summary ---
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
