import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import {
  assertAllowedValue,
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  positionalArgs,
  validateEvmAddress,
} from "./argparse.mjs";

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
  "get-wallet": `run402 contracts get-wallet — Get wallet metadata + live balance

Usage:
  run402 contracts get-wallet <project_id> <wallet_id>

Arguments:
  <project_id>        Project ID that owns the wallet
  <wallet_id>         Wallet ID (e.g. cwlt_abc123)

Examples:
  run402 contracts get-wallet prj_abc123 cwlt_abc123
`,
  "list-wallets": `run402 contracts list-wallets — List all KMS wallets for a project

Usage:
  run402 contracts list-wallets <project_id>

Arguments:
  <project_id>        Project ID to list wallets for

Notes:
  - Includes deleted wallets

Examples:
  run402 contracts list-wallets prj_abc123
`,
  status: `run402 contracts status — Get a contract call's status and receipt

Usage:
  run402 contracts status <project_id> <call_id>

Arguments:
  <project_id>        Project ID that submitted the call
  <call_id>           Contract call ID returned from 'contracts call'

Notes:
  - Returns status, gas used, gas cost (USD-micros), and receipt

Examples:
  run402 contracts status prj_abc123 ccall_abc123
`,
};

function hasFlag(args, flag) {
  return args.includes(flag);
}
function validateWeiFlag(flag, value) {
  if (!/^\d+$/.test(String(value))) {
    fail({
      code: "BAD_FLAG",
      message: `${flag} must be a decimal non-negative integer string in wei`,
      details: { flag, value: String(value) },
    });
  }
}

async function provisionWallet(projectId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--chain", "--recovery"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--yes", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts provision-wallet: ${extra[0]}` });
  }
  const chain = flagValue(parsedArgs, "--chain");
  if (!chain) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --chain (base-mainnet or base-sepolia)",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  const recovery = flagValue(parsedArgs, "--recovery");
  if (recovery) validateEvmAddress(recovery, "--recovery");
  // Soft default of one wallet — confirm if project already has one.
  let activeWallets = null;
  try {
    const list = await getSdk().contracts.listWallets(projectId);
    activeWallets = (list.wallets || []).filter((w) => w.status === "active").length;
  } catch { /* best-effort */ }
  if (activeWallets !== null && activeWallets >= 1 && !hasFlag(parsedArgs, "--yes")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `This project already has ${activeWallets} active wallet(s). Adding another costs $0.04/day each ($1.20/month). Re-run with --yes to confirm.`,
      details: { active_wallets: activeWallets },
    });
  }

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

async function getWallet(projectId, walletId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts get-wallet: ${extra[0]}` });
  }
  try {
    const data = await getSdk().contracts.getWallet(projectId, walletId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function listWallets(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts list-wallets: ${extra[0]}` });
  }
  try {
    const data = await getSdk().contracts.listWallets(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setRecovery(projectId, walletId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--address"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--clear", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts set-recovery: ${extra[0]}` });
  }
  const clear = hasFlag(parsedArgs, "--clear");
  const address = flagValue(parsedArgs, "--address");
  if (clear && address) {
    fail({ code: "BAD_USAGE", message: "Provide either --address or --clear, not both." });
  }
  if (!clear && !address) {
    fail({
      code: "BAD_USAGE",
      message: "Provide --address 0x... or --clear",
    });
  }
  if (address) validateEvmAddress(address, "--address");
  try {
    await getSdk().contracts.setRecovery(projectId, walletId, clear ? null : address);
    console.log(JSON.stringify({ status: "ok", wallet_id: walletId, recovery_address: clear ? null : address }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setAlert(projectId, walletId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--threshold-wei"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts set-alert: ${extra[0]}` });
  }
  const threshold = flagValue(parsedArgs, "--threshold-wei");
  if (!threshold) {
    fail({ code: "BAD_USAGE", message: "Missing --threshold-wei <n>" });
  }
  validateWeiFlag("--threshold-wei", threshold);
  try {
    await getSdk().contracts.setLowBalanceAlert(projectId, walletId, threshold);
    console.log(JSON.stringify({ status: "ok", wallet_id: walletId, threshold_wei: threshold }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function call(projectId, walletId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--to", "--abi", "--fn", "--args", "--value-wei", "--chain", "--idempotency-key"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts call: ${extra[0]}` });
  }
  const to = flagValue(parsedArgs, "--to");
  const abi = flagValue(parsedArgs, "--abi");
  const fn = flagValue(parsedArgs, "--fn");
  const argsJson = flagValue(parsedArgs, "--args");
  const value = flagValue(parsedArgs, "--value-wei");
  const chain = flagValue(parsedArgs, "--chain") || "base-mainnet";
  const idempotency = flagValue(parsedArgs, "--idempotency-key");
  if (!to || !abi || !fn || !argsJson) {
    fail({
      code: "BAD_USAGE",
      message: "Required flags: --to, --abi, --fn, --args.",
      hint: "Cost: chain gas + $0.000005 KMS sign fee.",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  if (value !== null) validateWeiFlag("--value-wei", value);
  const abiFragment = parseFlagJson("--abi", abi);
  const callArgs = parseFlagJson("--args", argsJson);
  validateEvmAddress(to, "--to");
  try {
    const data = await getSdk().contracts.call(projectId, {
      walletId,
      chain,
      contractAddress: to,
      abiFragment,
      functionName: fn,
      args: callArgs,
      value: value ?? undefined,
      idempotencyKey: idempotency ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function read(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--chain", "--to", "--abi", "--fn", "--args"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts read: ${extra[0]}` });
  }
  const chain = flagValue(parsedArgs, "--chain");
  const to = flagValue(parsedArgs, "--to");
  const abi = flagValue(parsedArgs, "--abi");
  const fn = flagValue(parsedArgs, "--fn");
  const argsJson = flagValue(parsedArgs, "--args");
  if (!chain || !to || !abi || !fn || !argsJson) {
    fail({
      code: "BAD_USAGE",
      message: "Required flags: --chain, --to, --abi, --fn, --args",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  const abiFragment = parseFlagJson("--abi", abi);
  const callArgs = parseFlagJson("--args", argsJson);
  validateEvmAddress(to, "--to");
  try {
    const data = await getSdk().contracts.read({
      chain,
      contractAddress: to,
      abiFragment,
      functionName: fn,
      args: callArgs,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(projectId, callId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts status: ${extra[0]}` });
  }
  try {
    const data = await getSdk().contracts.callStatus(projectId, callId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function drain(projectId, walletId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--to"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--confirm", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts drain: ${extra[0]}` });
  }
  const to = flagValue(parsedArgs, "--to");
  if (!to || !hasFlag(parsedArgs, "--confirm")) {
    fail({
      code: "BAD_USAGE",
      message: "Required: --to 0x... and --confirm.",
      hint: "Cost: chain gas + $0.000005 KMS sign fee.",
    });
  }
  validateEvmAddress(to, "--to");
  try {
    const data = await getSdk().contracts.drain(projectId, walletId, to);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteWallet(projectId, walletId, args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--confirm", "--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts delete: ${extra[0]}` });
  }
  if (!hasFlag(parsedArgs, "--confirm")) {
    fail({ code: "BAD_USAGE", message: "Required: --confirm" });
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
    case "get-wallet":       await getWallet(args[0], args[1], args.slice(2)); break;
    case "list-wallets":     await listWallets(args[0], args.slice(1)); break;
    case "set-recovery":     await setRecovery(args[0], args[1], args.slice(2)); break;
    case "set-alert":        await setAlert(args[0], args[1], args.slice(2)); break;
    case "call":             await call(args[0], args[1], args.slice(2)); break;
    case "read":             await read(args); break;
    case "status":           await status(args[0], args[1], args.slice(2)); break;
    case "drain":            await drain(args[0], args[1], args.slice(2)); break;
    case "delete":           await deleteWallet(args[0], args[1], args.slice(2)); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
