/**
 * Functions E2E Test
 *
 * Tests the full functions lifecycle against a running Run402 instance:
 *   0. Setup — credit allowance, create project via allowance
 *   1. Set a secret (TEST_SECRET)
 *   2. List secrets
 *   3. Deploy a function that reads the secret
 *   4. Invoke the function via HTTP, verify response
 *   5. Get function logs
 *   6. Redeploy function (overwrite), verify new code runs
 *   7. List functions
 *   8. Deploy getUser function
 *   9. Sign up user for getUser test
 *  10. Invoke getUser with valid access token
 *  11. Invoke getUser without auth header (returns null)
 *  12. Invoke getUser with invalid token (returns null)
 *  13. Delete function, verify 404 on invoke
 *  14. Delete secret
 *  15. Cleanup — delete project, debit remaining allowance
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npm run test:functions
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error("Missing ADMIN_KEY in .env");
  process.exit(1);
}

// x402 setup
const account = privateKeyToAccount(BUYER_KEY);
const wallet = account.address.toLowerCase();
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\nFunctions E2E Test — ${BASE_URL}\n`);

  let projectId = "";
  let serviceKey = "";
  let anonKey = "";

  // --- Step 0: Setup — credit allowance and create project ---
  console.log("Step 0: Setup — create project");

  // Credit $1 allowance
  const creditRes = await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/credit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN_KEY,
    },
    body: JSON.stringify({
      amount_usd_micros: 1_000_000,
      reason: "functions-e2e setup",
      idempotency_key: `functions-e2e-setup-${Date.now()}`,
    }),
  });
  assert(creditRes.ok, `Allowance credited ($1)`);

  // Create project via allowance (x402 payment)
  const projRes = await fetchPaid(`${BASE_URL}/v1/projects/create/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `func-test-${Date.now()}` }),
  });
  const projBody = await projRes.json() as Record<string, unknown>;
  assert(projRes.ok, `Project created (${projBody.project_id})`);

  projectId = projBody.project_id as string;
  serviceKey = projBody.service_key as string;
  anonKey = projBody.anon_key as string;
  console.log(`  Project: ${projectId}\n`);

  try {
    // --- Step 1: Set a secret ---
    console.log("Step 1: Set a secret");
    {
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/secrets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "TEST_SECRET", value: "hello-from-secret" }),
      });
      const body = await res.json();
      assert(res.status === 200, `Set secret: ${res.status}`);
      assert(body.key === "TEST_SECRET", `Secret key matches`);
    }

    // --- Step 2: List secrets ---
    console.log("\nStep 2: List secrets");
    {
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/secrets`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      const body = await res.json();
      assert(res.status === 200, `List secrets: ${res.status}`);
      assert(body.secrets.some((s: { key: string }) => s.key === "TEST_SECRET"), "TEST_SECRET in list");
    }

    // --- Step 3: Deploy a function ---
    console.log("\nStep 3: Deploy a function");
    const functionCode = `
export default async (req) => {
  console.log("Function invoked!");
  const secret = process.env.TEST_SECRET;
  const method = req.method;
  const url = new URL(req.url);

  return new Response(JSON.stringify({
    message: "Hello from function",
    secret_value: secret,
    method,
    path: url.pathname,
  }), {
    headers: { "Content-Type": "application/json" },
  });
};
`;

    let functionUrl = "";
    {
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "test-func",
          code: functionCode,
        }),
      });
      const body = await res.json();
      assert(res.status === 201, `Deploy function: ${res.status}`);
      assert(body.name === "test-func", `Function name matches`);
      assert(body.status === "deployed", `Function status is deployed`);
      assert(body.url.includes("/functions/v1/test-func"), `URL shape correct`);
      functionUrl = body.url;
      console.log(`  URL: ${functionUrl}`);
    }

    // Wait for Lambda to be ready
    await sleep(3000);

    // --- Step 4: Invoke the function ---
    console.log("\nStep 4: Invoke function via HTTP");
    {
      const res = await fetch(`${BASE_URL}/functions/v1/test-func`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ test: true }),
      });
      const text = await res.text();
      assert(res.status === 200, `Invoke function: ${res.status}`);

      try {
        const body = JSON.parse(text);
        assert(body.message === "Hello from function", `Response message correct`);
        assert(body.secret_value === "hello-from-secret", `Secret injected correctly`);
        assert(body.method === "POST", `Method forwarded correctly`);
      } catch {
        console.error("  Failed to parse response:", text);
        failed++;
      }
    }

    // --- Step 5: Get function logs ---
    console.log("\nStep 5: Get function logs");
    await sleep(2000); // Wait for CloudWatch ingestion
    {
      const res = await fetch(
        `${BASE_URL}/admin/v1/projects/${projectId}/functions/test-func/logs?tail=10`,
        { headers: { Authorization: `Bearer ${serviceKey}` } },
      );
      const body = await res.json();
      assert(res.status === 200, `Get logs: ${res.status}`);
      assert(Array.isArray(body.logs), `Logs is array`);
      // Logs may take time to appear in CloudWatch
      if (body.logs.length > 0) {
        assert(
          body.logs.some((l: { message: string }) => l.message.includes("Function invoked")),
          `console.log output appears in logs`,
        );
      } else {
        console.log("  SKIP: No logs yet (CloudWatch delay)");
      }
    }

    // --- Step 6: Redeploy (overwrite) ---
    console.log("\nStep 6: Redeploy function");
    {
      const newCode = `
export default async (req) => {
  return new Response(JSON.stringify({ version: 2 }), {
    headers: { "Content-Type": "application/json" },
  });
};
`;
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "test-func", code: newCode }),
      });
      assert(res.status === 201, `Redeploy: ${res.status}`);

      await sleep(3000);

      // Invoke and verify new code
      const invokeRes = await fetch(`${BASE_URL}/functions/v1/test-func`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      const body = await invokeRes.json();
      assert(body.version === 2, `New code running after redeploy`);
    }

    // --- Step 7: List functions ---
    console.log("\nStep 7: List functions");
    {
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      const body = await res.json();
      assert(res.status === 200, `List functions: ${res.status}`);
      assert(body.functions.length >= 1, `At least 1 function listed`);
      assert(
        body.functions.some((f: { name: string }) => f.name === "test-func"),
        `test-func in list`,
      );
    }

    // --- Step 8: Deploy getUser function ---
    console.log("\nStep 8: Deploy getUser function");
    const getUserFunctionCode = `
import { db, getUser } from '@run402/functions';

export default async (req) => {
  const user = getUser(req);
  return new Response(JSON.stringify({ user }), {
    headers: { "Content-Type": "application/json" },
  });
};
`;
    {
      const res = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "getuser-test", code: getUserFunctionCode }),
      });
      assert(res.status === 201, `Deploy getUser function: ${res.status}`);
    }

    await sleep(3000);

    // --- Step 9: Sign up a user to get an access token ---
    console.log("\nStep 9: Sign up user for getUser test");
    let userAccessToken = "";
    let testUserId = "";
    {
      const signupRes = await fetch(`${BASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ email: "getuser-test@example.com", password: "test-password-123" }),
      });
      const signupBody = await signupRes.json() as Record<string, unknown>;
      assert(signupRes.ok, `User signed up`);
      testUserId = signupBody.id as string;

      const loginRes = await fetch(`${BASE_URL}/auth/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ email: "getuser-test@example.com", password: "test-password-123" }),
      });
      const loginBody = await loginRes.json() as Record<string, unknown>;
      assert(loginRes.ok, `User logged in`);
      userAccessToken = loginBody.access_token as string;
    }

    // --- Step 10: Invoke getUser with valid token ---
    console.log("\nStep 10: Invoke getUser with valid access token");
    {
      const res = await fetch(`${BASE_URL}/functions/v1/getuser-test`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${userAccessToken}`,
        },
      });
      const body = await res.json() as Record<string, unknown>;
      assert(res.status === 200, `getUser invoke: ${res.status}`);
      const user = body.user as Record<string, unknown> | null;
      assert(user !== null, `getUser returns non-null`);
      assert(user?.id === testUserId, `getUser returns correct user id`);
      assert(user?.role === "authenticated", `getUser returns authenticated role`);
    }

    // --- Step 11: Invoke getUser without auth header ---
    console.log("\nStep 11: Invoke getUser without auth header");
    {
      const res = await fetch(`${BASE_URL}/functions/v1/getuser-test`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      const body = await res.json() as Record<string, unknown>;
      assert(res.status === 200, `getUser invoke (no auth): ${res.status}`);
      assert(body.user === null, `getUser returns null without auth`);
    }

    // --- Step 12: Invoke getUser with invalid token ---
    console.log("\nStep 12: Invoke getUser with invalid token");
    {
      const res = await fetch(`${BASE_URL}/functions/v1/getuser-test`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: "Bearer invalid.jwt.token",
        },
      });
      const body = await res.json() as Record<string, unknown>;
      assert(res.status === 200, `getUser invoke (invalid): ${res.status}`);
      assert(body.user === null, `getUser returns null with invalid token`);
    }

    // Delete getUser test function
    {
      await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions/getuser-test`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
    }

    // --- Step 13: Delete function ---
    console.log("\nStep 13: Delete function");
    {
      const res = await fetch(
        `${BASE_URL}/admin/v1/projects/${projectId}/functions/test-func`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${serviceKey}` },
        },
      );
      assert(res.status === 200, `Delete function: ${res.status}`);
    }

    // Verify 404 on invoke after delete
    {
      const res = await fetch(`${BASE_URL}/functions/v1/test-func`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      assert(res.status === 404, `Invoke after delete returns 404: ${res.status}`);
    }

    // --- Step 14: Delete secret ---
    console.log("\nStep 14: Delete secret");
    {
      const res = await fetch(
        `${BASE_URL}/admin/v1/projects/${projectId}/secrets/TEST_SECRET`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${serviceKey}` },
        },
      );
      assert(res.status === 200, `Delete secret: ${res.status}`);
    }
  } finally {
    // --- Step 15: Cleanup ---
    console.log("\nStep 15: Cleanup");

    // Delete project
    if (projectId) {
      const deleteRes = await fetch(`${BASE_URL}/v1/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      assert(deleteRes.ok, `Project deleted (${projectId})`);
    }

    // Debit remaining allowance
    const balRes = await fetch(`${BASE_URL}/v1/billing/accounts/${wallet}`);
    const balBody = await balRes.json() as Record<string, unknown>;
    const remaining = (balBody.available_usd_micros as number) || 0;
    if (remaining > 0) {
      await fetch(`${BASE_URL}/v1/billing/admin/accounts/${wallet}/debit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": ADMIN_KEY,
        },
        body: JSON.stringify({
          amount_usd_micros: remaining,
          reason: "functions-e2e cleanup",
        }),
      });
      console.log(`  Debited remaining ${remaining} micro-USD`);
    }
  }

  // --- Results ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Functions E2E: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
