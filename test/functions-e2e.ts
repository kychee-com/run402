/**
 * Functions E2E Test
 *
 * Tests the full functions lifecycle against a running Run402 instance:
 *   1. Set a secret (TEST_SECRET)
 *   2. Deploy a function that reads the secret + queries DB
 *   3. Invoke the function via HTTP, verify response
 *   4. Get function logs, verify console.log output
 *   5. Redeploy function (overwrite), verify new code runs
 *   6. List functions
 *   7. Delete function, verify 404 on invoke
 *
 * Prerequisites:
 *   - A running Run402 instance with Lambda configured
 *   - An existing project (provide PROJECT_ID, SERVICE_KEY, ANON_KEY)
 *
 * Usage:
 *   PROJECT_ID=prj_xxx SERVICE_KEY=xxx ANON_KEY=xxx BASE_URL=https://api.run402.com tsx test/functions-e2e.ts
 */

import { config } from "dotenv";
config();

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const PROJECT_ID = process.env.PROJECT_ID;
const SERVICE_KEY = process.env.SERVICE_KEY;
const ANON_KEY = process.env.ANON_KEY;

if (!PROJECT_ID || !SERVICE_KEY || !ANON_KEY) {
  console.error("Missing PROJECT_ID, SERVICE_KEY, or ANON_KEY in env");
  process.exit(1);
}

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
  console.log(`Project: ${PROJECT_ID}\n`);

  // --- Step 1: Set a secret ---
  console.log("Step 1: Set a secret");
  {
    const res = await fetch(`${BASE_URL}/admin/v1/projects/${PROJECT_ID}/secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
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
    const res = await fetch(`${BASE_URL}/admin/v1/projects/${PROJECT_ID}/secrets`, {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
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
    const res = await fetch(`${BASE_URL}/admin/v1/projects/${PROJECT_ID}/functions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
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
        apikey: ANON_KEY,
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
      `${BASE_URL}/admin/v1/projects/${PROJECT_ID}/functions/test-func/logs?tail=10`,
      { headers: { Authorization: `Bearer ${SERVICE_KEY}` } },
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
    const res = await fetch(`${BASE_URL}/admin/v1/projects/${PROJECT_ID}/functions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "test-func", code: newCode }),
    });
    assert(res.status === 201, `Redeploy: ${res.status}`);

    await sleep(3000);

    // Invoke and verify new code
    const invokeRes = await fetch(`${BASE_URL}/functions/v1/test-func`, {
      method: "POST",
      headers: { apikey: ANON_KEY },
    });
    const body = await invokeRes.json();
    assert(body.version === 2, `New code running after redeploy`);
  }

  // --- Step 7: List functions ---
  console.log("\nStep 7: List functions");
  {
    const res = await fetch(`${BASE_URL}/admin/v1/projects/${PROJECT_ID}/functions`, {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const body = await res.json();
    assert(res.status === 200, `List functions: ${res.status}`);
    assert(body.functions.length >= 1, `At least 1 function listed`);
    assert(
      body.functions.some((f: { name: string }) => f.name === "test-func"),
      `test-func in list`,
    );
  }

  // --- Step 8: Delete function ---
  console.log("\nStep 8: Delete function");
  {
    const res = await fetch(
      `${BASE_URL}/admin/v1/projects/${PROJECT_ID}/functions/test-func`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      },
    );
    assert(res.status === 200, `Delete function: ${res.status}`);
  }

  // Verify 404 on invoke after delete
  {
    const res = await fetch(`${BASE_URL}/functions/v1/test-func`, {
      method: "POST",
      headers: { apikey: ANON_KEY },
    });
    assert(res.status === 404, `Invoke after delete returns 404: ${res.status}`);
  }

  // --- Step 9: Delete secret ---
  console.log("\nStep 9: Delete secret");
  {
    const res = await fetch(
      `${BASE_URL}/admin/v1/projects/${PROJECT_ID}/secrets/TEST_SECRET`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      },
    );
    assert(res.status === 200, `Delete secret: ${res.status}`);
  }

  // --- Results ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Functions E2E: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
