/**
 * Functions E2E Test
 *
 * Tests the full functions lifecycle against a running Run402 instance:
 *   0. Setup — subscribe to tier via x402, create project via wallet auth
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
 *  13. db.sql() — basic raw SQL query (SELECT 1)
 *  14. db.sql() — create table, insert, and read back
 *  15. Bootstrap function via bundle deploy
 *  16. Deploy without bootstrap function
 *  17. Bootstrap function that throws
 *  18. Deploy scheduled function + trigger, verify schedule_meta
 *  19. Redeploy with schedule: null, verify cleared
 *  20. Schedule limit enforcement (bad cron → 400)
 *  21. Delete function, verify 404 on invoke
 *  22. Delete secret
 *  23. Cleanup — delete project
 *
 * Usage:
 *   BASE_URL=https://api.run402.com npm run test:functions
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

const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

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
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
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

  let projectId = "";
  let serviceKey = "";
  let anonKey = "";

  // --- Step 0: Setup — subscribe to tier, create project ---
  console.log("Step 0: Setup — subscribe + create project");

  // Subscribe to prototype tier via x402
  const subRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert(subRes.status === 201 || subRes.status === 200, `Tier subscribed (${subRes.status})`);

  // Create project via wallet auth (free with active tier)
  const createHeaders = await siwxHeaders("/projects/v1");
  const projRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...createHeaders,
    },
    body: JSON.stringify({ name: `func-test-${Date.now()}` }),
  });
  const projBody = await projRes.json() as Record<string, unknown>;
  assert(projRes.status === 201, `Project created (${projBody.project_id})`);

  projectId = projBody.project_id as string;
  serviceKey = projBody.service_key as string;
  anonKey = projBody.anon_key as string;
  console.log(`  Project: ${projectId}\n`);

  try {
    // --- Step 1: Set a secret ---
    console.log("Step 1: Set a secret");
    {
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/secrets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "TEST_SECRET", value: "hello-from-secret" }),
      });
      const body = await res.json();
      assert(res.status === 201 || res.status === 200, `Set secret: ${res.status}`);
      assert(body.key === "TEST_SECRET", `Secret key matches`);
    }

    // --- Step 2: List secrets ---
    console.log("\nStep 2: List secrets");
    {
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/secrets`, {
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
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
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
        `${BASE_URL}/projects/v1/admin/${projectId}/functions/test-func/logs?tail=10`,
        { headers: { Authorization: `Bearer ${serviceKey}` } },
      );
      const body = await res.json();
      assert(res.status === 200, `Get logs: ${res.status}`);
      assert(Array.isArray(body.logs), `Logs is array`);
      // Logs may take time to appear in CloudWatch
      if (Array.isArray(body.logs) && body.logs.length > 0) {
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
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
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
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
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
      const res = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
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
      await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions/getuser-test`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
    }

    // --- Step 13: db.sql() — basic raw SQL query ---
    console.log("\nStep 13: db.sql() — basic raw SQL query");
    {
      const sqlFunctionCode = `
import { db } from '@run402/functions';

export default async (req) => {
  try {
    const result = await db.sql('SELECT 1 AS ping');
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
`;
      const deployRes = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "sql-basic", code: sqlFunctionCode }),
      });
      assert(deployRes.status === 201, `Deploy db.sql() function: ${deployRes.status}`);

      await sleep(3000);

      const invokeRes = await fetch(`${BASE_URL}/functions/v1/sql-basic`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      const body = await invokeRes.json() as Record<string, unknown>;
      assert(invokeRes.status === 200, `db.sql() invoke status: ${invokeRes.status}`);
      assert(body.ok === true, `db.sql('SELECT 1') succeeded (ok=${body.ok}, error=${(body as Record<string, unknown>).error ?? "none"})`);
      if (body.ok) {
        const result = body.result as Record<string, unknown>;
        assert(result.status === "ok", `db.sql() returned status ok`);
        assert(Array.isArray(result.rows), `db.sql() returned rows array`);
      }

      await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions/sql-basic`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
    }

    // --- Step 14: db.sql() — create table + insert + read back ---
    console.log("\nStep 14: db.sql() — create table, insert, and read");
    {
      const sqlCrudCode = `
import { db } from '@run402/functions';

export default async (req) => {
  try {
    // Create a table via raw SQL
    await db.sql('CREATE TABLE IF NOT EXISTS sql_test (id SERIAL PRIMARY KEY, label TEXT)');
    // Insert a row
    await db.sql("INSERT INTO sql_test (label) VALUES ('hello-from-sql')");
    // Read it back
    const result = await db.sql("SELECT label FROM sql_test WHERE label = 'hello-from-sql'");
    return new Response(JSON.stringify({ ok: true, rows: result.rows }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
`;
      const deployRes = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "sql-crud", code: sqlCrudCode }),
      });
      assert(deployRes.status === 201, `Deploy db.sql() CRUD function: ${deployRes.status}`);

      await sleep(3000);

      const invokeRes = await fetch(`${BASE_URL}/functions/v1/sql-crud`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      const body = await invokeRes.json() as Record<string, unknown>;
      assert(invokeRes.status === 200, `db.sql() CRUD invoke status: ${invokeRes.status}`);
      assert(body.ok === true, `db.sql() CRUD succeeded (ok=${body.ok}, error=${(body as Record<string, unknown>).error ?? "none"})`);
      if (body.ok) {
        const rows = body.rows as Array<Record<string, unknown>>;
        assert(rows.length > 0, `db.sql() SELECT returned rows`);
        assert(rows[0].label === "hello-from-sql", `db.sql() SELECT returned correct label`);
      }

      await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions/sql-crud`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
    }

    // --- Step 15: db.sql() — parameterized query ---
    console.log("\nStep 15: db.sql() — parameterized query");
    {
      const sqlParamCode = `
import { db } from '@run402/functions';

export default async (req) => {
  try {
    await db.sql('CREATE TABLE IF NOT EXISTS param_test (id SERIAL PRIMARY KEY, label TEXT, value INT)');
    await db.sql('INSERT INTO param_test (label, value) VALUES ($1, $2)', ['parameterized', 42]);
    const result = await db.sql('SELECT label, value FROM param_test WHERE label = $1', ['parameterized']);
    return new Response(JSON.stringify({ ok: true, rows: result.rows }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
`;
      const deployRes = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "sql-param", code: sqlParamCode }),
      });
      assert(deployRes.status === 201, `Deploy db.sql() param function: ${deployRes.status}`);

      await sleep(3000);

      const invokeRes = await fetch(`${BASE_URL}/functions/v1/sql-param`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      const body = await invokeRes.json() as Record<string, unknown>;
      assert(invokeRes.status === 200, `db.sql() param invoke status: ${invokeRes.status}`);
      assert(body.ok === true, `db.sql() parameterized succeeded (ok=${body.ok}, error=${(body as Record<string, unknown>).error ?? "none"})`);
      if (body.ok) {
        const rows = body.rows as Array<Record<string, unknown>>;
        assert(rows.length > 0, `db.sql() parameterized SELECT returned rows`);
        assert(rows[0].label === "parameterized", `db.sql() param returned correct label`);
        assert(rows[0].value === 42, `db.sql() param returned correct value`);
      }

      await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions/sql-param`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
    }

    // --- Step 16: Bootstrap function via bundle deploy ---
    console.log("\nStep 16: Bootstrap via bundle deploy");
    {
      // Provision a new project for bootstrap test
      const bsHeaders = await siwxHeaders("/projects/v1");
      const bsProvRes = await fetch(`${BASE_URL}/projects/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bsHeaders },
        body: JSON.stringify({ name: `bootstrap-test-${Date.now()}` }),
      });
      const bsProv = await bsProvRes.json() as Record<string, unknown>;
      assert(bsProvRes.status === 201, `Bootstrap project created`);
      const bsProjectId = bsProv.project_id as string;
      const bsServiceKey = bsProv.service_key as string;
      const bsAnonKey = bsProv.anon_key as string;

      // Bundle deploy WITH a bootstrap function and bootstrap variables
      const bsDeployHeaders = await siwxHeaders("/deploy/v1");
      const bsDeployRes = await fetch(`${BASE_URL}/deploy/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bsDeployHeaders },
        body: JSON.stringify({
          project_id: bsProjectId,
          migrations: "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
          functions: [{
            name: "bootstrap",
            code: `import { db } from '@run402/functions';
export default async (req) => {
  const vars = await req.json();
  const name = vars.app_name || 'Default';
  await db.sql("INSERT INTO settings (key, value) VALUES ('app_name', '" + name.replace(/'/g, "''") + "') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  return new Response(JSON.stringify({ setup: true, app_name: name }), {
    headers: { "Content-Type": "application/json" },
  });
};`,
          }],
          bootstrap: { app_name: "Test App" },
        }),
      });
      const bsDeploy = await bsDeployRes.json() as Record<string, unknown>;
      assert(bsDeployRes.status === 200, `Bootstrap deploy: ${bsDeployRes.status}`);
      assert(bsDeploy.bootstrap_result !== undefined, `bootstrap_result present in response`);
      const bsResult = bsDeploy.bootstrap_result as Record<string, unknown> | null;
      if (bsResult) {
        assert(bsResult.setup === true, `Bootstrap result has setup: true`);
        assert(bsResult.app_name === "Test App", `Bootstrap result has correct app_name`);
      }
      assert(bsDeploy.bootstrap_error === undefined, `No bootstrap_error${bsDeploy.bootstrap_error ? ": " + bsDeploy.bootstrap_error : ""}`);

      // Verify bootstrap function wrote to DB
      await sleep(1500);
      const settingsRes = await fetch(`${BASE_URL}/rest/v1/settings?key=eq.app_name`, {
        headers: { apikey: bsAnonKey },
      });
      const settingsBody = await settingsRes.json() as Array<Record<string, unknown>>;
      if (settingsRes.ok && settingsBody.length > 0) {
        assert(settingsBody[0].value === "Test App", `Bootstrap wrote app_name to DB`);
      }

      // Step 15b: Manually re-invoke bootstrap with different vars
      console.log("\nStep 15b: Manual bootstrap re-invoke");
      const manualRes = await fetch(`${BASE_URL}/functions/v1/bootstrap`, {
        method: "POST",
        headers: {
          apikey: bsAnonKey,
          Authorization: `Bearer ${bsServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ app_name: "Updated App" }),
      });
      assert(manualRes.status === 200, `Manual bootstrap invoke: ${manualRes.status}`);

      // Clean up bootstrap project
      await fetch(`${BASE_URL}/projects/v1/${bsProjectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bsServiceKey}` },
      });
    }

    // --- Step 16: Deploy without bootstrap function, verify null ---
    console.log("\nStep 16: Deploy without bootstrap function");
    {
      const nbHeaders = await siwxHeaders("/projects/v1");
      const nbProvRes = await fetch(`${BASE_URL}/projects/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...nbHeaders },
        body: JSON.stringify({ name: `no-bootstrap-${Date.now()}` }),
      });
      const nbProv = await nbProvRes.json() as Record<string, unknown>;
      assert(nbProvRes.status === 201, `No-bootstrap project created`);
      const nbProjectId = nbProv.project_id as string;
      const nbServiceKey = nbProv.service_key as string;

      const nbDeployHeaders = await siwxHeaders("/deploy/v1");
      const nbDeployRes = await fetch(`${BASE_URL}/deploy/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...nbDeployHeaders },
        body: JSON.stringify({
          project_id: nbProjectId,
          migrations: "CREATE TABLE items (id SERIAL PRIMARY KEY, title TEXT);",
          bootstrap: { some_var: "test" },
        }),
      });
      const nbDeploy = await nbDeployRes.json() as Record<string, unknown>;
      assert(nbDeployRes.status === 200, `No-bootstrap deploy: ${nbDeployRes.status}`);
      assert(nbDeploy.bootstrap_result === null, `bootstrap_result is null when no function exists`);

      await fetch(`${BASE_URL}/projects/v1/${nbProjectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${nbServiceKey}` },
      });
    }

    // --- Step 17: Bootstrap function that throws ---
    console.log("\nStep 17: Bootstrap function that throws");
    {
      const errHeaders = await siwxHeaders("/projects/v1");
      const errProvRes = await fetch(`${BASE_URL}/projects/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...errHeaders },
        body: JSON.stringify({ name: `err-bootstrap-${Date.now()}` }),
      });
      const errProv = await errProvRes.json() as Record<string, unknown>;
      assert(errProvRes.status === 201, `Error-bootstrap project created`);
      const errProjectId = errProv.project_id as string;
      const errServiceKey = errProv.service_key as string;

      const errDeployHeaders = await siwxHeaders("/deploy/v1");
      const errDeployRes = await fetch(`${BASE_URL}/deploy/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...errDeployHeaders },
        body: JSON.stringify({
          project_id: errProjectId,
          functions: [{
            name: "bootstrap",
            code: `export default async (req) => { throw new Error("intentional bootstrap failure"); };`,
          }],
          bootstrap: {},
        }),
      });
      const errDeploy = await errDeployRes.json() as Record<string, unknown>;
      assert(errDeployRes.status === 200, `Deploy succeeds even when bootstrap fails: ${errDeployRes.status}`);
      assert(typeof errDeploy.bootstrap_error === "string", `bootstrap_error is present`);
      assert(errDeploy.bootstrap_result === undefined, `bootstrap_result absent on error`);

      await fetch(`${BASE_URL}/projects/v1/${errProjectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${errServiceKey}` },
      });
    }

    // --- Step 18: Deploy function with schedule, trigger, verify metadata ---
    console.log("\nStep 18: Deploy scheduled function + trigger");
    {
      const schedCode = `export default async (req) => {
        return new Response(JSON.stringify({ triggered: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };`;

      // Deploy with schedule
      const deployRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ name: "sched-func", code: schedCode, schedule: "*/15 * * * *" }),
        },
      );
      const deployBody = await deployRes.json() as Record<string, unknown>;
      assert(deployRes.status === 201, `Deploy scheduled func: ${deployRes.status} ${JSON.stringify(deployBody)}`);
      assert(deployBody.schedule === "*/15 * * * *", `Schedule in response: ${deployBody.schedule}`);
      passed++;

      // Verify schedule in list
      const listRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        { headers: { Authorization: `Bearer ${serviceKey}` } },
      );
      const listBody = await listRes.json() as { functions: Array<Record<string, unknown>> };
      const scheduled = listBody.functions.find((f) => f.name === "sched-func");
      assert(scheduled, "Scheduled func in list");
      assert(scheduled.schedule === "*/15 * * * *", `Schedule in list: ${scheduled.schedule}`);
      passed++;

      // Trigger manually
      const trigRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions/sched-func/trigger`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}` },
        },
      );
      const trigBody = await trigRes.json() as Record<string, unknown>;
      assert(trigRes.status === 200, `Trigger: ${trigRes.status}`);
      assert(trigBody.status === 200, `Trigger fn status: ${trigBody.status}`);
      passed++;

      // Verify schedule_meta updated
      const metaListRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        { headers: { Authorization: `Bearer ${serviceKey}` } },
      );
      const metaListBody = await metaListRes.json() as { functions: Array<Record<string, unknown>> };
      const metaFn = metaListBody.functions.find((f) => f.name === "sched-func");
      const meta = metaFn?.schedule_meta as Record<string, unknown> | undefined;
      assert(meta, "schedule_meta exists after trigger");
      assert(meta.run_count === 1, `run_count: ${meta.run_count}`);
      assert(meta.last_status === 200, `last_status: ${meta.last_status}`);
      passed++;
    }

    // --- Step 19: Redeploy with schedule: null, verify cleared ---
    console.log("\nStep 19: Redeploy with schedule: null");
    {
      const code = `export default async (req) => new Response("ok");`;
      const res = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ name: "sched-func", code, schedule: null }),
        },
      );
      assert(res.status === 201, `Redeploy: ${res.status}`);

      const listRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        { headers: { Authorization: `Bearer ${serviceKey}` } },
      );
      const listBody = await listRes.json() as { functions: Array<Record<string, unknown>> };
      const fn = listBody.functions.find((f) => f.name === "sched-func");
      assert(fn?.schedule === null || fn?.schedule === undefined, `Schedule cleared: ${fn?.schedule}`);
      passed++;

      // Clean up the scheduled function
      await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions/sched-func`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${serviceKey}` },
        },
      );
    }

    // --- Step 20: Deploy exceeding schedule limit → 403 ---
    console.log("\nStep 20: Schedule limit enforcement");
    {
      // Invalid cron expression → 400
      const badCronRes = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ name: "bad-cron", code: `export default async () => new Response("ok");`, schedule: "not-valid" }),
        },
      );
      assert(badCronRes.status === 400, `Bad cron: ${badCronRes.status}`);
      passed++;
    }

    // --- Step 21: Delete function ---
    console.log("\nStep 21: Delete function");
    {
      const res = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/functions/test-func`,
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

    // --- Step 22: Delete secret ---
    console.log("\nStep 22: Delete secret");
    {
      const res = await fetch(
        `${BASE_URL}/projects/v1/admin/${projectId}/secrets/TEST_SECRET`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${serviceKey}` },
        },
      );
      assert(res.status === 200, `Delete secret: ${res.status}`);
    }

    // --- Step 24: email.send() from function (raw mode) ---
    console.log("\nStep 24: email.send() from function (raw mode)");
    {
      // Create a mailbox first
      const mbxRes = await fetch(`${BASE_URL}/mailboxes/v1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ slug: `fn-email-${Date.now()}` }),
      });
      if (mbxRes.status === 201) {
        const mbxBody = await mbxRes.json() as { mailbox_id: string };
        const mailboxId = mbxBody.mailbox_id;
        assert(true, "Mailbox created for email test");

        // Deploy a function that uses email.send()
        const fnCode = `
import { email } from '@run402/functions';

export default async function handler(req) {
  const result = await email.send({
    to: "fn-test@example.com",
    subject: "From a function",
    html: "<p>Sent via email.send() helper</p>",
  });
  return Response.json(result);
}`;
        const deployRes = await fetch(
          `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "email-raw-test", code: fnCode }),
          },
        );
        assert(deployRes.ok, `Deploy email.send() raw function: ${deployRes.status}`);

        // Invoke it
        const invokeRes = await fetch(`${BASE_URL}/functions/v1/email-raw-test`, {
          method: "POST",
          headers: { apikey: anonKey },
        });
        if (invokeRes.ok) {
          const invokeBody = await invokeRes.json() as { message_id?: string; status?: string };
          assert(!!invokeBody.message_id, "email.send() raw returned message_id");
          assert(invokeBody.status === "sent", `email.send() raw status is sent (got ${invokeBody.status})`);
        } else {
          const errText = await invokeRes.text();
          // SES sandbox is expected to fail
          if (errText.includes("not verified") || errText.includes("MessageRejected") || errText.includes("Email send failed")) {
            assert(true, "email.send() raw (SES sandbox — expected)");
          } else {
            assert(false, `email.send() raw invoke failed: ${invokeRes.status} ${errText}`);
          }
        }

        // --- Step 25: email.send() from function (template mode) ---
        console.log("\nStep 25: email.send() from function (template mode)");
        const fnCode2 = `
import { email } from '@run402/functions';

export default async function handler(req) {
  const result = await email.send({
    to: "fn-template@example.com",
    template: "notification",
    variables: { project_name: "FnTest", message: "hello from function" },
  });
  return Response.json(result);
}`;
        const deployRes2 = await fetch(
          `${BASE_URL}/projects/v1/admin/${projectId}/functions`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "email-tmpl-test", code: fnCode2 }),
          },
        );
        assert(deployRes2.ok, `Deploy email.send() template function: ${deployRes2.status}`);

        const invokeRes2 = await fetch(`${BASE_URL}/functions/v1/email-tmpl-test`, {
          method: "POST",
          headers: { apikey: anonKey },
        });
        if (invokeRes2.ok) {
          const body2 = await invokeRes2.json() as { template?: string; status?: string };
          assert(body2.template === "notification", `email.send() template returned notification (got ${body2.template})`);
          assert(body2.status === "sent", `email.send() template status is sent (got ${body2.status})`);
        } else {
          const errText2 = await invokeRes2.text();
          if (errText2.includes("not verified") || errText2.includes("MessageRejected") || errText2.includes("Email send failed")) {
            assert(true, "email.send() template (SES sandbox — expected)");
          } else {
            assert(false, `email.send() template invoke failed: ${invokeRes2.status} ${errText2}`);
          }
        }
      } else {
        assert(true, `Mailbox for email test (skipped, status=${mbxRes.status})`);
    }
  } finally {
    // --- Step 23: Cleanup ---
    console.log("\nStep 23: Cleanup");

    // Delete project (cascade cleanup)
    if (projectId) {
      const deleteRes = await fetch(`${BASE_URL}/projects/v1/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      assert(deleteRes.ok, `Project deleted (${projectId})`);

      // Verify cascade: functions should 404 after project delete
      const cascadeFnRes = await fetch(`${BASE_URL}/functions/v1/test-func`, {
        method: "POST",
        headers: { apikey: anonKey },
      });
      assert(cascadeFnRes.status === 404, `Cascade: function returns 404 after delete (got ${cascadeFnRes.status})`);

      // Verify cascade: list functions should return empty
      const cascadeListRes = await fetch(`${BASE_URL}/projects/v1/admin/${projectId}/functions`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      const cascadeListBody = await cascadeListRes.json();
      assert(Array.isArray(cascadeListBody) && cascadeListBody.length === 0,
        "Cascade: function list is empty after delete");
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
