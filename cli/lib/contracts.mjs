import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail, parseFlagJson } from "./sdk-errors.mjs";
import {
  assertAllowedValue,
  assertKnownFlags,
  flagValue,
  normalizeArgv,
  positionalArgs,
  resolveProjectSelector,
  validateEvmAddress,
  failUnknownSubcommand,
} from "./argparse.mjs";

const HELP = `run402 contracts — signers, your app's wallet, for smart-contract calls

  Pricing: $0.04/day per signer ($1.20/month) plus $0.000005 per contract call.
  Signer creation requires $1.20 of allowance (30 days of rent).
  Non-custodial: see https://run402.com/humans/terms.html#non-custodial-kms-wallets

Usage:
  run402 contracts <subcommand> [args...]

Subcommands:
  provision-signer <project_id> --chain <base-mainnet|base-sepolia> [--recovery 0x...]
    Provision a signer ($0.04/day wallet rent, requires $1.20 prepay).
  get-signer <project_id> <signer_id>
    Get signer metadata + live native balance.
  list-signers <project_id>
    List all signers for the project (includes deleted).
  transfers create <signer_id> --to 0x... --amount <base units> [--asset usdc] [--chain <base-mainnet|base-sepolia>] [--idempotency-key <k>]
    Send a token from the signer with no gas on it: the platform's facilitator settles the signed EIP-3009 authorization and pays the gas. One signing fee.
  transfers get <signer_id> --transfer <transfer_id>
    Read one transfer (status, tx hash, nonce, failure phase).
  transfers list <signer_id>
    The signer's transfers, newest first.
  set-recovery <project_id> <signer_id> [--address 0x... | --clear]
    Set/clear the optional recovery address.
  set-alert <project_id> <signer_id> --threshold-wei <n>
    Set the low-balance alert threshold (in wei).
  call <project_id> <signer_id> --to 0x... --abi <json> --fn <name> --args <json> [--value-wei <n>] [--idempotency-key <k>]
    Submit a contract write call (gas from the signer's balance, topped up at cost when short, + $0.000005 signing fee).
  deploy <project_id> <signer_id> --bytecode 0x... [--chain <base-mainnet|base-sepolia>] [--value-wei <n>] [--idempotency-key <k>]
    Deploy a contract (gas from the signer's balance + $0.000005 signing fee). Returns deterministic CREATE address synchronously.
  read --chain <chain> --to 0x... --abi <json> --fn <name> --args <json>
    Read-only contract call (free).
  status <project_id> <call_id>
    Get call status, gas used, gas cost USD-micros, receipt.
  drain <project_id> <signer_id> --to 0x... --confirm
    Drain native balance to a destination address. Works on suspended signers.
  delete <project_id> <signer_id> --confirm
    Schedule the signing key for deletion (refused if balance >= dust).

Examples:
  run402 contracts provision-signer proj_abc --chain base-mainnet
  run402 contracts call proj_abc cwlt_xyz --to 0x1234... --abi '[{"type":"function","name":"ping","inputs":[],"outputs":[]}]' --fn ping --args '[]'
`;

const SUB_HELP = {
  transfers: `run402 contracts transfers — Send a token from a signer with no gas on it

Usage:
  run402 contracts transfers create <signer_id> --to 0x... --amount <base units> [--asset usdc] [--chain <base-mainnet|base-sepolia>] [--idempotency-key <k>] [--project <project_id>]
  run402 contracts transfers get <signer_id> --transfer <transfer_id> [--project <project_id>]
  run402 contracts transfers list <signer_id> [--project <project_id>]

The signer is the payer of an x402 payment: Run402 signs the token's EIP-3009
authorization with the signer's key and its facilitator settles it and pays the
gas. One $0.000005 signing fee, no gas, no ETH on the signer. --amount is in the
asset's base units (USDC: 6 decimals; 100000 is $0.10). An idempotency key
makes a repeat return the transfer already made; a transfer that failed before
settlement re-executes under its key, one that died in settlement never does.
A "unknown" status means the settle outcome never came back: poll it with get.
`,
  "provision-signer": `run402 contracts provision-signer — Provision a signer

Usage:
  run402 contracts provision-signer --chain <chain> [--project <project_id>] [options]

Legacy (still supported):
  run402 contracts provision-signer <project_id> --chain <chain> [options]

Arguments:
  <project_id>        Target project ID

Options:
  --chain <chain>     Required: base-mainnet or base-sepolia
  --recovery 0x...    Optional recovery address (can be set later)
  --yes               Skip confirmation when project already has a signer
`,
  "set-recovery": `run402 contracts set-recovery — Set or clear the signer recovery address

Usage:
  run402 contracts set-recovery <signer_id> [--project <project_id>] [options]

Legacy (still supported):
  run402 contracts set-recovery <project_id> <signer_id> [options]
`,
  "set-alert": `run402 contracts set-alert — Set the low-balance alert threshold

Usage:
  run402 contracts set-alert <signer_id> --threshold-wei <n> [--project <project_id>]

Legacy (still supported):
  run402 contracts set-alert <project_id> <signer_id> --threshold-wei <n>
`,
  call: `run402 contracts call — Submit a contract write call

Usage:
  run402 contracts call <signer_id> --to 0x... --abi <json> [--project <project_id>]

Legacy (still supported):
  run402 contracts call <project_id> <signer_id> --to 0x... --abi <json>
    --fn <name> --args <json> [options]
`,
  deploy: `run402 contracts deploy — Deploy a smart contract from a signer

the platform's key custody-signs a contract-creation transaction (to: null + data: bytecode) and broadcasts.
Returns the deterministic CREATE address synchronously — known from (signer, nonce)
before the tx confirms. Cost: chain gas at-cost + $0.000005 signing fee.

Usage:
  run402 contracts deploy <signer_id> --bytecode 0x... [--project <project_id>] [options]

Legacy (still supported):
  run402 contracts deploy <project_id> <signer_id> --bytecode 0x... [options]

Options:
  --bytecode 0x...        Full creation calldata as 0x-prefixed hex (creation
                          bytecode + ABI-encoded constructor args, concatenated
                          client-side via viem/ethers). Required. ≤ 128 KB.
  --chain <chain>         base-mainnet (default) or base-sepolia. Must match
                          the signer's chain.
  --value-wei <n>         Optional native-token value in wei to attach.
  --idempotency-key <k>   Optional. Same key + same bytecode returns the
                          existing call without re-broadcasting.

run402 does NOT compile Solidity — bring your own bytecode (compile via
hardhat/foundry/solc then concat constructor args via viem/ethers).
`,
  read: `run402 contracts read — Read-only contract call (free)

Usage:
  run402 contracts read --chain <chain> --to 0x... --abi <json>
    --fn <name> --args <json>
`,
  drain: `run402 contracts drain — Drain native balance to a destination address

Usage:
  run402 contracts drain <signer_id> --to 0x... --confirm [--project <project_id>]

Legacy (still supported):
  run402 contracts drain <project_id> <signer_id> --to 0x... --confirm
`,
  delete: `run402 contracts delete — Schedule the signing key for deletion

Usage:
  run402 contracts delete <signer_id> --confirm [--project <project_id>]

Legacy (still supported):
  run402 contracts delete <project_id> <signer_id> --confirm
`,
  "get-signer": `run402 contracts get-signer — Get signer metadata + live balance

Usage:
  run402 contracts get-signer <signer_id> [--project <project_id>]

Legacy (still supported):
  run402 contracts get-signer <project_id> <signer_id>

Arguments:
  <project_id>        Project ID that owns the signer
  <signer_id>         Signer ID (e.g. cwlt_abc123)

Examples:
  run402 contracts get-signer prj_abc123 cwlt_abc123
`,
  "list-signers": `run402 contracts list-signers — List all signers for a project

Usage:
  run402 contracts list-signers [--project <project_id>]

Legacy (still supported):
  run402 contracts list-signers <project_id>

Arguments:
  <project_id>        Project ID to list signers for

Notes:
  - Includes deleted signers

Examples:
  run402 contracts list-signers prj_abc123
`,
  status: `run402 contracts status — Get a contract call's status and receipt

Usage:
  run402 contracts status <call_id> [--project <project_id>]

Legacy (still supported):
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

async function provisionSigner(projectId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--chain", "--recovery"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--yes", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts provision-signer: ${extra[0]}` });
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
  // Soft default of one signer — confirm if project already has one.
  let activeSigners = null;
  try {
    const list = await getSdk().contracts.listSigners(projectId);
    activeSigners = (list.signers || []).filter((s) => s.status === "active").length;
  } catch { /* best-effort */ }
  if (activeSigners !== null && activeSigners >= 1 && !hasFlag(parsedArgs, "--yes")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `This project already has ${activeSigners} active signer(s). Adding another costs $0.04/day each ($1.20/month). Re-run with --yes to confirm.`,
      details: { active_signers: activeSigners },
    });
  }

  try {
    const data = await getSdk().contracts.provisionSigner(projectId, {
      chain,
      recoveryAddress: recovery ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function getSigner(projectId, signerId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts get-signer: ${extra[0]}` });
  }
  try {
    const data = await getSdk().contracts.getSigner(projectId, signerId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function listSigners(projectId, args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts list-signers: ${extra[0]}` });
  }
  try {
    const data = await getSdk().contracts.listSigners(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setRecovery(projectId, signerId, args) {
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
    await getSdk().contracts.setRecovery(projectId, signerId, clear ? null : address);
    console.log(JSON.stringify({ signer_id: signerId, recovery_address: clear ? null : address, updated: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setAlert(projectId, signerId, args) {
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
    await getSdk().contracts.setLowBalanceAlert(projectId, signerId, threshold);
    console.log(JSON.stringify({ signer_id: signerId, threshold_wei: threshold, updated: true }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function call(projectId, signerId, args) {
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
      hint: "Cost: chain gas + $0.000005 signing fee.",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  if (value !== null) validateWeiFlag("--value-wei", value);
  const abiFragment = parseFlagJson("--abi", abi);
  const callArgs = parseFlagJson("--args", argsJson);
  validateEvmAddress(to, "--to");
  try {
    const data = await getSdk().contracts.call(projectId, {
      signerId,
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

/**
 * `run402 contracts transfers create|get|list` — a signer sends a token with
 * no gas on it: the gateway signs the EIP-3009 authorization with the
 * signer's key and the platform's facilitator settles it and pays the gas.
 */
async function transfers(projectId, args) {
  const [transferAction, ...rest] = Array.isArray(args) ? args : [];
  if (transferAction === "create") return transfersCreate(projectId, rest[0], rest.slice(1));
  if (transferAction === "get") return transfersGet(projectId, rest[0], rest.slice(1));
  if (transferAction === "list") return transfersList(projectId, rest[0], rest.slice(1));
  return fail({
    code: "BAD_USAGE",
    message: `Unknown contracts transfers verb: ${transferAction ?? "(none)"}`,
    hint: "Verbs: create <signer_id> --to 0x… --amount <base units> [--asset usdc] [--chain …] [--idempotency-key <k>]; get <signer_id> --transfer <transfer_id>; list <signer_id>.",
  });
}

async function transfersCreate(projectId, signerId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--to", "--amount", "--asset", "--chain", "--idempotency-key"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (!signerId || !/^[a-z]+_[A-Za-z0-9]{8,}$/.test(signerId)) {
    fail({ code: "BAD_USAGE", message: "Missing <signer_id>.", hint: "run402 contracts transfers create <signer_id> --to 0x… --amount <base units>" });
  }
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts transfers create: ${extra[0]}` });
  }
  const to = flagValue(parsedArgs, "--to");
  const amount = flagValue(parsedArgs, "--amount");
  const asset = flagValue(parsedArgs, "--asset") || "usdc";
  const chain = flagValue(parsedArgs, "--chain") || "base-mainnet";
  const idempotency = flagValue(parsedArgs, "--idempotency-key");
  if (!to || !amount) {
    fail({
      code: "BAD_USAGE",
      message: "Required flags: --to, --amount.",
      hint: "--amount is in the asset's base units as a decimal string (USDC: 6 decimals, so 100000 is $0.10). Cost: one $0.000005 signing fee, no gas.",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  validateEvmAddress(to, "--to");
  if (!/^[1-9][0-9]*$/.test(amount)) {
    fail({ code: "BAD_USAGE", message: "--amount must be a positive integer in the asset's base units." });
  }
  try {
    const data = await getSdk().contracts.transfer(projectId, {
      signerId, chain, asset, to, amount, idempotencyKey: idempotency ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function transfersGet(projectId, signerId, args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--transfer", "--help", "-h"], ["--transfer"]);
  const extra = positionalArgs(parsedArgs, ["--transfer"]);
  const transferId = flagValue(parsedArgs, "--transfer");
  if (!signerId || !transferId || extra.length > 0) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 contracts transfers get <signer_id> --transfer <transfer_id>" });
  }
  try {
    console.log(JSON.stringify(await getSdk().contracts.transferStatus(projectId, signerId, transferId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function transfersList(projectId, signerId, args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"], []);
  if (!signerId) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 contracts transfers list <signer_id>" });
  }
  try {
    console.log(JSON.stringify(await getSdk().contracts.listTransfers(projectId, signerId), null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deploy(projectId, signerId, args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--bytecode", "--value-wei", "--chain", "--idempotency-key"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for contracts deploy: ${extra[0]}` });
  }
  const bytecode = flagValue(parsedArgs, "--bytecode");
  const value = flagValue(parsedArgs, "--value-wei");
  const chain = flagValue(parsedArgs, "--chain") || "base-mainnet";
  const idempotency = flagValue(parsedArgs, "--idempotency-key");
  if (!bytecode) {
    fail({
      code: "BAD_USAGE",
      message: "Required flag: --bytecode (0x-prefixed hex; full creation calldata = creation bytecode + ABI-encoded constructor args, concatenated client-side).",
      hint: "Cost: chain gas + $0.000005 signing fee. Returns deterministic CREATE address synchronously.",
    });
  }
  assertAllowedValue(chain, ["base-mainnet", "base-sepolia"], "--chain");
  if (value !== null) validateWeiFlag("--value-wei", value);
  try {
    const data = await getSdk().contracts.deploy(projectId, {
      signerId,
      chain,
      bytecode,
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

async function drain(projectId, signerId, args) {
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
      hint: "Cost: chain gas + $0.000005 signing fee.",
    });
  }
  validateEvmAddress(to, "--to");
  try {
    const data = await getSdk().contracts.drain(projectId, signerId, to);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteSigner(projectId, signerId, args) {
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
    const data = await getSdk().contracts.deleteSigner(projectId, signerId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  // Project selection (CLI-wide convention): `--project <project_id>` wins, else a
  // legacy leading `prj_...` positional, else the active project. The signer /
  // call id stays positional (`cwlt_...` / `ccall_...`). Computed lazily so
  // unknown subcommands (and the anonymous `read`) never trip project
  // resolution.
  const select = () => resolveProjectSelector(normalizeArgv(Array.isArray(args) ? args : []));
  // The transfers group dispatches with `if` (not `case`) so the sync test
  // inventories its leaf actions through parseContractsTransferActions.
  if (sub === "transfers") {
    const { projectId, rest } = select();
    await transfers(projectId, rest);
    return;
  }
  switch (sub) {
    case "provision-signer": { const { projectId, rest } = select(); await provisionSigner(projectId, rest); break; }
    case "get-signer":       { const { projectId, rest } = select(); await getSigner(projectId, rest[0], rest.slice(1)); break; }
    case "list-signers":     { const { projectId, rest } = select(); await listSigners(projectId, rest); break; }
    case "set-recovery":     { const { projectId, rest } = select(); await setRecovery(projectId, rest[0], rest.slice(1)); break; }
    case "set-alert":        { const { projectId, rest } = select(); await setAlert(projectId, rest[0], rest.slice(1)); break; }
    case "call":             { const { projectId, rest } = select(); await call(projectId, rest[0], rest.slice(1)); break; }
    case "deploy":           { const { projectId, rest } = select(); await deploy(projectId, rest[0], rest.slice(1)); break; }
    case "read":             await read(args); break;
    case "status":           { const { projectId, rest } = select(); await status(projectId, rest[0], rest.slice(1)); break; }
    case "drain":            { const { projectId, rest } = select(); await drain(projectId, rest[0], rest.slice(1)); break; }
    case "delete":           { const { projectId, rest } = select(); await deleteSigner(projectId, rest[0], rest.slice(1)); break; }
    default:
      failUnknownSubcommand("contracts", sub);
  }
}
