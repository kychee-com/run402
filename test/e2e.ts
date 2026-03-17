/**
 * AgentDB E2E Test — Workout Tracker Flow (Pay-Per-Tier Model)
 *
 * Tests the full lifecycle against a running AgentDB instance:
 *   1.  Tier info — list tier pricing
 *   2.  Subscribe tier — pay via x402 to subscribe to prototype tier
 *   3.  Tier status — verify wallet auth + tier info
 *   4.  Ping — verify wallet auth works
 *   5.  Create project — with wallet auth (free with tier)
 *   6.  Apply migration — create tables
 *   7.  Apply RLS — user_owns_rows template
 *   8.  Sign up user
 *   9.  Log in — get access_token + refresh_token
 *   10. Insert data — exercises, workouts, sets via PostgREST
 *   11. Query with joins — PostgREST embedded resources
 *   12. Upload file — workout log to storage
 *   13. Check usage — API calls + storage
 *   14. Schema introspection — verify tables/columns
 *   15. Refresh token — rotate tokens
 *   16. SQL blocklist — verify blocked patterns
 *   17. Access levels — anon read-only, service_key admin, access_token authenticated
 *   18. SQL query rows — verify SELECT returns data via /sql endpoint
 *   19. SERIAL table — test sequence permissions
 *   20. apikey-only REST — verify apikey auto-forwards as Authorization
 *   21. RLS templates — public_read, public_read_write
 *   22. GRANT blocked hint — actionable error messages
 *   23. Bundle deploy — one-call full-stack app (wallet auth, migrations, RLS, site)
 *   24. Publish — publish workout tracker as forkable app version
 *   25. Fork — fork the published app with wallet auth
 *   26. OAuth providers + start — Google OAuth API contract + validation
 *   27. Delete project — cleanup
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 npm run test:e2e
 *   BASE_URL=https://api.run402.com npm run test:e2e
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

// --- Config ---

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

// --- Setup x402 client ---

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

// --- SIWX auth helpers ---

/**
 * Generate SIWX (CAIP-122) auth headers for the test wallet.
 * Creates a signed SIWX message and encodes it as the SIGN-IN-WITH-X header.
 *
 * @param path - endpoint path (e.g. "/ping/v1") — used to construct the resource URI
 */
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

// --- Helpers ---

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

// --- Main test flow ---

async function main() {
  console.log("\n=== AgentDB E2E Test — Workout Tracker (Pay-Per-Tier) ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Buyer:   ${account.address}\n`);

  // Step 1: Tier info
  console.log("1) Tier info...");
  const tierInfoRes = await fetch(`${BASE_URL}/tiers/v1`);
  const tierInfoBody = await tierInfoRes.json();
  assert(tierInfoRes.ok, "Tier info returns 200");
  assert(tierInfoBody.tiers?.prototype != null, "Tier info includes prototype tier");
  assert(tierInfoBody.tiers?.hobby != null, "Tier info includes hobby tier");
  assert(tierInfoBody.tiers?.team != null, "Tier info includes team tier");
  assert(tierInfoBody.auth != null, "Tier info includes auth method");

  // Step 2: Subscribe to prototype tier via x402
  console.log("\n2) Subscribe to prototype tier via x402...");
  const subscribeRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const subscribeBody = await subscribeRes.json();
  assert(subscribeRes.status === 201 || subscribeRes.status === 200, `Subscribe returns 200 or 201 (got ${subscribeRes.status})`);
  assert(typeof subscribeBody.wallet === "string", "Subscribe returns wallet");
  assert(subscribeBody.tier === "prototype", "Subscribe returns tier=prototype");
  assert(typeof subscribeBody.lease_expires_at === "string", "Subscribe returns lease_expires_at");

  // Step 3: Tier status (wallet auth)
  console.log("\n3) Tier status...");
  const statusHeaders = await siwxHeaders("/tiers/v1/status");
  const statusRes = await fetch(`${BASE_URL}/tiers/v1/status`, {
    headers: statusHeaders,
  });
  const statusBody = await statusRes.json();
  assert(statusRes.ok, "Tier status returns 200");
  assert(statusBody.tier === "prototype", "Tier status shows prototype");
  assert(statusBody.active === true, "Tier is active");

  // Step 4: Ping (wallet auth)
  console.log("\n4) Ping...");
  const pingHeaders = await siwxHeaders("/ping/v1");
  const pingRes = await fetch(`${BASE_URL}/ping/v1`, {
    headers: pingHeaders,
  });
  const pingBody = await pingRes.json();
  assert(pingRes.ok, "Ping returns 200");
  assert(pingBody.status === "ok", "Ping status is ok");
  assert(typeof pingBody.wallet === "string", "Ping returns wallet");

  // Step 5: Create project with wallet auth
  console.log("\n5) Create project with wallet auth...");
  const createHeaders = await siwxHeaders("/projects/v1");
  const createRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...createHeaders,
    },
    body: JSON.stringify({ name: "e2e-workout-tracker" }),
  });
  const project = await createRes.json();
  assert(createRes.status === 201, `Project creation returns 201 (got ${createRes.status})`);
  assert(typeof project.project_id === "string", "Returns project_id");
  assert(typeof project.anon_key === "string", "Returns anon_key");
  assert(typeof project.service_key === "string", "Returns service_key");
  assert(typeof project.schema_slot === "string", "Returns schema_slot");

  const { project_id, anon_key, service_key } = project;

  // Step 6: Apply migration
  console.log("\n6) Apply migration...");
  const migrationSQL = `
    CREATE TABLE profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES profiles(id),
      name TEXT NOT NULL,
      muscle_group TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE workouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES profiles(id),
      performed_at DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES profiles(id),
      workout_id UUID NOT NULL REFERENCES workouts(id),
      exercise_id UUID NOT NULL REFERENCES exercises(id),
      reps INTEGER NOT NULL,
      weight_kg NUMERIC(5,1),
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  const migrationRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: migrationSQL,
  });
  const migrationBody = await migrationRes.json();
  assert(migrationRes.ok, "Migration succeeds");
  assert(migrationBody.schema != null, "Returns schema slot");

  await sleep(500); // Wait for PostgREST reload

  // Step 7: Apply RLS
  console.log("\n7) Apply RLS...");
  const rlsRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({
      template: "user_owns_rows",
      tables: [
        { table: "profiles", owner_column: "id" },
        { table: "exercises", owner_column: "user_id" },
        { table: "workouts", owner_column: "user_id" },
        { table: "sets", owner_column: "user_id" },
      ],
    }),
  });
  assert(rlsRes.ok, "RLS applied successfully");

  // Step 8: Sign up
  console.log("\n8) Sign up...");
  const signupRes = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: "athlete@example.com", password: "strong-password-123" }),
  });
  const signupBody = await signupRes.json();
  assert(signupRes.ok, "Signup succeeds");
  assert(typeof signupBody.id === "string", "Returns user id");
  const userId = signupBody.id;

  // Step 9: Log in
  console.log("\n9) Log in...");
  const loginRes = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: "athlete@example.com", password: "strong-password-123" }),
  });
  const loginBody = await loginRes.json();
  assert(loginRes.ok, "Login succeeds");
  assert(typeof loginBody.access_token === "string", "Returns access_token");
  assert(typeof loginBody.refresh_token === "string", "Returns refresh_token");
  const accessToken = loginBody.access_token;
  const refreshToken = loginBody.refresh_token;

  const restHeaders = {
    "Content-Type": "application/json",
    apikey: anon_key,
    Authorization: `Bearer ${accessToken}`,
    Prefer: "return=representation",
  };

  // Step 10: Insert data
  console.log("\n10) Insert data via PostgREST...");

  const profileRes = await fetch(`${BASE_URL}/rest/v1/profiles`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ id: userId, email: "athlete@example.com", display_name: "Test Athlete" }),
  });
  assert(profileRes.ok, "Profile created");

  const exercisesRes = await fetch(`${BASE_URL}/rest/v1/exercises`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify([
      { user_id: userId, name: "Bench Press", muscle_group: "chest" },
      { user_id: userId, name: "Squat", muscle_group: "legs" },
      { user_id: userId, name: "Deadlift", muscle_group: "back" },
    ]),
  });
  const exercisesBody = await exercisesRes.json();
  assert(exercisesRes.ok, "Exercises created");
  assert(Array.isArray(exercisesBody) && exercisesBody.length === 3, "3 exercises returned");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test code
  const exerciseIds = exercisesBody.map((e: any) => e.id);

  const workoutRes = await fetch(`${BASE_URL}/rest/v1/workouts`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ user_id: userId, performed_at: new Date().toISOString().slice(0, 10), notes: "E2E test" }),
  });
  const workoutBody = await workoutRes.json();
  assert(workoutRes.ok, "Workout created");
  const workoutId = workoutBody[0]?.id;

  const setsRes = await fetch(`${BASE_URL}/rest/v1/sets`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify([
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[0], reps: 10, weight_kg: 60 },
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[1], reps: 5, weight_kg: 100 },
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[2], reps: 5, weight_kg: 120 },
    ]),
  });
  const setsBody = await setsRes.json();
  assert(setsRes.ok, "Sets created");
  assert(Array.isArray(setsBody) && setsBody.length === 3, "3 sets returned");

  // Step 11: Query with joins
  console.log("\n11) Query with joins...");
  const queryRes = await fetch(`${BASE_URL}/rest/v1/workouts?select=*,sets(*,exercises(*))`, {
    headers: { apikey: anon_key, Authorization: `Bearer ${accessToken}` },
  });
  const queryBody = await queryRes.json();
  assert(queryRes.ok, "Join query succeeds");
  assert(Array.isArray(queryBody) && queryBody.length === 1, "1 workout returned");
  assert(queryBody[0].sets?.length === 3, "3 sets embedded in workout");
  assert(queryBody[0].sets[0].exercises?.name != null, "Exercise embedded in set");

  // Step 12: Upload file
  console.log("\n12) Upload file...");
  const uploadRes = await fetch(`${BASE_URL}/storage/v1/object/logs/workout-log.txt`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", apikey: anon_key },
    body: "E2E test workout log content",
  });
  const uploadBody = await uploadRes.json();
  assert(uploadRes.ok, "File uploaded");
  assert(uploadBody.key === "logs/workout-log.txt", "Correct file key");
  assert(uploadBody.size > 0, "File has size > 0");

  // Step 12b: Upload binary file (regression: body parser must not corrupt binary)
  console.log("\n12b) Upload binary file...");
  const binaryData = new Uint8Array(256);
  for (let i = 0; i < 256; i++) binaryData[i] = i; // every byte value 0x00–0xFF
  const binaryUploadRes = await fetch(`${BASE_URL}/storage/v1/object/logs/test-image.bin`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", apikey: anon_key },
    body: binaryData,
  });
  const binaryUploadBody = await binaryUploadRes.json();
  assert(binaryUploadRes.ok, "Binary file uploaded");
  assert(binaryUploadBody.size === 256, `Binary file size is 256 (got ${binaryUploadBody.size})`);

  // Download and verify byte-for-byte integrity
  const binaryDownloadRes = await fetch(`${BASE_URL}/storage/v1/object/logs/test-image.bin`, {
    headers: { apikey: anon_key },
  });
  assert(binaryDownloadRes.ok, "Binary file downloaded");
  const downloaded = new Uint8Array(await binaryDownloadRes.arrayBuffer());
  assert(downloaded.length === 256, `Downloaded size is 256 (got ${downloaded.length})`);
  let bytesMatch = true;
  for (let i = 0; i < 256; i++) {
    if (downloaded[i] !== i) { bytesMatch = false; break; }
  }
  assert(bytesMatch, "Binary roundtrip: all 256 byte values preserved");

  // Step 13: Check usage
  console.log("\n13) Check usage...");
  const usageRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/usage`, {
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const usageBody = await usageRes.json();
  assert(usageRes.ok, "Usage report succeeds");
  assert(usageBody.api_calls > 0, "API calls tracked");
  assert(usageBody.api_calls_limit > 0, "API call limit set");
  assert(typeof usageBody.lease_expires_at === "string", "Lease expiry in usage report");

  // Step 14: Schema introspection
  console.log("\n14) Schema introspection...");
  const schemaRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/schema`, {
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const schemaBody = await schemaRes.json();
  assert(schemaRes.ok, "Schema introspection succeeds");
  assert(Array.isArray(schemaBody.tables), "Returns tables array");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test code
  const tableNames = schemaBody.tables.map((t: any) => t.name).sort();
  assert(tableNames.includes("profiles"), "Profiles table found");
  assert(tableNames.includes("exercises"), "Exercises table found");
  assert(tableNames.includes("workouts"), "Workouts table found");
  assert(tableNames.includes("sets"), "Sets table found");

  // Verify columns on profiles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test code
  const profilesTable = schemaBody.tables.find((t: any) => t.name === "profiles");
  assert(profilesTable?.columns?.length === 4, "Profiles has 4 columns");
  assert(profilesTable?.rls_enabled === true, "Profiles has RLS enabled");

  // Step 15: Refresh token
  console.log("\n15) Refresh token...");
  const refreshRes = await fetch(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const refreshBody = await refreshRes.json();
  assert(refreshRes.ok, "Refresh token succeeds");
  assert(typeof refreshBody.access_token === "string", "New access_token returned");
  assert(typeof refreshBody.refresh_token === "string", "New refresh_token returned");
  assert(refreshBody.refresh_token !== refreshToken, "Refresh token rotated");

  // Step 16: SQL blocklist
  console.log("\n16) SQL blocklist...");
  const blockedRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "CREATE EXTENSION pg_stat_statements;",
  });
  assert(blockedRes.status === 403, "Blocked SQL returns 403");

  // Step 17: Access level enforcement (anon = read-only)
  console.log("\n17) Access levels (anon read-only)...");

  // anon_key can SELECT
  const anonReadRes = await fetch(`${BASE_URL}/rest/v1/profiles?select=id`, {
    headers: { apikey: anon_key },
  });
  assert(anonReadRes.ok, "anon_key can SELECT (read-only access)");

  // anon_key cannot INSERT (no write permission on regular tables)
  const anonWriteRes = await fetch(`${BASE_URL}/rest/v1/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, name: "Anon Exercise", muscle_group: "none" }),
  });
  assert(!anonWriteRes.ok, `anon_key INSERT blocked (status ${anonWriteRes.status})`);

  // service_key can INSERT (full admin, bypasses RLS)
  const svcWriteRes = await fetch(`${BASE_URL}/rest/v1/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: service_key, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, name: "Service Exercise", muscle_group: "admin" }),
  });
  assert(svcWriteRes.ok, `service_key can INSERT (admin access)`);

  // access_token can INSERT (authenticated, subject to RLS)
  const authWriteRes = await fetch(`${BASE_URL}/rest/v1/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: accessToken, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, name: "Auth Exercise", muscle_group: "user" }),
  });
  assert(authWriteRes.ok, `access_token can INSERT (authenticated access)`);

  // Step 18: SQL query returns rows
  console.log("\n18) SQL query returns rows...");

  // DDL should return empty rows
  const ddlRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "CREATE TABLE IF NOT EXISTS profiles (id UUID PRIMARY KEY);",
  });
  const ddlBody = await ddlRes.json();
  assert(ddlRes.ok, "DDL via /sql succeeds");
  assert(Array.isArray(ddlBody.rows), "DDL response includes rows array");
  assert(ddlBody.rows.length === 0, "DDL returns empty rows");

  // SELECT should return actual data
  const selectRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "SELECT id, email FROM profiles ORDER BY created_at;",
  });
  const selectBody = await selectRes.json();
  assert(selectRes.ok, "SELECT via /sql succeeds");
  assert(Array.isArray(selectBody.rows), "SELECT response includes rows array");
  assert(selectBody.rows.length === 1, "SELECT returns 1 profile row");
  assert(selectBody.rows[0].email === "athlete@example.com", "SELECT returns correct email");
  assert(typeof selectBody.rowCount === "number", "Response includes rowCount");

  // COUNT query
  const countRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "SELECT count(*) AS total FROM exercises;",
  });
  const countBody = await countRes.json();
  assert(countRes.ok, "COUNT via /sql succeeds");
  assert(countBody.rows[0].total === "5", "COUNT returns 5 exercises");

  // Step 19: SERIAL/BIGSERIAL sequence permissions
  console.log("\n19) SERIAL table (sequence permissions)...");

  // Create a table using SERIAL (auto-incrementing integer)
  const serialSQL = `
    CREATE TABLE tasks (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES profiles(id),
      title TEXT NOT NULL,
      done BOOLEAN DEFAULT false
    );
  `;
  const serialMigRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: serialSQL,
  });
  assert(serialMigRes.ok, "SERIAL table migration succeeds");

  // Apply RLS to the new table
  const serialRlsRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({
      template: "user_owns_rows",
      tables: [{ table: "tasks", owner_column: "user_id" }],
    }),
  });
  assert(serialRlsRes.ok, "RLS applied to SERIAL table");

  await sleep(500); // Wait for PostgREST reload

  // Insert a row — should auto-generate id from sequence
  const taskInsertRes = await fetch(`${BASE_URL}/rest/v1/tasks`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ user_id: userId, title: "Test SERIAL insert" }),
  });
  const taskInsertBody = await taskInsertRes.json();
  assert(taskInsertRes.ok, `SERIAL insert succeeds (status ${taskInsertRes.status})`);
  assert(Array.isArray(taskInsertBody) && taskInsertBody[0]?.id === 1, "Auto-generated id = 1");

  // Insert another row — id should increment
  const taskInsert2Res = await fetch(`${BASE_URL}/rest/v1/tasks`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ user_id: userId, title: "Second task" }),
  });
  const taskInsert2Body = await taskInsert2Res.json();
  assert(taskInsert2Res.ok, "Second SERIAL insert succeeds");
  assert(Array.isArray(taskInsert2Body) && taskInsert2Body[0]?.id === 2, "Auto-generated id = 2");

  // Query to verify both rows
  const tasksQueryRes = await fetch(`${BASE_URL}/rest/v1/tasks?order=id`, {
    headers: { apikey: anon_key, Authorization: `Bearer ${accessToken}` },
  });
  const tasksQueryBody = await tasksQueryRes.json();
  assert(tasksQueryRes.ok, "SERIAL table query succeeds");
  assert(Array.isArray(tasksQueryBody) && tasksQueryBody.length === 2, "2 tasks returned");

  // Step 20: apikey-only REST access (no Authorization header needed)
  console.log("\n20) apikey-only REST access...");

  // 20a: GET with only apikey (anon_key) — should return 200, not permission error
  const anonOnlyRes = await fetch(`${BASE_URL}/rest/v1/profiles?select=id`, {
    headers: { apikey: anon_key },
  });
  assert(anonOnlyRes.ok, `GET with only apikey returns 200 (was ${anonOnlyRes.status})`);
  // anon can SELECT but RLS filters to auth.uid()=NULL → empty array
  const anonOnlyBody = await anonOnlyRes.json();
  assert(Array.isArray(anonOnlyBody), "anon-only GET returns array (empty due to RLS)");

  // 20b: GET with access_token as apikey (no Authorization header) — should authenticate
  const tokenOnlyRes = await fetch(`${BASE_URL}/rest/v1/profiles?select=id,email`, {
    headers: { apikey: accessToken },
  });
  assert(tokenOnlyRes.ok, `GET with access_token as apikey returns 200 (was ${tokenOnlyRes.status})`);
  const tokenOnlyBody = await tokenOnlyRes.json();
  assert(Array.isArray(tokenOnlyBody) && tokenOnlyBody.length === 1, "access_token apikey returns user's row");
  assert(tokenOnlyBody[0]?.email === "athlete@example.com", "Correct user returned via apikey-only");

  // 20c: POST with access_token as apikey (no Authorization header) — should allow INSERT
  const insertOnlyRes = await fetch(`${BASE_URL}/rest/v1/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: accessToken,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ user_id: userId, title: "apikey-only insert" }),
  });
  assert(insertOnlyRes.ok, `POST with access_token as apikey returns 200 (was ${insertOnlyRes.status})`);
  const insertOnlyBody = await insertOnlyRes.json();
  assert(Array.isArray(insertOnlyBody) && insertOnlyBody[0]?.title === "apikey-only insert", "INSERT via apikey-only works");

  // Step 21: RLS templates (public_read, public_read_write)
  console.log("\n21) RLS templates...");

  // Create tables for template testing
  const templateSQL = `
    CREATE TABLE announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE guestbook (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  const templateMigRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: templateSQL,
  });
  assert(templateMigRes.ok, "Template test tables created");

  // Apply public_read to announcements
  const publicReadRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({
      template: "public_read",
      tables: [{ table: "announcements" }],
    }),
  });
  const publicReadBody = await publicReadRes.json();
  assert(publicReadRes.ok, "public_read RLS applied");
  assert(publicReadBody.template === "public_read", "Response includes template name");

  // Apply public_read_write to guestbook
  const publicRWRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({
      template: "public_read_write",
      tables: [{ table: "guestbook" }],
    }),
  });
  assert(publicRWRes.ok, "public_read_write RLS applied");

  // Invalid template should fail
  const badTemplateRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({ template: "nonexistent", tables: [{ table: "guestbook" }] }),
  });
  assert(badTemplateRes.status === 400, "Invalid template returns 400");

  await sleep(500); // Wait for PostgREST reload

  // Insert announcement as authenticated user
  const announceInsertRes = await fetch(`${BASE_URL}/rest/v1/announcements`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ title: "Hello World", body: "First announcement" }),
  });
  assert(announceInsertRes.ok, "Authenticated user can insert announcement (public_read)");

  // Read announcement as anon (public_read allows SELECT for anyone)
  const announceReadRes = await fetch(`${BASE_URL}/rest/v1/announcements`, {
    headers: { apikey: anon_key },
  });
  const announceReadBody = await announceReadRes.json();
  assert(announceReadRes.ok, "Anon can read announcements (public_read)");
  assert(Array.isArray(announceReadBody) && announceReadBody.length === 1, "Anon sees 1 announcement");

  // Anon INSERT to announcements should fail (public_read = read-only for anon)
  const anonInsertRes = await fetch(`${BASE_URL}/rest/v1/announcements`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key, Prefer: "return=representation" },
    body: JSON.stringify({ title: "Anon post" }),
  });
  assert(!anonInsertRes.ok, `Anon cannot insert to public_read table (status ${anonInsertRes.status})`);

  // Insert guestbook entry as anon (public_read_write allows everything)
  const guestInsertRes = await fetch(`${BASE_URL}/rest/v1/guestbook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key, Prefer: "return=representation" },
    body: JSON.stringify({ name: "Visitor", message: "Great site!" }),
  });
  const guestInsertBody = await guestInsertRes.json();
  assert(guestInsertRes.ok, "Anon can insert to guestbook (public_read_write)");
  assert(Array.isArray(guestInsertBody) && guestInsertBody[0]?.name === "Visitor", "Guestbook entry created");

  // Read guestbook as anon
  const guestReadRes = await fetch(`${BASE_URL}/rest/v1/guestbook`, {
    headers: { apikey: anon_key },
  });
  const guestReadBody = await guestReadRes.json();
  assert(guestReadRes.ok, "Anon can read guestbook (public_read_write)");
  assert(Array.isArray(guestReadBody) && guestReadBody.length === 1, "Anon sees 1 guestbook entry");

  // Step 22: GRANT blocked with helpful hint
  console.log("\n22) GRANT blocked with hint...");
  const grantRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "GRANT SELECT ON profiles TO anon;",
  });
  const grantBody = await grantRes.json();
  assert(grantRes.status === 403, "GRANT still blocked");
  assert(typeof grantBody.error === "string", "GRANT error includes message");
  assert(grantBody.error.includes("IDENTITY"), "Hint suggests IDENTITY over SERIAL");

  const revokeRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "REVOKE SELECT ON profiles FROM anon;",
  });
  const revokeBody = await revokeRes.json();
  assert(revokeRes.status === 403, "REVOKE still blocked");
  assert(typeof revokeBody.error === "string", "REVOKE error includes message");
  assert(revokeBody.error.includes("RLS"), "Hint suggests using RLS endpoint");

  // Step 23: Bundle deploy — provision first, then deploy to existing project
  console.log("\n23) Bundle deploy...");

  // 23a: Provision a project first
  const bundleProvHeaders = await siwxHeaders("/projects/v1");
  const bundleProvRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bundleProvHeaders,
    },
    body: JSON.stringify({ name: "e2e-bundle-test" }),
  });
  const bundleProvBody = await bundleProvRes.json();
  assert(bundleProvRes.status === 201, `Bundle provision returns 201 (got ${bundleProvRes.status})`);
  const bundleProjectId = bundleProvBody.project_id;
  const bundleAnonKey = bundleProvBody.anon_key;
  const bundleServiceKey = bundleProvBody.service_key;
  assert(typeof bundleProjectId === "string", "Bundle provision returns project_id");
  assert(typeof bundleAnonKey === "string", "Bundle provision returns anon_key");
  assert(typeof bundleServiceKey === "string", "Bundle provision returns service_key");

  // 23b: Deploy to the provisioned project
  const bundleHeaders = await siwxHeaders("/deploy/v1");
  const bundleRes = await fetch(`${BASE_URL}/deploy/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bundleHeaders,
    },
    body: JSON.stringify({
      project_id: bundleProjectId,
      migrations: "CREATE TABLE items (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN DEFAULT false);",
      rls: {
        template: "public_read_write",
        tables: [{ table: "items" }],
      },
      files: [
        { file: "index.html", data: "<!doctype html><html><body><h1>Bundle Test</h1></body></html>" },
      ],
    }),
  });
  const bundleBody = await bundleRes.json();
  assert(bundleRes.status === 200, `Bundle deploy returns 200 (got ${bundleRes.status})`);
  assert(bundleBody.project_id === bundleProjectId, "Bundle deploy returns same project_id");
  assert(typeof bundleBody.site_url === "string", "Bundle returns site_url");
  assert(typeof bundleBody.deployment_id === "string", "Bundle returns deployment_id");
  assert(bundleBody.anon_key === undefined, "Bundle deploy does not return anon_key");
  assert(bundleBody.service_key === undefined, "Bundle deploy does not return service_key");

  await sleep(1500); // Wait for PostgREST schema cache reload

  // Verify table exists via REST
  const bundleInsertRes = await fetch(`${BASE_URL}/rest/v1/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: bundleAnonKey,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ title: "Bundle item" }),
  });
  const bundleInsertBody = await bundleInsertRes.json();
  assert(bundleInsertRes.ok, `Bundle project REST insert works (status ${bundleInsertRes.status})`);
  assert(Array.isArray(bundleInsertBody) && bundleInsertBody[0]?.title === "Bundle item", "Bundle item inserted");

  // Verify site deployment exists
  assert(bundleBody.site_url.includes("sites.run402.com"), "Bundle site URL points to sites.run402.com");

  // Clean up bundle project
  const bundleDeleteRes = await fetch(`${BASE_URL}/projects/v1/${bundleProjectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bundleServiceKey}` },
  });
  assert(bundleDeleteRes.ok, "Bundle project cleaned up");

  // Step 24: Publish — publish workout tracker as forkable app version
  console.log("\n24) Publish app version...");
  const publishRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${service_key}` },
    body: JSON.stringify({
      visibility: "public",
      fork_allowed: true,
      description: "E2E workout tracker — tables, RLS, auth",
      required_secrets: [],
    }),
  });
  const publishBody = await publishRes.json();
  assert(publishRes.status === 201, `Publish returns 201 (got ${publishRes.status})`);
  assert(typeof publishBody.id === "string", "Publish returns version id");
  assert(publishBody.visibility === "public", "Publish returns visibility");
  assert(publishBody.fork_allowed === true, "Publish returns fork_allowed");
  assert(publishBody.table_count >= 4, `Publish found tables (got ${publishBody.table_count})`);
  assert(publishBody.status === "published", "Publish status is published");

  const versionId = publishBody.id;

  // Verify public app info endpoint
  const appInfoRes = await fetch(`${BASE_URL}/apps/v1/${versionId}`);
  const appInfoBody = await appInfoRes.json();
  assert(appInfoRes.ok, "Public app info accessible");
  assert(appInfoBody.fork_allowed === true, "App info shows fork_allowed");
  assert(typeof appInfoBody.fork_pricing === "object", "App info includes fork pricing");

  // Step 25: Fork — fork the published app with wallet auth
  console.log("\n25) Fork app version...");
  const forkHeaders = await siwxHeaders("/fork/v1");
  const forkRes = await fetch(`${BASE_URL}/fork/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...forkHeaders,
    },
    body: JSON.stringify({
      version_id: versionId,
      name: "e2e-fork-test",
    }),
  });
  const forkBody = await forkRes.json();
  assert(forkRes.status === 201, `Fork returns 201 (got ${forkRes.status})`);
  assert(typeof forkBody.project_id === "string", "Fork returns project_id");
  assert(typeof forkBody.anon_key === "string", "Fork returns anon_key");
  assert(typeof forkBody.service_key === "string", "Fork returns service_key");
  assert(forkBody.source_version_id === versionId, "Fork records source version");
  assert(typeof forkBody.readiness === "string", "Fork returns readiness status");
  assert(forkBody.project_id !== project_id, "Fork creates different project");

  const forkProjectId = forkBody.project_id;
  const forkServiceKey = forkBody.service_key;

  await sleep(500); // Wait for PostgREST reload

  // Verify forked project has the tables (schema was restored)
  const forkSchemaRes = await fetch(`${BASE_URL}/projects/v1/admin/${forkProjectId}/schema`, {
    headers: { Authorization: `Bearer ${forkServiceKey}` },
  });
  const forkSchemaBody = await forkSchemaRes.json();
  assert(forkSchemaRes.ok, "Fork schema introspection works");
  const forkTableNames = (forkSchemaBody.tables || []).map((t: { name: string }) => t.name).sort();
  assert(forkTableNames.includes("profiles"), "Fork has profiles table");
  assert(forkTableNames.includes("exercises"), "Fork has exercises table");
  assert(forkTableNames.includes("workouts"), "Fork has workouts table");

  // Clean up fork project
  const forkDeleteRes = await fetch(`${BASE_URL}/projects/v1/${forkProjectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${forkServiceKey}` },
  });
  assert(forkDeleteRes.ok, "Fork project cleaned up");

  // Clean up published version (prevent stale gallery entries)
  const versionDeleteRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/versions/${versionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${service_key}` },
  });
  assert(versionDeleteRes.ok, "Published version cleaned up");

  // Step 26: OAuth providers + start
  console.log("\n26) OAuth providers + start...");

  // GET /auth/v1/providers
  const providersRes = await fetch(`${BASE_URL}/auth/v1/providers`, {
    headers: { apikey: anon_key },
  });
  const providersBody = await providersRes.json();
  assert(providersRes.ok, "Providers endpoint returns 200");
  assert(providersBody.password?.enabled === true, "Password provider enabled");
  assert(Array.isArray(providersBody.oauth), "OAuth providers is array");
  const googleProvider = providersBody.oauth.find((p: { provider: string }) => p.provider === "google");
  assert(googleProvider, "Google provider listed");
  assert(typeof googleProvider.enabled === "boolean", "Google provider has enabled flag");
  assert(providersRes.headers.get("cache-control") === "no-store", "Providers has Cache-Control: no-store");

  // POST /auth/v1/oauth/google/start — valid localhost redirect
  const oauthStartRes = await fetch(`${BASE_URL}/auth/v1/oauth/google/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ redirect_url: "http://localhost:3000/callback", mode: "popup" }),
  });
  const oauthStartBody = await oauthStartRes.json();
  if (googleProvider.enabled) {
    assert(oauthStartRes.ok, "OAuth start with localhost redirect returns 200");
    assert(typeof oauthStartBody.authorization_url === "string", "Returns authorization_url");
    assert(oauthStartBody.authorization_url.includes("accounts.google.com"), "Authorization URL points to Google");
    assert(oauthStartBody.authorization_url.includes("state="), "Authorization URL includes state");
    assert(oauthStartBody.authorization_url.includes("nonce="), "Authorization URL includes nonce");
    assert(oauthStartBody.provider === "google", "Returns provider=google");
    assert(oauthStartBody.expires_in === 600, "Returns expires_in=600");
    assert(oauthStartRes.headers.get("cache-control") === "no-store", "OAuth start has Cache-Control: no-store");
  } else {
    assert(oauthStartRes.status === 503, "OAuth start returns 503 when Google not configured");
  }

  // POST /auth/v1/oauth/google/start — evil.com redirect rejected
  const oauthBadRedirectRes = await fetch(`${BASE_URL}/auth/v1/oauth/google/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ redirect_url: "https://evil.com/steal", mode: "redirect" }),
  });
  assert(oauthBadRedirectRes.status === 400, "OAuth start rejects evil.com redirect (400)");
  const oauthBadBody = await oauthBadRedirectRes.json();
  assert(oauthBadBody.error.includes("not an allowed origin"), "Error message mentions allowed origin");

  // POST /auth/v1/oauth/google/start — missing redirect_url
  const oauthNoRedirectRes = await fetch(`${BASE_URL}/auth/v1/oauth/google/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ mode: "popup" }),
  });
  assert(oauthNoRedirectRes.status === 400, "OAuth start rejects missing redirect_url (400)");

  // POST /auth/v1/token?grant_type=authorization_code — invalid code
  const oauthBadCodeRes = await fetch(`${BASE_URL}/auth/v1/token?grant_type=authorization_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ code: "bogus-code-that-does-not-exist" }),
  });
  assert(oauthBadCodeRes.status === 401, "Token exchange rejects invalid code (401)");

  // Password login for social-only user guard (try login with null password_hash)
  // This is implicitly tested — we just verify the existing password user still works
  const reLoginRes = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: "athlete@example.com", password: "strong-password-123" }),
  });
  assert(reLoginRes.ok, "Password login still works after OAuth changes");

  // GET /auth/v1/user — verify new fields present
  const reLoginBody = await reLoginRes.json();
  const userRes2 = await fetch(`${BASE_URL}/auth/v1/user`, {
    headers: { apikey: anon_key, Authorization: `Bearer ${reLoginBody.access_token}` },
  });
  const userBody2 = await userRes2.json();
  assert(userRes2.ok, "GET /auth/v1/user returns 200");
  assert("email_verified_at" in userBody2, "User response includes email_verified_at field");
  assert("display_name" in userBody2, "User response includes display_name field");
  assert("avatar_url" in userBody2, "User response includes avatar_url field");
  assert("identities" in userBody2, "User response includes identities array");
  assert(Array.isArray(userBody2.identities), "Identities is an array");
  assert(userBody2.identities.length === 0, "Password user has no linked identities");
  assert(userRes2.headers.get("cache-control") === "no-store", "User endpoint has Cache-Control: no-store");

  // Step 27: Delete original project
  console.log("\n27) Delete project...");
  const deleteRes = await fetch(`${BASE_URL}/projects/v1/${project_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const deleteBody = await deleteRes.json();
  assert(deleteRes.ok, "Delete succeeds");
  assert(deleteBody.status === "archived", "Project archived");

  // --- Results ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nE2E test crashed:", err);
  process.exit(1);
});
