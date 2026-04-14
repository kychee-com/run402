/**
 * Custom Sender Domain E2E Test
 *
 * Tests the custom sender domain lifecycle:
 *   0. Setup — subscribe, create project
 *   1. Register domain — returns DNS records
 *   2. Check status — pending (DNS not configured in test)
 *   3. Remove domain — returns 200
 *   4. Check after removal — domain: null
 *   5. Register again — works (re-registration)
 *   6. Blocklist — gmail.com rejected
 *   7. Cleanup
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npm run test:sender-domain
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

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(path: string): Promise<Record<string, string>> {
  const baseUrl = new URL(BASE_URL);
  const now = new Date();
  const info: CompleteSIWxInfo = { domain: baseUrl.hostname, uri: `${baseUrl.protocol}//${baseUrl.host}${path}`, statement: "Sign in to Run402", version: "1", nonce: Math.random().toString(36).slice(2), issuedAt: now.toISOString(), expirationTime: new Date(now.getTime() + 300000).toISOString(), chainId: "eip155:84532", type: "eip191" };
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \u2713 ${name}${detail ? " \u2014 " + detail : ""}`); passed++; }
  else { console.error(`  \u2717 ${name}${detail ? " \u2014 " + detail : ""}`); failed++; }
}

(async () => {
  console.log(`\nCustom Sender Domain E2E \u2014 ${BASE_URL}\n`);

  // 0. Setup
  console.log("0. Setup");
  await ensureTestBalance(account.address, BASE_URL);
  const tierResp = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, { method: "POST" });
  ok("subscribe tier", [200, 201, 409].includes(tierResp.status), `status=${tierResp.status}`);

  const projResp = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await siwxHeaders("/projects/v1") },
    body: JSON.stringify({ name: "sd-e2e" }),
  });
  ok("create project", projResp.status === 201, `status=${projResp.status}`);
  const project = await projResp.json();
  const serviceKey = project.service_key;
  console.log(`  project: ${project.project_id}`);

  // Use a test domain that we don't actually own — registration will succeed but verification will stay pending
  const testDomain = `test-${Date.now()}.example.com`;

  // 1. Register domain
  console.log("\n1. Register domain");
  const regResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey },
    body: JSON.stringify({ domain: testDomain }),
  });
  const regBody = await regResp.json();
  ok("register domain", regResp.status === 201, `status=${regResp.status}`);
  ok("returns domain name", regBody.domain === testDomain);
  ok("status is pending", regBody.status === "pending");
  ok("has DNS records", Array.isArray(regBody.dns_records) && regBody.dns_records.length > 0);
  ok("has DKIM CNAMEs", regBody.dns_records?.filter((r: { type: string }) => r.type === "CNAME").length === 3);
  ok("has instructions", !!regBody.instructions);

  // 2. Check status
  console.log("\n2. Check status");
  const statusResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    headers: { apikey: serviceKey },
  });
  const statusBody = await statusResp.json();
  ok("status endpoint works", statusResp.status === 200);
  ok("domain matches", statusBody.domain === testDomain);
  ok("status is pending", statusBody.status === "pending");
  ok("status response includes inbound object", !!statusBody.inbound);
  ok("inbound disabled by default", statusBody.inbound?.enabled === false);
  ok(
    "inbound.mx_record is the SES receive endpoint",
    statusBody.inbound?.mx_record === "10 inbound-smtp.us-east-1.amazonaws.com",
  );
  ok("inbound.mx_verified is false when disabled", statusBody.inbound?.mx_verified === false);

  // 2b. Enable inbound should refuse on a pending (unverified) domain
  console.log("\n2b. enableInbound refuses unverified domain");
  const enableWhilePending = await fetch(`${BASE_URL}/email/v1/domains/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey },
    body: JSON.stringify({ domain: testDomain }),
  });
  ok(
    "enableInbound 409 on unverified domain",
    enableWhilePending.status === 409,
    `status=${enableWhilePending.status}`,
  );

  // 3. Remove domain
  console.log("\n3. Remove domain");
  const delResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    method: "DELETE",
    headers: { apikey: serviceKey },
  });
  ok("remove domain", delResp.status === 200, `status=${delResp.status}`);

  // 4. Check after removal
  console.log("\n4. Check after removal");
  const afterResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    headers: { apikey: serviceKey },
  });
  const afterBody = await afterResp.json();
  ok("domain is null after removal", afterBody.domain === null);

  // 5. Re-register
  console.log("\n5. Re-register");
  const reRegResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey },
    body: JSON.stringify({ domain: `retest-${Date.now()}.example.com` }),
  });
  ok("re-register works", reRegResp.status === 201, `status=${reRegResp.status}`);

  // 6. Blocklist
  console.log("\n6. Blocklist");
  // Remove the re-registered domain first
  await fetch(`${BASE_URL}/email/v1/domains`, { method: "DELETE", headers: { apikey: serviceKey } });
  const blockResp = await fetch(`${BASE_URL}/email/v1/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey },
    body: JSON.stringify({ domain: "gmail.com" }),
  });
  ok("gmail.com rejected", blockResp.status === 400, `status=${blockResp.status}`);

  // 7. Remove 404
  console.log("\n7. Remove when none");
  const del404Resp = await fetch(`${BASE_URL}/email/v1/domains`, {
    method: "DELETE",
    headers: { apikey: serviceKey },
  });
  ok("remove returns 404 when none", del404Resp.status === 404, `status=${del404Resp.status}`);

  // --- Summary ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
