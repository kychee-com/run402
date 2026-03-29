/**
 * bld402 Compatibility Test
 *
 * Verifies that run402 API changes do not break bld402 templates.
 * Tests 3 representative bld402 templates against the run402 API:
 *
 *   1. shared-todo     — simple DB + REST (public_read_write RLS)
 *   2. paste-locker    — DB + edge functions (no RLS, access via functions)
 *   3. landing-waitlist — simple DB + REST (public_read_write RLS)
 *
 * Each template test: provision project, run schema SQL, apply RLS,
 * deploy functions (if any), deploy minimal HTML, verify HTTP 200,
 * verify REST API or function calls, then delete the project.
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 npm run test:bld402-compat
 *   BASE_URL=https://api.run402.com npm run test:bld402-compat
 *
 * Suggested npm script:
 *   "test:bld402-compat": "npx tsx test/bld402-compat.ts"
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

// ============================================================
// bld402 template SQL & function code (embedded for self-containment)
// ============================================================

// --- shared-todo ---

const SHARED_TODO_SCHEMA = `\
-- Shared Todo List — Database Schema
-- Creates tables for a collaborative task list with assignments

CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task text NOT NULL,
  done boolean DEFAULT false,
  assigned_to text,
  user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_todos_user ON todos(user_id);
CREATE INDEX idx_todos_done ON todos(done);
`;

const SHARED_TODO_RLS = {
  template: "public_read_write",
  tables: [{ table: "todos" }],
};

// --- paste-locker ---

const PASTE_LOCKER_SCHEMA = `\
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text DEFAULT 'Untitled',
  content_encrypted text NOT NULL,
  password_hash text,
  burn_after_read boolean DEFAULT false,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX idx_notes_code ON notes(code);
`;

// No RLS for paste-locker — access goes through server-side functions

const PASTE_LOCKER_CREATE_NOTE = `\
import { db } from '@run402/functions';

const schema_validate = (body) => {
  if (!body || typeof body.content !== 'string' || body.content.length < 1 || body.content.length > 100000) {
    return null;
  }
  return {
    title: (typeof body.title === 'string' && body.title.length <= 200) ? body.title : undefined,
    content: body.content,
    password: (typeof body.password === 'string' && body.password.length >= 1 && body.password.length <= 200) ? body.password : undefined,
    burn_after_read: typeof body.burn_after_read === 'boolean' ? body.burn_after_read : undefined,
    expires_in: ['1h', '24h', '7d'].includes(body.expires_in) ? body.expires_in : undefined,
  };
};

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getExpiresAt(expiresIn) {
  if (!expiresIn) return null;
  const now = Date.now();
  const ms = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
  return new Date(now + ms[expiresIn]).toISOString();
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = schema_validate(await req.json());
    if (!body) throw new Error('Invalid input');
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid input' }), { status: 400 });
  }

  const code = generateCode();
  const password_hash = null; // simplified for compat test — no bcrypt in edge
  const expires_at = getExpiresAt(body.expires_in);

  const [note] = await db.from('notes').insert({
    code,
    title: body.title || 'Untitled',
    content_encrypted: body.content,
    password_hash,
    burn_after_read: body.burn_after_read || false,
    expires_at,
  });

  return new Response(JSON.stringify({
    code,
    has_password: !!password_hash,
    burn_after_read: body.burn_after_read || false,
  }), { status: 201 });
};
`;

const PASTE_LOCKER_READ_NOTE = `\
import { db } from '@run402/functions';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { code } = body;
  if (!code || typeof code !== 'string') {
    return new Response(JSON.stringify({ error: 'Code is required' }), { status: 400 });
  }

  const notes = await db.from('notes').select('*').eq('code', code).limit(1);
  if (!notes || notes.length === 0) {
    return new Response(JSON.stringify({ error: 'Note not found' }), { status: 404 });
  }

  const note = notes[0];

  if (note.expires_at && new Date(note.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'This note has expired' }), { status: 404 });
  }

  if (note.burn_after_read && note.is_read) {
    return new Response(JSON.stringify({ error: 'This note has been burned' }), { status: 410 });
  }

  if (note.burn_after_read && !note.is_read) {
    await db.from('notes').update({ is_read: true }).eq('id', note.id);
  }

  return new Response(JSON.stringify({
    title: note.title,
    content: note.content_encrypted,
    burn_after_read: note.burn_after_read,
    created_at: note.created_at,
  }), { status: 200 });
};
`;

// --- landing-waitlist ---

const LANDING_WAITLIST_SCHEMA = `\
-- Landing Page + Waitlist — Database Schema
-- Stores email signups for a product launch waitlist

CREATE TABLE signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_signups_email ON signups(email);
`;

const LANDING_WAITLIST_RLS = {
  template: "public_read_write",
  tables: [{ table: "signups" }],
};

// Minimal HTML page used for all template deployments
const MINIMAL_HTML = `<!doctype html><html><body><h1>bld402 compat test</h1></body></html>`;

// ============================================================
// Main test flow
// ============================================================

async function main() {
  console.log("\n=== bld402 Compatibility Test ===\n");
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Buyer:   ${account.address}\n`);

  // Pre-flight: ensure wallet has enough USDC
  await ensureTestBalance(account.address, BASE_URL);

  // Step 0: Subscribe to prototype tier via x402 (skip if already active)
  console.log("0) Subscribe to prototype tier via x402...");
  const preCheckHeaders = await siwxHeaders("/tiers/v1/status");
  const preCheckRes = await fetch(`${BASE_URL}/tiers/v1/status`, { headers: preCheckHeaders });
  const preCheck = preCheckRes.ok ? await preCheckRes.json() as Record<string, unknown> : null;

  if (preCheck?.active && preCheck?.tier === "prototype") {
    console.log("  SKIP: Wallet already has active prototype tier (saving $0.10)");
    assert(true, "Subscribe returns 200 or 201 (skipped — tier active)");
    assert(true, "Subscribe returns tier=prototype");
  } else {
    const subscribeRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const subscribeBody = await subscribeRes.json();
    assert(
      subscribeRes.status === 201 || subscribeRes.status === 200,
      `Subscribe returns 200 or 201 (got ${subscribeRes.status})`,
    );
    assert(subscribeBody.tier === "prototype", "Subscribe returns tier=prototype");
  }

  // ============================================================
  // Template 1: shared-todo
  // ============================================================
  console.log("\n--- Template 1: shared-todo ---\n");

  // 1a: Create project
  console.log("1a) Create project...");
  const todoCreateHeaders = await siwxHeaders("/projects/v1");
  const todoCreateRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...todoCreateHeaders },
    body: JSON.stringify({ name: "bld402-shared-todo" }),
  });
  const todoProject = await todoCreateRes.json();
  assert(todoCreateRes.status === 201, `shared-todo project created (got ${todoCreateRes.status})`);
  assert(typeof todoProject.project_id === "string", "Returns project_id");
  const todoProjectId = todoProject.project_id;
  const todoAnonKey = todoProject.anon_key;
  const todoServiceKey = todoProject.service_key;

  // 1b: Run schema SQL
  console.log("1b) Run schema SQL...");
  const todoSchemaRes = await fetch(`${BASE_URL}/projects/v1/admin/${todoProjectId}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${todoServiceKey}` },
    body: SHARED_TODO_SCHEMA,
  });
  const todoSchemaBody = await todoSchemaRes.json();
  assert(todoSchemaRes.ok, "shared-todo schema applied");
  assert(todoSchemaBody.schema != null, "Returns schema slot");

  await sleep(500);

  // 1c: Apply RLS
  console.log("1c) Apply RLS...");
  const todoRlsRes = await fetch(`${BASE_URL}/projects/v1/admin/${todoProjectId}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${todoServiceKey}` },
    body: JSON.stringify(SHARED_TODO_RLS),
  });
  assert(todoRlsRes.ok, "shared-todo RLS applied (public_read_write)");

  // 1d: Deploy HTML
  console.log("1d) Deploy HTML...");
  const todoDeployHeaders = await siwxHeaders("/deployments/v1");
  const todoDeployRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...todoDeployHeaders },
    body: JSON.stringify({
      project: todoProjectId,
      files: [{ file: "index.html", data: MINIMAL_HTML }],
    }),
  });
  const todoDeployBody = await todoDeployRes.json();
  assert(todoDeployRes.ok, `shared-todo site deployed (status ${todoDeployRes.status})`);
  assert(typeof todoDeployBody.url === "string", "Returns url");

  await sleep(500);

  // 1e: Write via REST API (anon can write with public_read_write)
  console.log("1e) Write todo via REST...");
  const todoInsertRes = await fetch(`${BASE_URL}/rest/v1/todos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: todoAnonKey,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ task: "Buy groceries", assigned_to: "alice" }),
  });
  const todoInsertBody = await todoInsertRes.json();
  assert(todoInsertRes.ok, `shared-todo REST insert succeeds (status ${todoInsertRes.status})`);
  assert(
    Array.isArray(todoInsertBody) && todoInsertBody[0]?.task === "Buy groceries",
    "Todo created with correct task",
  );

  // 1f: Read via REST API
  console.log("1f) Read todos via REST...");
  const todoReadRes = await fetch(`${BASE_URL}/rest/v1/todos`, {
    headers: { apikey: todoAnonKey },
  });
  const todoReadBody = await todoReadRes.json();
  assert(todoReadRes.ok, "shared-todo REST read succeeds");
  assert(Array.isArray(todoReadBody) && todoReadBody.length === 1, "1 todo returned");
  assert(todoReadBody[0]?.assigned_to === "alice", "Todo has correct assigned_to");

  // 1g: Delete project
  console.log("1g) Delete project...");
  const todoDeleteRes = await fetch(`${BASE_URL}/projects/v1/${todoProjectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${todoServiceKey}` },
  });
  assert(todoDeleteRes.ok, "shared-todo project deleted");

  // ============================================================
  // Template 2: paste-locker
  // ============================================================
  console.log("\n--- Template 2: paste-locker ---\n");

  // 2a: Create project
  console.log("2a) Create project...");
  const pasteCreateHeaders = await siwxHeaders("/projects/v1");
  const pasteCreateRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...pasteCreateHeaders },
    body: JSON.stringify({ name: "bld402-paste-locker" }),
  });
  const pasteProject = await pasteCreateRes.json();
  assert(pasteCreateRes.status === 201, `paste-locker project created (got ${pasteCreateRes.status})`);
  const pasteProjectId = pasteProject.project_id;
  const pasteAnonKey = pasteProject.anon_key;
  const pasteServiceKey = pasteProject.service_key;

  // 2b: Run schema SQL
  console.log("2b) Run schema SQL...");
  const pasteSchemaRes = await fetch(`${BASE_URL}/projects/v1/admin/${pasteProjectId}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${pasteServiceKey}` },
    body: PASTE_LOCKER_SCHEMA,
  });
  assert(pasteSchemaRes.ok, "paste-locker schema applied");

  await sleep(500);

  // 2c: No RLS for paste-locker (access via functions only)

  // 2d: Deploy functions
  console.log("2d) Deploy create-note function...");
  const createNoteFnRes = await fetch(`${BASE_URL}/projects/v1/admin/${pasteProjectId}/functions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pasteServiceKey}`,
    },
    body: JSON.stringify({
      name: "create-note",
      code: PASTE_LOCKER_CREATE_NOTE,
    }),
  });
  const createNoteFnBody = await createNoteFnRes.json();
  assert(createNoteFnRes.status === 201, `create-note function deployed (got ${createNoteFnRes.status})`);
  assert(createNoteFnBody.name === "create-note", "create-note function name matches");

  console.log("2d) Deploy read-note function...");
  const readNoteFnRes = await fetch(`${BASE_URL}/projects/v1/admin/${pasteProjectId}/functions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pasteServiceKey}`,
    },
    body: JSON.stringify({
      name: "read-note",
      code: PASTE_LOCKER_READ_NOTE,
    }),
  });
  const readNoteFnBody = await readNoteFnRes.json();
  assert(readNoteFnRes.status === 201, `read-note function deployed (got ${readNoteFnRes.status})`);
  assert(readNoteFnBody.name === "read-note", "read-note function name matches");

  // 2e: Deploy HTML
  console.log("2e) Deploy HTML...");
  const pasteDeployHeaders = await siwxHeaders("/deployments/v1");
  const pasteDeployRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...pasteDeployHeaders },
    body: JSON.stringify({
      project: pasteProjectId,
      files: [{ file: "index.html", data: MINIMAL_HTML }],
    }),
  });
  const pasteDeployBody = await pasteDeployRes.json();
  assert(pasteDeployRes.ok, `paste-locker site deployed (status ${pasteDeployRes.status})`);
  assert(typeof pasteDeployBody.url === "string", "Returns url");

  // Wait for Lambda functions to be ready
  await sleep(3000);

  // 2f: Test create-note function
  console.log("2f) Test create-note function...");
  const createNoteRes = await fetch(`${BASE_URL}/functions/v1/create-note`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: pasteAnonKey,
    },
    body: JSON.stringify({
      title: "Test Note",
      content: "Hello from bld402 compat test",
    }),
  });
  const createNoteBody = await createNoteRes.json();
  assert(createNoteRes.status === 201, `create-note returns 201 (got ${createNoteRes.status})`);
  assert(typeof createNoteBody.code === "string", "create-note returns code");
  assert(createNoteBody.has_password === false, "create-note returns has_password=false");

  const noteCode = createNoteBody.code;

  // 2g: Test read-note function
  console.log("2g) Test read-note function...");
  const readNoteRes = await fetch(`${BASE_URL}/functions/v1/read-note`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: pasteAnonKey,
    },
    body: JSON.stringify({ code: noteCode }),
  });
  const readNoteBody = await readNoteRes.json();
  assert(readNoteRes.status === 200, `read-note returns 200 (got ${readNoteRes.status})`);
  assert(readNoteBody.title === "Test Note", "read-note returns correct title");
  assert(readNoteBody.content === "Hello from bld402 compat test", "read-note returns correct content");

  // 2h: Delete project
  console.log("2h) Delete project...");
  const pasteDeleteRes = await fetch(`${BASE_URL}/projects/v1/${pasteProjectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${pasteServiceKey}` },
  });
  assert(pasteDeleteRes.ok, "paste-locker project deleted");

  // ============================================================
  // Template 3: landing-waitlist
  // ============================================================
  console.log("\n--- Template 3: landing-waitlist ---\n");

  // 3a: Create project
  console.log("3a) Create project...");
  const waitlistCreateHeaders = await siwxHeaders("/projects/v1");
  const waitlistCreateRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...waitlistCreateHeaders },
    body: JSON.stringify({ name: "bld402-landing-waitlist" }),
  });
  const waitlistProject = await waitlistCreateRes.json();
  assert(waitlistCreateRes.status === 201, `landing-waitlist project created (got ${waitlistCreateRes.status})`);
  const waitlistProjectId = waitlistProject.project_id;
  const waitlistAnonKey = waitlistProject.anon_key;
  const waitlistServiceKey = waitlistProject.service_key;

  // 3b: Run schema SQL
  console.log("3b) Run schema SQL...");
  const waitlistSchemaRes = await fetch(`${BASE_URL}/projects/v1/admin/${waitlistProjectId}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${waitlistServiceKey}` },
    body: LANDING_WAITLIST_SCHEMA,
  });
  assert(waitlistSchemaRes.ok, "landing-waitlist schema applied");

  await sleep(500);

  // 3c: Apply RLS
  console.log("3c) Apply RLS...");
  const waitlistRlsRes = await fetch(`${BASE_URL}/projects/v1/admin/${waitlistProjectId}/rls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${waitlistServiceKey}` },
    body: JSON.stringify(LANDING_WAITLIST_RLS),
  });
  assert(waitlistRlsRes.ok, "landing-waitlist RLS applied (public_read_write)");

  // 3d: Deploy HTML
  console.log("3d) Deploy HTML...");
  const waitlistDeployHeaders = await siwxHeaders("/deployments/v1");
  const waitlistDeployRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...waitlistDeployHeaders },
    body: JSON.stringify({
      project: waitlistProjectId,
      files: [{ file: "index.html", data: MINIMAL_HTML }],
    }),
  });
  const waitlistDeployBody = await waitlistDeployRes.json();
  assert(waitlistDeployRes.ok, `landing-waitlist site deployed (status ${waitlistDeployRes.status})`);
  assert(typeof waitlistDeployBody.url === "string", "Returns url");

  await sleep(500);

  // 3e: Write via REST API (anon can write with public_read_write)
  console.log("3e) Write signup via REST...");
  const signupInsertRes = await fetch(`${BASE_URL}/rest/v1/signups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: waitlistAnonKey,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ email: "test@example.com" }),
  });
  const signupInsertBody = await signupInsertRes.json();
  assert(signupInsertRes.ok, `landing-waitlist REST insert succeeds (status ${signupInsertRes.status})`);
  assert(
    Array.isArray(signupInsertBody) && signupInsertBody[0]?.email === "test@example.com",
    "Signup created with correct email",
  );

  // 3f: Read via REST API
  console.log("3f) Read signups via REST...");
  const signupReadRes = await fetch(`${BASE_URL}/rest/v1/signups`, {
    headers: { apikey: waitlistAnonKey },
  });
  const signupReadBody = await signupReadRes.json();
  assert(signupReadRes.ok, "landing-waitlist REST read succeeds");
  assert(Array.isArray(signupReadBody) && signupReadBody.length === 1, "1 signup returned");
  assert(signupReadBody[0]?.email === "test@example.com", "Signup has correct email");

  // 3g: Verify unique constraint (duplicate email rejected)
  console.log("3g) Verify unique constraint...");
  const dupInsertRes = await fetch(`${BASE_URL}/rest/v1/signups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: waitlistAnonKey,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ email: "test@example.com" }),
  });
  assert(!dupInsertRes.ok, `Duplicate email rejected (status ${dupInsertRes.status})`);

  // 3h: Delete project
  console.log("3h) Delete project...");
  const waitlistDeleteRes = await fetch(`${BASE_URL}/projects/v1/${waitlistProjectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${waitlistServiceKey}` },
  });
  assert(waitlistDeleteRes.ok, "landing-waitlist project deleted");

  // --- Results ---
  console.log(`\n=== bld402 Compat Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nbld402 compat test crashed:", err);
  process.exit(1);
});
