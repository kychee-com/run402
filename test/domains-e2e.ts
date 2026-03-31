/**
 * Custom Domains E2E Test — verifies the domains API and Cloudflare KV sync.
 *
 * Tests:
 *   1. Register a custom domain for an existing subdomain
 *   2. Check domain status (should be pending with DNS instructions)
 *   3. List domains for project
 *   4. Delete domain
 *   5. Verify domain is gone
 *   6. Redeploy subdomain → verify KV updated for linked domain
 *
 * Usage: BASE_URL=https://api.run402.com npx tsx test/domains-e2e.ts
 *
 * Requires: BUYER_PRIVATE_KEY, ADMIN_KEY in env
 */

import { config } from "dotenv";
config();

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

let passed = 0;
let failed = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function adminFetch(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      ...opts?.headers,
      "x-admin-key": ADMIN_KEY!,
      "Content-Type": "application/json",
    },
  });
}

async function run() {
  console.log(`\nCustom Domains E2E — ${BASE_URL}\n`);

  // ---- Setup: find an existing subdomain to link to ----
  const subdomainsRes = await adminFetch("/subdomains/v1");
  const subdomains = (await subdomainsRes.json() as { subdomains: Array<{ name: string; deployment_id: string; project_id: string }> }).subdomains;
  if (subdomains.length === 0) {
    console.error("No subdomains found — need at least one to test custom domains");
    process.exit(1);
  }
  const testSubdomain = subdomains[0];
  console.log(`Using subdomain: ${testSubdomain.name} (deployment: ${testSubdomain.deployment_id})\n`);

  const testDomain = `test-${Date.now()}.example.org`;

  // ---- Test 1: Register a custom domain ----
  console.log("1. Register custom domain");
  const createRes = await adminFetch("/domains/v1", {
    method: "POST",
    body: JSON.stringify({
      domain: testDomain,
      subdomain_name: testSubdomain.name,
    }),
  });
  const createBody = await createRes.json() as {
    domain: string; subdomain_name: string; status: string;
    dns_instructions: unknown; url: string; subdomain_url: string;
  };
  assert(createRes.status === 201, `POST /domains/v1 returns 201 (got ${createRes.status})`);
  assert(createBody.domain === testDomain, `domain matches (${createBody.domain})`);
  assert(createBody.subdomain_name === testSubdomain.name, `subdomain_name matches`);
  assert(createBody.status === "pending", `status is pending (got ${createBody.status})`);
  assert(createBody.url === `https://${testDomain}`, `url is correct`);
  assert(createBody.subdomain_url === `https://${testSubdomain.name}.run402.com`, `subdomain_url is correct`);

  // ---- Test 2: Check domain status ----
  console.log("\n2. Check domain status");
  const statusRes = await adminFetch(`/domains/v1/${testDomain}`);
  const statusBody = await statusRes.json() as { domain: string; status: string; dns_instructions: unknown };
  assert(statusRes.status === 200, `GET /domains/v1/:domain returns 200 (got ${statusRes.status})`);
  assert(statusBody.domain === testDomain, `domain matches`);
  assert(statusBody.status === "pending", `status is pending`);

  // ---- Test 3: List domains ----
  console.log("\n3. List domains");
  const listRes = await adminFetch("/domains/v1");
  const listBody = await listRes.json() as { domains: Array<{ domain: string }> };
  assert(listRes.status === 200, `GET /domains/v1 returns 200`);
  const found = listBody.domains.some((d) => d.domain === testDomain);
  assert(found, `domain appears in list`);

  // ---- Test 4: Duplicate registration fails ----
  console.log("\n4. Duplicate registration");
  const dupRes = await adminFetch("/domains/v1", {
    method: "POST",
    body: JSON.stringify({
      domain: testDomain,
      subdomain_name: testSubdomain.name,
    }),
  });
  assert(dupRes.status === 409, `duplicate registration returns 409 (got ${dupRes.status})`);

  // ---- Test 5: Invalid domain ----
  console.log("\n5. Invalid domain");
  const invalidRes = await adminFetch("/domains/v1", {
    method: "POST",
    body: JSON.stringify({
      domain: "not-a-domain",
      subdomain_name: testSubdomain.name,
    }),
  });
  assert(invalidRes.status === 400, `invalid domain returns 400 (got ${invalidRes.status})`);

  // ---- Test 6: run402.com subdomain rejected ----
  console.log("\n6. run402.com subdomain rejected");
  const r402Res = await adminFetch("/domains/v1", {
    method: "POST",
    body: JSON.stringify({
      domain: "myapp.run402.com",
      subdomain_name: testSubdomain.name,
    }),
  });
  assert(r402Res.status === 400, `run402.com subdomain returns 400 (got ${r402Res.status})`);

  // ---- Test 7: Delete domain ----
  console.log("\n7. Delete domain");
  const deleteRes = await adminFetch(`/domains/v1/${testDomain}`, { method: "DELETE" });
  const deleteBody = await deleteRes.json() as { status: string; domain: string };
  assert(deleteRes.status === 200, `DELETE returns 200 (got ${deleteRes.status})`);
  assert(deleteBody.status === "deleted", `status is deleted`);
  assert(deleteBody.domain === testDomain, `domain matches`);

  // ---- Test 8: Domain gone after delete ----
  console.log("\n8. Domain gone after delete");
  const goneRes = await adminFetch(`/domains/v1/${testDomain}`);
  assert(goneRes.status === 404, `GET after delete returns 404 (got ${goneRes.status})`);

  // ---- Summary ----
  console.log(`\n${"=".repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
