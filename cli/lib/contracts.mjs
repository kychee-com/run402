import { findProject, API } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 contracts — KMS-backed Ethereum wallets for smart-contract calls

  Pricing: $0.04/day per wallet ($1.20/month) plus $0.000005 per contract call.
  Wallet creation requires $1.20 in cash credit (30 days of rent).
  Non-custodial: see https://run402.com/humans/terms.html#non-custodial-kms-wallets

Usage:
  run402 contracts <subcommand> [args...]

Subcommands:
  provision-wallet <project_id> --chain <base-mainnet|base-sepolia> [--recovery 0x...]
    Provision a KMS wallet ($0.04/day, requires $1.20 prepay).
  get-wallet <project_id> <wallet_id>
    Get wallet metadata + live native balance.
  list-wallets <project_id>
    List all KMS wallets for the project (includes deleted).
  set-recovery <project_id> <wallet_id> [--address 0x... | --clear]
    Set/clear the optional recovery address.
  set-alert <project_id> <wallet_id> --threshold-wei <n>
    Set the low-balance alert threshold (in wei).
  call <project_id> <wallet_id> --to 0x... --abi <json> --fn <name> --args <json> [--value-wei <n>] [--idempotency-key <k>]
    Submit a contract write call (chain gas + $0.000005 KMS sign fee).
  read --chain <chain> --to 0x... --abi <json> --fn <name> --args <json>
    Read-only contract call (free).
  status <project_id> <call_id>
    Get call status, gas used, gas cost USD-micros, receipt.
  drain <project_id> <wallet_id> --to 0x... --confirm
    Drain native balance to a destination address. Works on suspended wallets.
  delete <project_id> <wallet_id> --confirm
    Schedule the KMS key for deletion (refused if balance >= dust).

Examples:
  run402 contracts provision-wallet proj_abc --chain base-mainnet
  run402 contracts call proj_abc cwlt_xyz --to 0x1234... --abi '[{"type":"function","name":"ping","inputs":[],"outputs":[]}]' --fn ping --args '[]'
`;

const SUB_HELP = {
  "provision-wallet": `run402 contracts provision-wallet — Provision a KMS-backed wallet

Usage:
  run402 contracts provision-wallet <project_id> --chain <chain> [options]

Arguments:
  <project_id>        Target project ID

Options:
  --chain <chain>     Required: base-mainnet or base-sepolia
  --recovery 0x...    Optional recovery address (can be set later)
  --yes               Skip confirmation when project already has a wallet
`,
  "set-recovery": `run402 contracts set-recovery — Set or clear the wallet recovery address

Usage:
  run402 contracts set-recovery <project_id> <wallet_id> [options]
`,
  "set-alert": `run402 contracts set-alert — Set the low-balance alert threshold

Usage:
  run402 contracts set-alert <project_id> <wallet_id> --threshold-wei <n>
`,
  call: `run402 contracts call — Submit a contract write call

Usage:
  run402 contracts call <project_id> <wallet_id> --to 0x... --abi <json>
    --fn <name> --args <json> [options]
`,
  read: `run402 contracts read — Read-only contract call (free)

Usage:
  run402 contracts read --chain <chain> --to 0x... --abi <json>
    --fn <name> --args <json>
`,
  drain: `run402 contracts drain — Drain native balance to a destination address

Usage:
  run402 contracts drain <project_id> <wallet_id> --to 0x... --confirm
`,
  delete: `run402 contracts delete — Schedule the KMS key for deletion

Usage:
  run402 contracts delete <project_id> <wallet_id> --confirm
`,
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}
function hasFlag(args, flag) {
  return args.includes(flag);
}

async function provisionWallet(projectId, args) {
  const p = findProject(projectId);
  const chain = parseFlag(args, "--chain");
  if (!chain) {
    console.error(JSON.stringify({ status: "error", message: "Missing --chain (base-mainnet or base-sepolia)" }));
    process.exit(1);
  }
  const recovery = parseFlag(args, "--recovery");
  // Soft default of one wallet — confirm if project already has one. This
  // pre-check stays on raw fetch because it's a discovery best-effort, not
  // a primary API call.
  try {
    const listRes = await fetch(`${API}/contracts/v1/wallets`, {
      headers: { Authorization: `Bearer ${p.service_key}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      const active = (list.wallets || []).filter((w) => w.status === "active");
      if (active.length >= 1 && !hasFlag(args, "--yes")) {
        console.error(`This project already has ${active.length} active wallet(s). Adding another costs $0.04/day each ($1.20/month). Re-run with --yes to confirm.`);
        process.exit(1);
      }
    }
  } catch { /* best-effort */ }

  try {
    const data = await getSdk().contracts.provisionWallet(projectId, {
      chain,
      recoveryAddress: recovery ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function getWallet(projectId, walletId) {
  try {
    const data = await getSdk().contracts.getWallet(projectId, walletId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function listWallets(projectId) {
  try {
    const data = await getSdk().contracts.listWallets(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setRecovery(projectId, walletId, args) {
  const clear = hasFlag(args, "--clear");
  const address = parseFlag(args, "--address");
  if (!clear && !address) {
    console.error(JSON.stringify({ status: "error", message: "Provide --address 0x... or --clear" }));
    process.exit(1);
  }
  try {
    await getSdk().contracts.setRecovery(projectId, walletId, clear ? null : address);
    console.log(JSON.stringify({ status: "ok", wallet_id: walletId, recovery_address: clear ? null : address }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setAlert(projectId, walletId, args) {
  const threshold = parseFlag(args, "--threshold-wei");
  if (!threshold) {
    console.error(JSON.stringify({ status: "error", message: "Missing --threshold-wei <n>" }));
    process.exit(1);
  }
  try {
    await getSdk().contracts.setLowBalanceAlert(projectId, walletId, threshold);
    console.log(JSON.stringify({ status: "ok", wallet_id: walletId, threshold_wei: threshold }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function call(projectId, walletId, args) {
  const to = parseFlag(args, "--to");
  const abi = parseFlag(args, "--abi");
  const fn = parseFlag(args, "--fn");
  const argsJson = parseFlag(args, "--args");
  const value = parseFlag(args, "--value-wei");
  const chain = parseFlag(args, "--chain") || "base-mainnet";
  const idempotency = parseFlag(args, "--idempotency-key");
  if (!to || !abi || !fn || !argsJson) {
    console.error(JSON.stringify({ status: "error", message: "Required flags: --to, --abi, --fn, --args. Cost: chain gas + $0.000005 KMS sign fee." }));
    process.exit(1);
  }
  try {
    const data = await getSdk().contracts.call(projectId, {
      walletId,
      chain,
      contractAddress: to,
      abiFragment: JSON.parse(abi),
      functionName: fn,
      args: JSON.parse(argsJson),
      value: value ?? undefined,
      idempotencyKey: idempotency ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function read(args) {
  const chain = parseFlag(args, "--chain");
  const to = parseFlag(args, "--to");
  const abi = parseFlag(args, "--abi");
  const fn = parseFlag(args, "--fn");
  const argsJson = parseFlag(args, "--args");
  if (!chain || !to || !abi || !fn || !argsJson) {
    console.error(JSON.stringify({ status: "error", message: "Required flags: --chain, --to, --abi, --fn, --args" }));
    process.exit(1);
  }
  try {
    const data = await getSdk().contracts.read({
      chain,
      contractAddress: to,
      abiFragment: JSON.parse(abi),
      functionName: fn,
      args: JSON.parse(argsJson),
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(projectId, callId) {
  try {
    const data = await getSdk().contracts.callStatus(projectId, callId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function drain(projectId, walletId, args) {
  const to = parseFlag(args, "--to");
  if (!to || !hasFlag(args, "--confirm")) {
    console.error(JSON.stringify({ status: "error", message: "Required: --to 0x... and --confirm. Cost: chain gas + $0.000005 KMS sign fee." }));
    process.exit(1);
  }
  try {
    const data = await getSdk().contracts.drain(projectId, walletId, to);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteWallet(projectId, walletId, args) {
  if (!hasFlag(args, "--confirm")) {
    console.error(JSON.stringify({ status: "error", message: "Required: --confirm" }));
    process.exit(1);
  }
  try {
    const data = await getSdk().contracts.deleteWallet(projectId, walletId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "provision-wallet": await provisionWallet(args[0], args.slice(1)); break;
    case "get-wallet":       await getWallet(args[0], args[1]); break;
    case "list-wallets":     await listWallets(args[0]); break;
    case "set-recovery":     await setRecovery(args[0], args[1], args.slice(2)); break;
    case "set-alert":        await setAlert(args[0], args[1], args.slice(2)); break;
    case "call":             await call(args[0], args[1], args.slice(2)); break;
    case "read":             await read(args); break;
    case "status":           await status(args[0], args[1]); break;
    case "drain":            await drain(args[0], args[1], args.slice(2)); break;
    case "delete":           await deleteWallet(args[0], args[1], args.slice(2)); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
