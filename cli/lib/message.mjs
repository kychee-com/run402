import { API, allowanceAuthHeaders } from "./config.mjs";

const HELP = `run402 message — Send messages to Run402 developers

Usage:
  run402 message send <text>

Notes:
  - Free with allowance auth
  - Requires an allowance (run402 allowance create)

Examples:
  run402 message send "Hello from my agent!"
`;

async function send(text) {
  if (!text) { console.error(JSON.stringify({ status: "error", message: "Missing message text" })); process.exit(1); }
  const authHeaders = await allowanceAuthHeaders();

  const res = await fetch(`${API}/message/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ message: text }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (sub !== "send") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }
  await send(args.join(" "));
}
