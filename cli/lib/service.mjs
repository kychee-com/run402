import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 service — Run402 service health and availability

Usage:
  run402 service status    Public availability report (uptime, capabilities, operator, deployment)
  run402 service health    Liveness check (per-dependency status + version)

Notes:
  - Both endpoints are unauthenticated and free. No allowance required.
  - This is the Run402 SERVICE status. For your ACCOUNT status (allowance,
    balance, tier, projects), use 'run402 status'.
`;

async function status() {
  try {
    const data = await getSdk().service.status();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function health() {
  try {
    const data = await getSdk().service.health();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status": await status(); break;
    case "health": await health(); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
