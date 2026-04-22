import { findProject, API } from "./config.mjs";

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

Pricing:
  $0.04/day per wallet ($1.20/month). Creation requires $1.20 prepay
  (30 days of rent). Non-custodial — see terms.html#non-custodial-kms-wallets.

Examples:
  run402 contracts provision-wallet proj_abc --chain base-mainnet
  run402 contracts provision-wallet proj_abc --chain base-sepolia --recovery 0xAbC...
`,
  "set-recovery": `run402 contracts set-recovery — Set or clear the wallet recovery address

Usage:
  run402 contracts set-recovery <project_id> <wallet_id> [options]

Arguments:
  <project_id>        Target project ID
  <wallet_id>         KMS wallet ID (cwlt_...)

Options:
  --address 0x...     New recovery address
  --clear             Clear the recovery address (mutually exclusive with --address)

Examples:
  run402 contracts set-recovery proj_abc cwlt_xyz --address 0xAbC...
  run402 contracts set-recovery proj_abc cwlt_xyz --clear
`,
  "set-alert": `run402 contracts set-alert — Set the low-balance alert threshold

Usage:
  run402 contracts set-alert <project_id> <wallet_id> --threshold-wei <n>

Arguments:
  <project_id>        Target project ID
  <wallet_id>         KMS wallet ID (cwlt_...)

Options:
  --threshold-wei <n> Required: alert threshold in wei

Examples:
  run402 contracts set-alert proj_abc cwlt_xyz --threshold-wei 1000000000000000
`,
  call: `run402 contracts call — Submit a contract write call

Usage:
  run402 contracts call <project_id> <wallet_id> --to 0x... --abi <json>
    --fn <name> --args <json> [options]

Arguments:
  <project_id>        Target project ID
  <wallet_id>         KMS wallet ID (cwlt_...)

Options:
  --to 0x...          Required: contract address
  --abi <json>        Required: ABI fragment (JSON string)
  --fn <name>         Required: function name to invoke
  --args <json>       Required: function args (JSON array)
  --value-wei <n>     Native value to send (default 0)
  --chain <chain>     Chain override (default: base-mainnet)
  --idempotency-key <k>  Idempotency key for safe retries

Pricing:
  Chain gas + $0.000005 KMS sign fee per call.

Examples:
  run402 contracts call proj_abc cwlt_xyz --to 0x1234... \\
    --abi '[{"type":"function","name":"ping","inputs":[],"outputs":[]}]' \\
    --fn ping --args '[]'
`,
  read: `run402 contracts read — Read-only contract call (free)

Usage:
  run402 contracts read --chain <chain> --to 0x... --abi <json>
    --fn <name> --args <json>

Options:
  --chain <chain>     Required: base-mainnet or base-sepolia
  --to 0x...          Required: contract address
  --abi <json>        Required: ABI fragment (JSON string)
  --fn <name>         Required: function name to invoke
  --args <json>       Required: function args (JSON array)

Examples:
  run402 contracts read --chain base-mainnet --to 0x1234... \\
    --abi '[{"type":"function","name":"balanceOf","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]}]' \\
    --fn balanceOf --args '["0xAbC..."]'
`,
  drain: `run402 contracts drain — Drain native balance to a destination address

Usage:
  run402 contracts drain <project_id> <wallet_id> --to 0x... --confirm

Arguments:
  <project_id>        Target project ID
  <wallet_id>         KMS wallet ID (cwlt_...)

Options:
  --to 0x...          Required: destination address
  --confirm           Required: explicit confirmation flag

Notes:
  Works on suspended wallets. Cost: chain gas + $0.000005 KMS sign fee.

Examples:
  run402 contracts drain proj_abc cwlt_xyz --to 0xAbC... --confirm
`,
  delete: `run402 contracts delete — Schedule the KMS key for deletion

Usage:
  run402 contracts delete <project_id> <wallet_id> --confirm

Arguments:
  <project_id>        Target project ID
  <wallet_id>         KMS wallet ID (cwlt_...)

Options:
  --confirm           Required: explicit confirmation flag

Notes:
  Refused if wallet balance is greater than or equal to dust. Drain first.

Examples:
  run402 contracts delete proj_abc cwlt_xyz --confirm
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
  // Soft default of one wallet — confirm if project already has one
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
  const body = { chain };
  if (recovery) body.recovery_address = recovery;
  const res = await fetch(`${API}/contracts/v1/wallets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function getWallet(projectId, walletId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/contracts/v1/wallets/${encodeURIComponent(walletId)}`, {
    headers: { Authorization: `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function listWallets(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/contracts/v1/wallets`, {
    headers: { Authorization: `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function setRecovery(projectId, walletId, args) {
  const p = findProject(projectId);
  const clear = hasFlag(args, "--clear");
  const address = parseFlag(args, "--address");
  if (!clear && !address) {
    console.error(JSON.stringify({ status: "error", message: "Provide --address 0x... or --clear" }));
    process.exit(1);
  }
  const body = { recovery_address: clear ? null : address };
  const res = await fetch(`${API}/contracts/v1/wallets/${encodeURIComponent(walletId)}/recovery-address`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function setAlert(projectId, walletId, args) {
  const p = findProject(projectId);
  const threshold = parseFlag(args, "--threshold-wei");
  if (!threshold) {
    console.error(JSON.stringify({ status: "error", message: "Missing --threshold-wei <n>" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/contracts/v1/wallets/${encodeURIComponent(walletId)}/alert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ threshold_wei: threshold }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function call(projectId, walletId, args) {
  const p = findProject(projectId);
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
  const body = {
    wallet_id: walletId,
    chain,
    contract_address: to,
    abi_fragment: JSON.parse(abi),
    function_name: fn,
    args: JSON.parse(argsJson),
  };
  if (value) body.value = value;
  const headers = { Authorization: `Bearer ${p.service_key}`, "Content-Type": "application/json" };
  if (idempotency) headers["Idempotency-Key"] = idempotency;
  const res = await fetch(`${API}/contracts/v1/call`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
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
  const res = await fetch(`${API}/contracts/v1/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chain,
      contract_address: to,
      abi_fragment: JSON.parse(abi),
      function_name: fn,
      args: JSON.parse(argsJson),
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function status(projectId, callId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/contracts/v1/calls/${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function drain(projectId, walletId, args) {
  const p = findProject(projectId);
  const to = parseFlag(args, "--to");
  if (!to || !hasFlag(args, "--confirm")) {
    console.error(JSON.stringify({ status: "error", message: "Required: --to 0x... and --confirm. Cost: chain gas + $0.000005 KMS sign fee." }));
    process.exit(1);
  }
  const res = await fetch(`${API}/contracts/v1/wallets/${encodeURIComponent(walletId)}/drain`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${p.service_key}`,
      "Content-Type": "application/json",
      "X-Confirm-Drain": walletId,
    },
    body: JSON.stringify({ destination_address: to }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteWallet(projectId, walletId, args) {
  const p = findProject(projectId);
  if (!hasFlag(args, "--confirm")) {
    console.error(JSON.stringify({ status: "error", message: "Required: --confirm" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/contracts/v1/wallets/${encodeURIComponent(walletId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${p.service_key}`,
      "X-Confirm-Delete": walletId,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
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
