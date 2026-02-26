/**
 * AgentDB Supa test client — Workout Tracker Flow
 *
 * Simulates an agent that builds a workout tracker app:
 *   1.  Quote — get tier pricing (free)
 *   2.  Create project — pay $0.10 via x402
 *   3.  Apply migration — create tables (profiles, exercises, workouts, sets)
 *   4.  Apply RLS — user_owns_rows template
 *   5.  Sign up user
 *   6.  Log in — get access_token
 *   7.  Insert data — exercises, workouts, sets via PostgREST
 *   8.  Query with joins — PostgREST embedded resources
 *   9.  Upload file — workout log to storage
 *   10. Check usage — API calls + storage
 *   11. Delete project — cleanup
 *
 * Run: npm run test  (while server + Docker are running)
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
  console.error("Missing BUYER_PRIVATE_KEY in .env — run: npm run generate-wallets");
  process.exit(1);
}

// --- Setup x402 client ---

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchPaid = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

// --- Helpers ---

function logPayment(response: Response, label: string) {
  try {
    const payment = httpClient.getPaymentSettleResponse(
      (name) => response.headers.get(name),
    );
    if (payment) {
      console.log(`  x402 payment settled for "${label}"`);
      console.log(`    transaction: ${JSON.stringify(payment).slice(0, 120)}...`);
    }
  } catch {
    console.log(`  x402 payment completed for "${label}" (no settlement header)`);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main test flow ---

async function main() {
  console.log("\n=== AgentDB Supa Test — Workout Tracker ===\n");
  console.log(`Buyer wallet: ${signer.address}`);
  console.log(`Server:       ${BASE_URL}`);
  console.log(`Architecture: Postgres + PostgREST (schema-per-project)\n`);

  // =========================================================================
  // Step 1: Quote — get tier pricing (free)
  // =========================================================================
  console.log("1) Getting project quote...");
  const quoteRes = await fetch(`${BASE_URL}/v1/projects/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "workout-tracker" }),
  });
  const quoteBody = await quoteRes.json();
  console.log("   Tiers available:");
  for (const [tier, info] of Object.entries(quoteBody.tiers) as any) {
    console.log(`     ${tier}: ${info.price} (${info.lease_days} days, ${info.storage_mb}MB, ${info.api_calls.toLocaleString()} calls)`);
  }

  // =========================================================================
  // Step 2: Create project via x402 ($0.10 Prototype lease)
  // =========================================================================
  console.log("\n2) Creating project via x402 ($0.10 Prototype lease)...");
  const createRes = await fetchPaid(`${BASE_URL}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "workout-tracker" }),
  });
  const project = await createRes.json();
  if (!createRes.ok) {
    console.error("   FAILED:", project);
    process.exit(1);
  }
  console.log(`   Project created: ${project.project_id}`);
  console.log(`   Schema slot:     ${project.schema_slot}`);
  console.log(`   Lease expires:   ${project.lease_expires_at}`);
  logPayment(createRes, "create_project");

  const { project_id, anon_key, service_key } = project;

  // =========================================================================
  // Step 3: Apply migration — create workout tracker tables
  // =========================================================================
  console.log("\n3) Applying database migration...");
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
    headers: {
      "Content-Type": "text/plain",
      "Authorization": `Bearer ${service_key}`,
    },
    body: migrationSQL,
  });
  const migrationBody = await migrationRes.json();
  if (!migrationRes.ok) {
    console.error("   FAILED:", migrationBody);
    process.exit(1);
  }
  console.log(`   Migration applied to schema: ${migrationBody.schema}`);
  console.log("   Tables: profiles, exercises, workouts, sets");

  // Wait for PostgREST to reload schema cache
  console.log("   Waiting for PostgREST schema reload...");
  await sleep(500);

  // =========================================================================
  // Step 4: Apply RLS — user_owns_rows template
  // =========================================================================
  console.log("\n4) Applying RLS policies (user_owns_rows)...");
  const rlsRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/rls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${service_key}`,
    },
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
  const rlsBody = await rlsRes.json();
  if (!rlsRes.ok) {
    console.error("   FAILED:", rlsBody);
    process.exit(1);
  }
  console.log(`   RLS enabled on: ${rlsBody.tables.join(", ")}`);

  // =========================================================================
  // Step 5: Sign up user
  // =========================================================================
  console.log("\n5) Signing up user...");
  const signupRes = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": anon_key,
    },
    body: JSON.stringify({
      email: "athlete@example.com",
      password: "strong-password-123",
    }),
  });
  const signupBody = await signupRes.json();
  if (!signupRes.ok) {
    console.error("   FAILED:", signupBody);
    process.exit(1);
  }
  console.log(`   User created: ${signupBody.email} (${signupBody.id})`);

  const userId = signupBody.id;

  // =========================================================================
  // Step 6: Log in — get access_token
  // =========================================================================
  console.log("\n6) Logging in...");
  const loginRes = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": anon_key,
    },
    body: JSON.stringify({
      email: "athlete@example.com",
      password: "strong-password-123",
    }),
  });
  const loginBody = await loginRes.json();
  if (!loginRes.ok) {
    console.error("   FAILED:", loginBody);
    process.exit(1);
  }
  console.log(`   Logged in as: ${loginBody.user.email}`);
  console.log(`   Token expires in: ${loginBody.expires_in}s`);

  const accessToken = loginBody.access_token;

  // Common headers for authenticated PostgREST requests
  const restHeaders = {
    "Content-Type": "application/json",
    "apikey": anon_key,
    "Authorization": `Bearer ${accessToken}`,
    "Prefer": "return=representation",
  };

  // =========================================================================
  // Step 7: Insert data via PostgREST
  // =========================================================================
  console.log("\n7) Inserting workout data via PostgREST...");

  // 7a: Create profile (user_id = auth.uid())
  console.log("   7a) Creating profile...");
  const profileRes = await fetch(`${BASE_URL}/rest/v1/profiles`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      id: userId,
      email: "athlete@example.com",
      display_name: "Test Athlete",
    }),
  });
  const profileBody = await profileRes.json();
  if (!profileRes.ok) {
    console.error("   FAILED:", profileBody);
    process.exit(1);
  }
  console.log(`   Profile created: ${profileBody[0]?.display_name}`);

  // 7b: Create exercises
  console.log("   7b) Creating exercises...");
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
  if (!exercisesRes.ok) {
    console.error("   FAILED:", exercisesBody);
    process.exit(1);
  }
  console.log(`   Exercises created: ${exercisesBody.map((e: any) => e.name).join(", ")}`);

  const exerciseIds = exercisesBody.map((e: any) => e.id);

  // 7c: Create workout
  console.log("   7c) Creating workout...");
  const workoutRes = await fetch(`${BASE_URL}/rest/v1/workouts`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      user_id: userId,
      performed_at: new Date().toISOString().slice(0, 10),
      notes: "Upper body + legs day",
    }),
  });
  const workoutBody = await workoutRes.json();
  if (!workoutRes.ok) {
    console.error("   FAILED:", workoutBody);
    process.exit(1);
  }
  const workoutId = workoutBody[0]?.id;
  console.log(`   Workout created: ${workoutId}`);

  // 7d: Create sets
  console.log("   7d) Logging sets...");
  const setsRes = await fetch(`${BASE_URL}/rest/v1/sets`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify([
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[0], reps: 10, weight_kg: 60 },
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[0], reps: 8, weight_kg: 70 },
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[1], reps: 5, weight_kg: 100 },
      { user_id: userId, workout_id: workoutId, exercise_id: exerciseIds[2], reps: 5, weight_kg: 120 },
    ]),
  });
  const setsBody = await setsRes.json();
  if (!setsRes.ok) {
    console.error("   FAILED:", setsBody);
    process.exit(1);
  }
  console.log(`   Sets logged: ${setsBody.length} sets`);

  // =========================================================================
  // Step 8: Query with joins — PostgREST embedded resources
  // =========================================================================
  console.log("\n8) Querying workouts with joins (PostgREST resource embedding)...");
  const queryUrl = `${BASE_URL}/rest/v1/workouts?select=*,sets(*,exercises(*))`;
  const queryRes = await fetch(queryUrl, {
    method: "GET",
    headers: {
      "apikey": anon_key,
      "Authorization": `Bearer ${accessToken}`,
    },
  });
  const queryBody = await queryRes.json();
  if (!queryRes.ok) {
    console.error("   FAILED:", queryBody);
    process.exit(1);
  }

  console.log(`   Workouts found: ${queryBody.length}`);
  for (const workout of queryBody) {
    console.log(`   Workout: ${workout.performed_at} — "${workout.notes}"`);
    console.log(`     Sets: ${workout.sets?.length || 0}`);
    for (const set of workout.sets || []) {
      const exerciseName = set.exercises?.name || "unknown";
      console.log(`       ${exerciseName}: ${set.reps} reps @ ${set.weight_kg}kg`);
    }
  }

  // =========================================================================
  // Step 9: Upload file — workout log to storage
  // =========================================================================
  console.log("\n9) Uploading workout log to storage...");
  const logContent = [
    `Workout Log — ${new Date().toISOString()}`,
    `Athlete: athlete@example.com`,
    ``,
    `Exercises:`,
    ...exercisesBody.map((e: any) => `  - ${e.name} (${e.muscle_group})`),
    ``,
    `Sets:`,
    ...setsBody.map((s: any) => {
      const exercise = exercisesBody.find((e: any) => e.id === s.exercise_id);
      return `  - ${exercise?.name || "?"}: ${s.reps} reps @ ${s.weight_kg}kg`;
    }),
  ].join("\n");

  const uploadRes = await fetch(`${BASE_URL}/storage/v1/object/logs/workout-log.txt`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "apikey": anon_key,
    },
    body: logContent,
  });
  const uploadBody = await uploadRes.json();
  if (!uploadRes.ok) {
    console.error("   FAILED:", uploadBody);
    process.exit(1);
  }
  console.log(`   Uploaded: ${uploadBody.key} (${uploadBody.size} bytes)`);

  // =========================================================================
  // Step 10: Check usage
  // =========================================================================
  console.log("\n10) Checking project usage...");
  const usageRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/usage`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${service_key}` },
  });
  const usageBody = await usageRes.json();
  if (!usageRes.ok) {
    console.error("   FAILED:", usageBody);
    process.exit(1);
  }
  console.log(`   Project:       ${usageBody.project_id}`);
  console.log(`   Tier:          ${usageBody.tier}`);
  console.log(`   API calls:     ${usageBody.api_calls} / ${usageBody.api_calls_limit.toLocaleString()}`);
  console.log(`   Storage:       ${usageBody.storage_bytes} bytes / ${(usageBody.storage_limit_bytes / 1024 / 1024).toFixed(0)} MB`);

  // =========================================================================
  // Step 11: Delete project — cleanup
  // =========================================================================
  console.log("\n11) Deleting project (cleanup)...");
  const deleteRes = await fetch(`${BASE_URL}/v1/projects/${project_id}`, {
    method: "DELETE",
  });
  const deleteBody = await deleteRes.json();
  if (!deleteRes.ok) {
    console.error("   FAILED:", deleteBody);
    process.exit(1);
  }
  console.log(`   Project ${deleteBody.project_id}: ${deleteBody.status}`);

  // =========================================================================
  // Done
  // =========================================================================
  console.log("\n=== All 11 steps completed successfully ===");
  console.log("\nSummary:");
  console.log("  - x402 payment: $0.10 (Prototype lease on Base Sepolia testnet)");
  console.log("  - Schema: Postgres tables with foreign keys + RLS");
  console.log("  - Auth: email/password signup + JWT login");
  console.log("  - REST: PostgREST CRUD + resource embedding (joins)");
  console.log("  - Storage: local filesystem upload");
  console.log("  - Cleanup: schema dropped + project archived\n");
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  process.exit(1);
});
