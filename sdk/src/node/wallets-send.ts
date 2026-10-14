/**
 * `r.wallets.send` (spec `wallet-signers`, "Wallets Send USDC From Themselves
 * Or From An Owned Smart Account"; `mpp-tempo-client-surface`, "Sending
 * pathUSD On Tempo"). Moves a stablecoin from the selected wallet, which may
 * be key-backed or KMS-backed:
 *
 *   - `base` / `base-sepolia`: USDC, from the wallet itself, or `from` a
 *     CoinbaseSmartWallet the wallet owns (one transaction from the wallet
 *     calling the smart account's `execute`); gas in ETH.
 *   - `tempo` / `tempo-moderato`: pathUSD from the wallet itself; Tempo has no
 *     gas token, so the fee is paid in pathUSD too.
 *
 * Without `confirm: true` it checks everything and returns a preview without
 * signing. A send reports success only once the transaction is mined
 * successfully; a revert is a failure carrying its hash.
 */
import type { Address, Chain, Hex, LocalAccount, Transport } from "viem";
import { LocalError } from "../errors.js";
import { PATH_USD, TEMPO_FEE_HEADROOM_USD_MICROS } from "./tempo.js";

export type SendNetwork = "base" | "base-sepolia" | "tempo" | "tempo-moderato";

export const SEND_NETWORKS: readonly SendNetwork[] = ["base", "base-sepolia", "tempo", "tempo-moderato"];

const TOKENS: Record<SendNetwork, { token: Address; asset: "USDC" | "pathUSD" }> = {
  base: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", asset: "USDC" },
  "base-sepolia": { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", asset: "USDC" },
  tempo: { token: PATH_USD, asset: "pathUSD" },
  "tempo-moderato": { token: PATH_USD, asset: "pathUSD" },
};

const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const SMART_WALLET_ABI = [
  { type: "function", name: "isOwnerAddress", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
] as const;

export interface SendOptions {
  /** Decimal amount of the network's stablecoin, at most 6 decimal places (e.g. "10", "0.5"). */
  amount: string;
  to: string;
  /** A CoinbaseSmartWallet the wallet owns, to send from instead of the wallet itself (Base only). */
  from?: string;
  network?: SendNetwork;
  /** Sign and send. Without it, the checks run and a preview is returned. */
  confirm?: boolean;
}

export interface SendPreview {
  preview: true;
  network: SendNetwork;
  asset: "USDC" | "pathUSD";
  amount_usd_micros: number;
  /** The address the money leaves. */
  from: string;
  to: string;
  /** The address that signs and pays the fee. */
  sender: string;
  balance_usd_micros: number;
  /** Gas units the send is estimated to use; null when the node could not estimate. */
  estimated_gas: number | null;
}

export interface SendResult {
  tx_hash: string;
  from: string;
  to: string;
  amount_usd_micros: number;
  network: SendNetwork;
  asset: "USDC" | "pathUSD";
  explorer_url: string;
}

const CONTEXT = "sending from a wallet";

function badInput(message: string, code: string, details: Record<string, unknown>): LocalError {
  return new LocalError(message, CONTEXT, { code, details, next_actions: [{ type: "edit_request", why: message }] });
}

/** "10.5" → 10_500_000n; refuses anything that is not a positive amount with at most 6 decimals. */
export function parseStablecoinAmount(amount: string): bigint {
  const text = typeof amount === "string" ? amount.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  const micros = match ? BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0") : 0n;
  if (!match || micros <= 0n) {
    throw badInput("The amount must be a positive number with at most 6 decimal places, e.g. 10 or 0.5.", "BAD_AMOUNT", { amount: text.slice(0, 32) });
  }
  return micros;
}

async function chainFor(network: SendNetwork): Promise<Chain> {
  const chains = await import("viem/chains");
  switch (network) {
    case "base": return chains.base;
    case "base-sepolia": return chains.baseSepolia;
    // Tempo pays fees in a TIP-20 stablecoin: name pathUSD so the fee comes from the same balance.
    case "tempo": return chains.tempo.extend({ feeToken: PATH_USD }) as Chain;
    case "tempo-moderato": return chains.tempoModerato.extend({ feeToken: PATH_USD }) as Chain;
  }
}

function insufficient(asset: string, address: string, needed: bigint, held: bigint, unit: "usd_micros" | "wei"): LocalError {
  const shortfall = needed - held;
  return new LocalError(
    `${address} holds too little ${asset} for this send: ${shortfall} ${unit === "wei" ? "wei" : "USD micros"} short.`,
    CONTEXT,
    {
      code: "SEND_INSUFFICIENT_BALANCE",
      details: unit === "wei"
        ? { asset, address, needed_wei: needed.toString(), held_wei: held.toString(), shortfall_wei: shortfall.toString() }
        : { asset, address, needed_usd_micros: Number(needed), held_usd_micros: Number(held), shortfall_usd_micros: Number(shortfall) },
      next_actions: [{ type: "fund_wallet", why: `Send ${asset} to ${address}, then retry.` }],
    },
  );
}

/** The CLI command for these options, as the sandbox refusal names it. */
export function sendCommand(opts: Partial<SendOptions>): string {
  const word = (v: unknown, placeholder: string): string =>
    typeof v === "string" && /^[A-Za-z0-9.x_-]+$/.test(v.trim()) ? v.trim() : placeholder;
  return [
    "run402 wallets send",
    word(opts.amount, "<amount>"),
    "--to", word(opts.to, "<address>"),
    ...(opts.from ? ["--from", word(opts.from, "<smart-account>")] : []),
    ...(opts.network && opts.network !== "base" ? ["--network", word(opts.network, "<network>")] : []),
  ].join(" ");
}

export interface SendDeps {
  /** Test seam: the RPC transport (default: the chain's public RPC). */
  transport?: Transport;
}

export async function sendFromWallet(account: LocalAccount, opts: SendOptions, deps: SendDeps = {}): Promise<SendPreview | SendResult> {
  const viem = await import("viem");
  const network = opts.network ?? "base";
  if (!SEND_NETWORKS.includes(network)) {
    throw badInput(`--network must be one of ${SEND_NETWORKS.join(", ")}.`, "BAD_NETWORK", { network: String(network).slice(0, 32) });
  }
  const amount = parseStablecoinAmount(opts.amount);
  if (typeof opts.to !== "string" || !viem.isAddress(opts.to, { strict: false })) {
    throw badInput("--to must be a 0x address.", "BAD_ADDRESS", { field: "to" });
  }
  const to = viem.getAddress(opts.to);
  const isTempo = network === "tempo" || network === "tempo-moderato";
  let from: Address | null = null;
  if (opts.from !== undefined) {
    if (isTempo) throw badInput("--from (a smart account) is supported on Base only.", "SEND_FROM_UNSUPPORTED", { network });
    if (!viem.isAddress(opts.from, { strict: false })) throw badInput("--from must be a 0x address.", "BAD_ADDRESS", { field: "from" });
    from = viem.getAddress(opts.from);
  }

  const chain = await chainFor(network);
  const transport = deps.transport ?? viem.http();
  const publicClient = viem.createPublicClient({ chain, transport });
  const { token, asset } = TOKENS[network];
  const sender = account.address;
  const payer = from ?? sender;

  if (from) {
    const owner = await publicClient.readContract({ address: from, abi: SMART_WALLET_ABI, functionName: "isOwnerAddress", args: [sender] });
    if (!owner) {
      throw new LocalError(`${sender} is not an owner of smart account ${from}.`, CONTEXT, {
        code: "SMART_ACCOUNT_NOT_OWNER",
        details: { smart_account: from, wallet: sender, network },
        next_actions: [{ type: "edit_request", why: "Select a wallet that owns this smart account with --wallet, or drop --from to send from the wallet itself." }],
      });
    }
  }

  const balance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [payer] });
  // On Tempo the fee comes out of the same pathUSD balance.
  const needed = isTempo ? amount + TEMPO_FEE_HEADROOM_USD_MICROS : amount;
  if (balance < needed) throw insufficient(asset, payer, needed, balance, "usd_micros");

  const transfer = viem.encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
  const call = from
    ? { address: from, abi: SMART_WALLET_ABI, functionName: "execute" as const, args: [token, 0n, transfer] as const }
    : { address: token, abi: ERC20_ABI, functionName: "transfer" as const, args: [to, amount] as const };

  let gas: bigint | null = null;
  try {
    gas = await publicClient.estimateContractGas({ ...(call as Parameters<typeof publicClient.estimateContractGas>[0]), account });
  } catch {
    gas = null;
  }
  if (!isTempo && gas !== null) {
    const { maxFeePerGas } = await publicClient.estimateFeesPerGas();
    const fee = gas * (maxFeePerGas ?? 0n);
    const eth = await publicClient.getBalance({ address: sender });
    if (eth < fee) throw insufficient("ETH", sender, fee, eth, "wei");
  }

  if (!opts.confirm) {
    return {
      preview: true,
      network,
      asset,
      amount_usd_micros: Number(amount),
      from: payer,
      to,
      sender,
      balance_usd_micros: Number(balance),
      estimated_gas: gas === null ? null : Number(gas),
    };
  }

  const walletClient = viem.createWalletClient({ account, chain, transport });
  const hash: Hex = await walletClient.writeContract({ ...(call as Parameters<typeof walletClient.writeContract>[0]), account, chain });
  const explorer = chain.blockExplorers?.default.url ?? "";
  const explorerUrl = explorer ? `${explorer.replace(/\/$/, "")}/tx/${hash}` : hash;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new LocalError(`The send transaction ${hash} reverted.`, CONTEXT, {
      code: "SEND_REVERTED",
      details: { tx_hash: hash, network, explorer_url: explorerUrl },
      next_actions: [{ type: "edit_request", why: "Inspect the transaction on the explorer before retrying." }],
    });
  }
  return { tx_hash: hash, from: payer, to, amount_usd_micros: Number(amount), network, asset, explorer_url: explorerUrl };
}
