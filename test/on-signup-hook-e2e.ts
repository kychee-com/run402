/**
 * E2E test for the on-signup lifecycle hook.
 *
 * 1. Create a project (wallet auth)
 * 2. Apply schema with hook_log table
 * 3. Deploy an on-signup function that inserts into hook_log
 * 4. Sign up a new user → verify hook_log row appears
 * 5. Log in as the same user → verify no new hook_log row
 * 6. Cleanup
 */

import { config } from "dotenv";
config();

import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const ADMIN_KEY = process.env.ADMIN_KEY!;

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

const account = privateKeyToAccount(BUYER_KEY);

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
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function run() {
  console.log(`\n=== on-signup hook E2E ===\n`);
  console.log(`Target: ${BASE_URL}\n`);

  // 1. Create project via wallet auth
  console.log("1) Create project...");
  const headers = await siwxHeaders("/projects/v1");
  const createResp = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "hook-test" }),
  });
  assert(createResp.status === 201, "Project created", `got ${createResp.status}`);
  const project = await createResp.json() as any;
  const { project_id, anon_key, service_key } = project;
  console.log(`  project_id: ${project_id}\n`);

  // 2. Apply schema with hook_log table
  console.log("2) Apply schema...");
  const schemaResp = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: `Bearer ${service_key}` },
    body: `CREATE TABLE hook_log (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE hook_log ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "service_all" ON hook_log FOR ALL TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY "auth_read" ON hook_log FOR SELECT TO authenticated USING (true);`,
  });
  assert(schemaResp.ok, "Schema applied", `got ${schemaResp.status}`);

  // 3. Deploy on-signup function
  console.log("\n3) Deploy on-signup function...");
  const fnCode = `
import { db } from "@run402/functions";

export default async function handler(request) {
  const { user } = await request.json();
  await db.from("hook_log").insert({ user_id: user.id, email: user.email });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}
`;
  const deployResp = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/functions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service_key}` },
    body: JSON.stringify({ name: "on-signup", code: fnCode }),
  });
  assert(deployResp.status === 201, "on-signup function deployed", `got ${deployResp.status}`);

  // 4. Sign up a new user
  const testEmail = `hook-test-${Date.now()}@example.com`;
  console.log(`\n4) Sign up user: ${testEmail}...`);
  const signupResp = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: testEmail, password: "testpass123" }),
  });
  assert(signupResp.status === 201, "Signup succeeds", `got ${signupResp.status}`);
  const signupData = await signupResp.json() as any;
  const userId = signupData.id;

  // 5. Wait for hook to fire (fire-and-forget, poll for result)
  console.log("\n5) Wait for hook to fire...");
  let hookRow: any = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const checkResp = await fetch(
      `${BASE_URL}/rest/v1/hook_log?user_id=eq.${userId}`,
      { headers: { apikey: service_key, authorization: `Bearer ${service_key}` } },
    );
    const rows = await checkResp.json() as any[];
    if (rows.length > 0) {
      hookRow = rows[0];
      break;
    }
    process.stdout.write(`  ... attempt ${i + 1}/15\n`);
  }

  assert(hookRow !== null, "on-signup hook fired (hook_log row exists)");
  if (hookRow) {
    assert(hookRow.user_id === userId, "hook_log.user_id matches signup user");
    assert(hookRow.email === testEmail, "hook_log.email matches signup email");
  }

  // 6. Log in as the same user — hook should NOT fire again
  console.log("\n6) Log in (should NOT trigger hook)...");
  const loginResp = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: testEmail, password: "testpass123" }),
  });
  assert(loginResp.status === 200, "Login succeeds", `got ${loginResp.status}`);

  // Wait a moment, then check hook_log count
  await new Promise(r => setTimeout(r, 5000));
  const countResp = await fetch(
    `${BASE_URL}/rest/v1/hook_log?user_id=eq.${userId}`,
    { headers: { apikey: service_key, authorization: `Bearer ${service_key}` } },
  );
  const allRows = await countResp.json() as any[];
  assert(allRows.length === 1, "Login did NOT trigger hook (still 1 row)", `got ${allRows.length} rows`);

  // 7. Cleanup
  console.log("\n7) Cleanup...");
  const deleteResp = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}`, {
    method: "DELETE",
    headers: { "x-admin-key": ADMIN_KEY },
  });
  assert(deleteResp.ok, "Project deleted");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
