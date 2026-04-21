import { API, allowanceAuthHeaders } from "./config.mjs";

const HELP = `run402 agent — Manage agent identity

Usage:
  run402 agent contact --name <name> [--email <email>] [--webhook <url>]

Notes:
  - Free with allowance auth
  - Registers contact info so Run402 can reach your agent
  - Only name is required; email and webhook are optional

Examples:
  run402 agent contact --name my-agent
  run402 agent contact --name my-agent --email ops@example.com --webhook https://example.com/hook
`;

async function contact(args) {
  let name = null, email = null, webhook = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    if (args[i] === "--email" && args[i + 1]) email = args[++i];
    if (args[i] === "--webhook" && args[i + 1]) webhook = args[++i];
  }
  if (!name) { console.error(JSON.stringify({ status: "error", message: "Missing --name <name>" })); process.exit(1); }
  const authHeaders = allowanceAuthHeaders("/agent/v1/contact");

  const body = { name };
  if (email) body.email = email;
  if (webhook) body.webhook = webhook;

  const res = await fetch(`${API}/agent/v1/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    process.exit(0);
  }
  if (sub !== "contact") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await contact(args);
}
