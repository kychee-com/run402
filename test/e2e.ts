/**
 * AgentDB E2E Test — Workout Tracker Flow
 *
 * Tests the full lifecycle against a running AgentDB instance:
 *   1.  Quote — get tier pricing
 *   2.  Create project — pay via x402
 *   3.  Apply migration — create tables
 *   4.  Apply RLS — user_owns_rows template
 *   5.  Sign up user
 *   6.  Log in — get access_token + refresh_token
 *   7.  Insert data — exercises, workouts, sets via PostgREST
 *   8.  Query with joins — PostgREST embedded resources
 *   9.  Upload file — workout log to storage
 *   10. Check usage — API calls + storage
 *   11. Schema introspection — verify tables/columns
 *   12. Refresh token — rotate tokens
 *   13. Delete project — cleanup
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
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

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
  console.log("\n=== AgentDB E2E Test — Workout Tracker ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Buyer:   ${account.address}\n`);

  // Step 1: Quote
  console.log("1) Quote...");
  const quoteRes = await fetch(`${BASE_URL}/v1/projects/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const quoteBody = await quoteRes.json();
  assert(quoteRes.ok, "Quote returns 200");
  assert(quoteBody.tiers?.prototype != null, "Quote includes prototype tier");
  assert(quoteBody.tiers?.hobby != null, "Quote includes hobby tier");
  assert(quoteBody.tiers?.team != null, "Quote includes team tier");

  // Step 2: Create project via x402
  console.log("\n2) Create project via x402...");
  const createRes = await fetchPaid(`${BASE_URL}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e-workout-tracker" }),
  });
  const project = await createRes.json();
  assert(createRes.ok, "Project creation succeeds");
  assert(typeof project.project_id === "string", "Returns project_id");
  assert(typeof project.anon_key === "string", "Returns anon_key");
  assert(typeof project.service_key === "string", "Returns service_key");
  assert(typeof project.schema_slot === "string", "Returns schema_slot");
  assert(typeof project.lease_expires_at === "string", "Returns lease_expires_at");

  const { project_id, anon_key, service_key } = project;

  // Step 3: Apply migration
  console.log("\n3) Apply migration...");
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
  const migrationRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: migrationSQL,
  });
  const migrationBody = await migrationRes.json();
  assert(migrationRes.ok, "Migration succeeds");
  assert(migrationBody.schema != null, "Returns schema slot");

  await sleep(500); // Wait for PostgREST reload

  // Step 4: Apply RLS
  console.log("\n4) Apply RLS...");
  const rlsRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/rls`, {
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

  // Step 5: Sign up
  console.log("\n5) Sign up...");
  const signupRes = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon_key },
    body: JSON.stringify({ email: "athlete@example.com", password: "strong-password-123" }),
  });
  const signupBody = await signupRes.json();
  assert(signupRes.ok, "Signup succeeds");
  assert(typeof signupBody.id === "string", "Returns user id");
  const userId = signupBody.id;

  // Step 6: Log in
  console.log("\n6) Log in...");
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

  // Step 7: Insert data
  console.log("\n7) Insert data via PostgREST...");

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

  // Step 8: Query with joins
  console.log("\n8) Query with joins...");
  const queryRes = await fetch(`${BASE_URL}/rest/v1/workouts?select=*,sets(*,exercises(*))`, {
    headers: { apikey: anon_key, Authorization: `Bearer ${accessToken}` },
  });
  const queryBody = await queryRes.json();
  assert(queryRes.ok, "Join query succeeds");
  assert(Array.isArray(queryBody) && queryBody.length === 1, "1 workout returned");
  assert(queryBody[0].sets?.length === 3, "3 sets embedded in workout");
  assert(queryBody[0].sets[0].exercises?.name != null, "Exercise embedded in set");

  // Step 9: Upload file
  console.log("\n9) Upload file...");
  const uploadRes = await fetch(`${BASE_URL}/storage/v1/object/logs/workout-log.txt`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", apikey: anon_key },
    body: "E2E test workout log content",
  });
  const uploadBody = await uploadRes.json();
  assert(uploadRes.ok, "File uploaded");
  assert(uploadBody.key === "logs/workout-log.txt", "Correct file key");
  assert(uploadBody.size > 0, "File has size > 0");

  // Step 10: Check usage
  console.log("\n10) Check usage...");
  const usageRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/usage`, {
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const usageBody = await usageRes.json();
  assert(usageRes.ok, "Usage report succeeds");
  assert(usageBody.api_calls > 0, "API calls tracked");
  assert(usageBody.api_calls_limit > 0, "API call limit set");
  assert(typeof usageBody.lease_expires_at === "string", "Lease expiry in usage report");

  // Step 11: Schema introspection
  console.log("\n11) Schema introspection...");
  const schemaRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/schema`, {
    headers: { Authorization: `Bearer ${service_key}` },
  });
  const schemaBody = await schemaRes.json();
  assert(schemaRes.ok, "Schema introspection succeeds");
  assert(Array.isArray(schemaBody.tables), "Returns tables array");
  const tableNames = schemaBody.tables.map((t: any) => t.name).sort();
  assert(tableNames.includes("profiles"), "Profiles table found");
  assert(tableNames.includes("exercises"), "Exercises table found");
  assert(tableNames.includes("workouts"), "Workouts table found");
  assert(tableNames.includes("sets"), "Sets table found");

  // Verify columns on profiles
  const profilesTable = schemaBody.tables.find((t: any) => t.name === "profiles");
  assert(profilesTable?.columns?.length === 4, "Profiles has 4 columns");
  assert(profilesTable?.rls_enabled === true, "Profiles has RLS enabled");

  // Step 12: Refresh token
  console.log("\n12) Refresh token...");
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

  // Step 13: SQL blocklist
  console.log("\n13) SQL blocklist...");
  const blockedRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${service_key}` },
    body: "CREATE EXTENSION pg_stat_statements;",
  });
  assert(blockedRes.status === 403, "Blocked SQL returns 403");

  // Step 14: Delete project
  console.log("\n14) Delete project...");
  const deleteRes = await fetch(`${BASE_URL}/v1/projects/${project_id}`, { method: "DELETE" });
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
