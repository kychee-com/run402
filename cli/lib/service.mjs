import { API } from "./config.mjs";

const HELP = `run402 service — Run402 service health and availability

Usage:
  run402 service status    Public availability report (uptime, capabilities, operator, deployment)
  run402 service health    Liveness check (per-dependency status + version)

Notes:
  - Both endpoints are unauthenticated and free. No allowance required.
  - This is the Run402 SERVICE status. For your ACCOUNT status (allowance,
    balance, tier, projects), use 'run402 status'.
`;

async function fetchAndEmit(path) {
  let res;
  try {
    res = await fetch(`${API}${path}`);
  } catch (err) {
    console.log(JSON.stringify({ error: "fetch_failed", message: err?.message || String(err) }));
    return;
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    console.log(JSON.stringify({ error: "non_2xx", status: res.status, body }, null, 2));
    return;
  }
  console.log(JSON.stringify(body, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status":
      await fetchAndEmit("/status");
      return;
    case "health":
      await fetchAndEmit("/health");
      return;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
