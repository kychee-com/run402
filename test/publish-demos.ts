/**
 * Publish demo apps to populate the gallery.
 * Creates projects, adds schema/functions/sites, publishes as public forkable apps.
 */
import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { ensureTestBalance } from "./ensure-balance.js";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface DemoApp {
  name: string;
  description: string;
  tags: string[];
  migrations: string;
  rls: { template: string; tables: Array<{ table: string; owner_column?: string }> };
  files?: Array<{ file: string; data: string }>;
}

const DEMOS: DemoApp[] = [
  {
    name: "todo-starter",
    description: "Simple todo list with user accounts. Fork and customize for any task tracker.",
    tags: ["todo", "auth", "rls", "starter"],
    migrations: `
      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, display_name TEXT, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE todos (id SERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES profiles(id), title TEXT NOT NULL, done BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
    `,
    rls: {
      template: "user_owns_rows",
      tables: [
        { table: "profiles", owner_column: "id" },
        { table: "todos", owner_column: "user_id" },
      ],
    },
    files: [{ file: "index.html", data: "<!doctype html><html><head><title>Todo Starter</title><style>body{font-family:system-ui;max-width:640px;margin:0 auto;padding:2rem;background:#0a0a0f;color:#e0e0e0}h1{color:#00ff9f}</style></head><body><h1>Todo Starter</h1><p>A simple todo app with user auth. Fork this and make it yours.</p></body></html>" }],
  },
  {
    name: "guestbook",
    description: "Public guestbook - anyone can read and write. Great starting point for forums, comment sections, or feedback forms.",
    tags: ["guestbook", "public-write", "starter"],
    migrations: `
      CREATE TABLE entries (id SERIAL PRIMARY KEY, name TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    `,
    rls: {
      template: "public_read_write",
      tables: [{ table: "entries" }],
    },
    files: [{ file: "index.html", data: "<!doctype html><html><head><title>Guestbook</title><style>body{font-family:system-ui;max-width:640px;margin:0 auto;padding:2rem;background:#0a0a0f;color:#e0e0e0}h1{color:#00ff9f}</style></head><body><h1>Guestbook</h1><p>A public guestbook. Anyone can sign. Fork this for your own.</p></body></html>" }],
  },
  {
    name: "link-board",
    description: "Share and vote on links. Authenticated users can post and upvote. Public read access.",
    tags: ["links", "voting", "auth", "public-read"],
    migrations: `
      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, username TEXT, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE links (id SERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES profiles(id), url TEXT NOT NULL, title TEXT NOT NULL, votes INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
    `,
    rls: {
      template: "public_read",
      tables: [
        { table: "profiles" },
        { table: "links" },
      ],
    },
    files: [{ file: "index.html", data: "<!doctype html><html><head><title>Link Board</title><style>body{font-family:system-ui;max-width:640px;margin:0 auto;padding:2rem;background:#0a0a0f;color:#e0e0e0}h1{color:#00ff9f}</style></head><body><h1>Link Board</h1><p>Share links, upvote the best ones. Fork this for your community.</p></body></html>" }],
  },
  {
    name: "inventory-tracker",
    description: "Track items with quantity, location, and categories. Private per-user data with row-level security.",
    tags: ["inventory", "auth", "rls", "categories"],
    migrations: `
      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE categories (id SERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES profiles(id), name TEXT NOT NULL);
      CREATE TABLE items (id SERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES profiles(id), category_id INTEGER REFERENCES categories(id), name TEXT NOT NULL, quantity INTEGER DEFAULT 0, location TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT now());
    `,
    rls: {
      template: "user_owns_rows",
      tables: [
        { table: "profiles", owner_column: "id" },
        { table: "categories", owner_column: "user_id" },
        { table: "items", owner_column: "user_id" },
      ],
    },
  },
];

async function publishDemo(demo: DemoApp, serviceKey: string, adminKey: string): Promise<void> {
  // Drip for next project
  console.log(`  Admin faucet drip...`);
  await fetch(`${BASE_URL}/admin/v1/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, "X-Admin-Key": adminKey },
    body: JSON.stringify({ address: account.address, amount: "0.5" }),
  });
  await sleep(5000);

  // Create project
  console.log(`  Creating project...`);
  const createRes = await fetchPaid(`${BASE_URL}/v1/deploy/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: demo.name,
      migrations: demo.migrations,
      rls: demo.rls,
      files: demo.files,
    }),
  });
  const project = await createRes.json();
  if (createRes.status !== 201) {
    console.error(`  FAILED to create ${demo.name}:`, project);
    return;
  }
  console.log(`  Project: ${project.project_id}`);

  await sleep(500);

  // Publish
  console.log(`  Publishing...`);
  const pubRes = await fetch(`${BASE_URL}/admin/v1/projects/${project.project_id}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${project.service_key}` },
    body: JSON.stringify({
      visibility: "public",
      fork_allowed: true,
      description: demo.description,
      tags: demo.tags,
    }),
  });
  const pubBody = await pubRes.json();
  if (pubRes.status === 201) {
    console.log(`  Published: ${pubBody.id} (${pubBody.table_count} tables, ${pubBody.function_count} functions)`);
  } else {
    console.error(`  Publish FAILED:`, pubBody);
  }

  // Pin the project so it doesn't expire
  if (ADMIN_KEY) {
    await fetch(`${BASE_URL}/admin/v1/projects/${project.project_id}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${project.service_key}`, "X-Admin-Key": ADMIN_KEY },
    });
    console.log(`  Pinned`);
  }
}

async function main() {
  await ensureTestBalance(account.address, BASE_URL);

  console.log("=== Publishing Demo Apps ===\n");

  // First project to bootstrap admin faucet access
  console.log("0) Bootstrap project for admin faucet...");
  const bootRes = await fetchPaid(`${BASE_URL}/v1/projects/create/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bootstrap" }),
  });
  const boot = await bootRes.json();
  if (!bootRes.ok) {
    console.error("Bootstrap failed:", boot);
    console.log("Try getting a faucet drip first: curl -X POST https://api.run402.com/v1/faucet ...");
    process.exit(1);
  }
  const bootstrapKey = boot.service_key;
  console.log(`   Bootstrap project: ${boot.project_id}\n`);

  for (let i = 0; i < DEMOS.length; i++) {
    console.log(`\n${i + 1}) ${DEMOS[i].name}`);
    await publishDemo(DEMOS[i], bootstrapKey, ADMIN_KEY);
  }

  // Archive bootstrap project
  await fetch(`${BASE_URL}/v1/projects/${boot.project_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bootstrapKey}` },
  });
  console.log("\nBootstrap project archived.");

  // Verify gallery
  console.log("\n--- Gallery check ---");
  const appsRes = await fetch(`${BASE_URL}/v1/apps`);
  const appsBody = await appsRes.json();
  console.log(`Public apps: ${appsBody.total}`);
  for (const app of appsBody.apps) {
    console.log(`  ${app.name}: ${app.table_count} tables, ${app.function_count} functions, fork=${app.fork_allowed}`);
  }

  console.log("\n=== Done ===");
  console.log("View gallery: https://run402.com/apps");
}

main().catch(err => { console.error("Crashed:", err.message || err); process.exit(1); });
