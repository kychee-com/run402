/**
 * `r.init()` — set up this machine for Run402, owned by the Node SDK: the
 * config directory, the active profile's wallet on its payment rail, testnet
 * funding, an optional promo voucher, the Lightning wallet, the tier read,
 * the local project count, the vault git remote, the organization, and the
 * one next action. Idempotent when re-run on the same rail; switching rails
 * needs `switchRail`.
 *
 * `r.init({ apiBase })` instead configures the active profile to talk to a
 * Run402 Core (or another) API base and returns without touching a wallet.
 *
 * Progress lines (Config / Wallet / Balance / Tier / Next …) go to `onLine`,
 * never to stdout; the returned summary is the structured answer.
 * `run402 init` is a shim over this.
 */

import { mkdirSync } from "node:fs";
import { configureApiBase, getActiveProfile, getConfigDir } from "../../core-dist/config.js";
import { saveWallet, type WalletData } from "../../core-dist/wallet.js";
import { readLocalWallet } from "./wallets.js";
import { getActiveProjectId, loadKeyStore } from "../../core-dist/keystore.js";
import { readMeta } from "../../core-dist/profiles.js";
import { LocalError, type NextAction } from "../errors.js";
import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import type { Run402 } from "../index.js";
import { fundingBlocksBootstrap, fundingRecovery, type FundingRecovery } from "./funding-recovery.js";
import { deployAction, upDeployAction } from "./local-actions.js";
import { describeLightning, ensureLightningWallet, readLightningBalance } from "./lightning-wallet.js";
import { hardenedGit } from "./vault-snapshot.js";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

export type InitRail = "x402" | "mpp" | "lightning";

export interface InitOptions {
  /** Payment rail. Default `x402`. */
  rail?: InitRail;
  /** Confirm switching the persisted rail when a wallet already exists on another. */
  switchRail?: boolean;
  /** Redeem this promo code into the organization's allowance; never fails init. */
  voucher?: string | null;
  /** Also `git init` the working directory when it is not a repository yet. */
  gitRemote?: boolean;
  /** Set this principal's display name. */
  name?: string;
  /**
   * Configure the active profile to use this API base (a self-hosted Run402
   * Core Gateway, say) and return; no wallet is touched.
   */
  apiBase?: string | null;
  /** Directory the vault remote is scaffolded in. Default `process.cwd()`. */
  cwd?: string;
  /** Environment `RUN402_PROJECT_ID` is read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Receives each human progress line. */
  onLine?: (line: string) => void;
}

export interface InitWalletSummary {
  local_label: string;
  server_label: string | null;
  address: string;
}

/** The summary `run402 init` prints. Fields appear exactly as the CLI has always emitted them. */
export interface InitSummary {
  config_dir: string;
  wallet: InitWalletSummary | null;
  rail: InitRail | null;
  network: string | null;
  balances: {
    on_chain_usd_micros: number;
    on_chain_token: "USDC" | "pathUSD";
    allowance_usd_micros: number | null;
    held_usd_micros: number | null;
  } | null;
  voucher?: {
    voucher_id: string;
    amount_usd_micros: number;
    already_redeemed: boolean;
    next_actions: Array<Record<string, unknown>>;
  } | null;
  voucher_error?: { code: string; message: string };
  tier: { name: string; expires: string | null } | null;
  projects_saved: number;
  active_project_id: string | null;
  next_actions: NextAction[];
  next_step: string | null;
  lightning?: Record<string, unknown> | null;
  vault?: Record<string, unknown> | null;
  vault_skipped?: string;
  vault_error?: { code: string; message: string };
  orgs?: Array<{ org_id: string; display_name: string | null; role: string | null }> | null;
  funding?: FundingRecovery | null;
  display_name?: string | null;
  display_name_error?: { code: string; message: string };
  [key: string]: unknown;
}

/** The summary of `r.init({ apiBase })`. */
export interface InitTargetSummary {
  config_dir: string;
  api_base: string;
  api_base_source: "profile";
  target: { kind: string; health_status?: string; health_error?: string };
  payment_required: boolean;
  next_actions: NextAction[];
  next_step: string;
}

/** Builds a client for an API base other than the configured one (the target health probe). */
export type InitClientFactory = (opts: { apiBase: string; disablePaidFetch: true; authMode: "none" }) => Pick<Run402, "service">;

type TierFacts = { tier?: string | null; active?: boolean; lease_expires_at?: string | null };

/** The slice of the Node client init drives. */
export type InitSdk = Pick<Run402, "wallets" | "vouchers" | "billing" | "agent" | "tier" | "repos"> & {
  orgs: Pick<Run402["orgs"], "list" | "setDisplayName"> & { owningOrgOf(projectId: string): Promise<string | null> };
};

function short(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  const body = (err as { body?: unknown })?.body;
  if (body && typeof body === "object") {
    const b = body as { message?: string; error?: string };
    return b.message || b.error || (err as Error).message;
  }
  return (err as Error)?.message || String(err);
}

function errorCode(err: unknown, fallback: string): string {
  return (err as { body?: { code?: string } })?.body?.code ?? (err as { code?: string })?.code ?? fallback;
}

/**
 * Which project the vault scaffold acts on: `RUN402_PROJECT_ID`, then the
 * active project — and, when neither, why nothing was done, stated.
 */
export function resolveScaffoldProject(
  env: Record<string, string | undefined> = process.env,
  activeProjectId: string | undefined | null = getActiveProjectId(),
): { projectId: string | null; skipped: string | null } {
  const fromEnv = typeof env.RUN402_PROJECT_ID === "string" ? env.RUN402_PROJECT_ID.trim() : "";
  const projectId = fromEnv || activeProjectId || null;
  if (projectId) return { projectId, skipped: null };
  return {
    projectId: null,
    skipped: "no project is selected, so there is nothing to point a run402 remote at — run `run402 projects use <project_id>` (or set RUN402_PROJECT_ID), then re-run `run402 init`",
  };
}

async function detectTarget(clientFor: InitClientFactory, apiBase: string): Promise<{ kind: string; health_status?: string; health_error?: string }> {
  try {
    const health = (await clientFor({ apiBase, disablePaidFetch: true, authMode: "none" }).service.health()) as unknown as Record<string, unknown> | null;
    const kind = health && typeof health === "object" && health.mode === "core"
      ? "core"
      : sameOrigin(apiBase, "https://api.run402.com") ? "cloud" : "core";
    return { kind, health_status: typeof health?.status === "string" ? (health.status as string) : "ok" };
  } catch (err) {
    return { kind: sameOrigin(apiBase, "https://api.run402.com") ? "cloud" : "core", health_error: errorMessage(err) };
  }
}

async function readTokenBalance(client: { readContract(args: unknown): Promise<unknown> }, token: string, address: string): Promise<number> {
  const raw = await client.readContract({ address: token, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
  return Number(raw);
}

/** Configure an API target for the active profile. */
export async function initApiTarget(clientFor: InitClientFactory, apiBase: string, onLine: (line: string) => void = () => {}): Promise<InitTargetSummary> {
  const CONFIG_DIR = getConfigDir();
  const detected = await detectTarget(clientFor, apiBase);
  const config = configureApiBase(apiBase, {
    target_kind: detected.kind as "cloud" | "core",
    ...(detected.health_status ? { health_status: detected.health_status } : {}),
    ...(detected.health_error ? { health_error: detected.health_error } : {}),
  });
  mkdirSync(CONFIG_DIR, { recursive: true });
  onLine("");
  onLine(`  ${"Config".padEnd(10)} ${CONFIG_DIR}`);
  onLine(`  ${"API base".padEnd(10)} ${config.api_base}`);
  onLine(`  ${"Target".padEnd(10)} ${config.target_kind}`);
  if (detected.health_status) onLine(`  ${"Health".padEnd(10)} ${detected.health_status}`);
  if (detected.health_error) onLine(`  ${"Health".padEnd(10)} ${detected.health_error}`);
  onLine("");
  return {
    config_dir: CONFIG_DIR,
    api_base: config.api_base as string,
    api_base_source: "profile",
    target: {
      kind: config.target_kind as string,
      ...(config.health_status ? { health_status: config.health_status } : {}),
      ...(config.health_error ? { health_error: config.health_error } : {}),
    },
    payment_required: config.target_kind === "cloud",
    next_actions: [{ type: "create_project", command: 'run402 projects provision --name "my-app"' }],
    next_step: 'run402 projects provision --name "my-app"',
  };
}

/** Set up the active profile: wallet, rail, funding, voucher, Lightning, tier, projects, vault remote, orgs, next step. */
export async function runInit(r: InitSdk, client: Client, opts: InitOptions = {}): Promise<InitSummary> {
  gateSecret(client, "init", opts);
  const onLine = opts.onLine ?? (() => {});
  const cwd = opts.cwd ?? process.cwd();
  const voucherCode = opts.voucher ?? null;
  const displayName = opts.name;
  if (displayName !== undefined && displayName.trim() === "") {
    throw new LocalError("--name requires a non-empty value.", "running init", { code: "BAD_USAGE", details: { flag: "--name" } });
  }

  const CONFIG_DIR = getConfigDir();
  const requestedRail: InitRail = opts.rail ?? "x402";
  const isMpp = requestedRail === "mpp";
  const isLightning = requestedRail === "lightning";

  const existingWallet = readLocalWallet();
  // Creating the wallet writes a private key: the same refusal as wallets.create.
  if (!existingWallet) gateSecret(client, "wallets.create");
  if (existingWallet?.rail && existingWallet.rail !== requestedRail && !opts.switchRail) {
    throw new LocalError(`Already on rail '${existingWallet.rail}'. Pass --switch-rail to switch to '${requestedRail}'.`, "running init", {
      code: "RAIL_SWITCH_REQUIRES_CONFIRM",
      details: { current_rail: existingWallet.rail, requested_rail: requestedRail },
    });
  }

  const line = (label: string, value: string) => onLine(`  ${label.padEnd(10)} ${value}`);
  const summary: InitSummary = {
    config_dir: CONFIG_DIR,
    wallet: null,
    rail: null,
    network: null,
    balances: null,
    // Present only when a code was offered, so absence means "none offered".
    ...(voucherCode ? { voucher: null } : {}),
    tier: null,
    projects_saved: 0,
    active_project_id: null,
    next_actions: [],
    next_step: null,
  };

  onLine("");

  // 1. Config directory.
  mkdirSync(CONFIG_DIR, { recursive: true });
  line("Config", CONFIG_DIR);

  // 2. Wallet.
  let localWallet: WalletData | null = existingWallet;
  const previousRail = localWallet?.rail;
  if (!localWallet) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    localWallet = { address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: requestedRail };
    saveWallet(localWallet);
    line("Wallet", `${short(localWallet.address)} (created)`);
  } else {
    // A wallet leaving Lightning keeps its pairing on disk until revoked.
    if (localWallet.rail !== requestedRail) {
      localWallet = { ...localWallet, rail: requestedRail };
      saveWallet(localWallet);
    }
    line("Wallet", short(localWallet.address));
  }

  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);
  summary.wallet = { local_label: walletName, server_label: walletMeta?.label ?? null, address: localWallet.address };
  summary.network = isLightning ? "bitcoin-mainnet" : isMpp ? "tempo-moderato" : "base-sepolia";
  summary.rail = requestedRail;

  line("Network", isLightning ? "Bitcoin mainnet (Lightning) + Base Sepolia fallback" : isMpp ? "Tempo Moderato (testnet)" : "Base Sepolia (testnet)");
  line("Rail", requestedRail);

  // 3. Balance — read on-chain, faucet if zero.
  let balance = 0;
  let fundingError: unknown;
  let fundingPending = false;

  if (isMpp) {
    const { createPublicClient, http, defineChain } = await import("viem");
    const tempoModerato = defineChain({
      id: 42431,
      name: "Tempo Moderato",
      nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
      rpcUrls: { default: { http: [TEMPO_RPC] } },
    });
    const chain = createPublicClient({ chain: tempoModerato, transport: http() }) as unknown as { readContract(args: unknown): Promise<unknown> };
    try { balance = await readTokenBalance(chain, PATH_USD, localWallet.address); } catch { /* unreadable → 0 */ }

    if (balance === 0) {
      line("Balance", "0 pathUSD — requesting Tempo faucet...");
      try {
        const res = await fetch(TEMPO_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tempo_fundAddress", params: [localWallet.address], id: 1 }),
        });
        const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (data.result) {
          // The faucet settles on-chain before the RPC read sees it: poll up to 30 s.
          for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
              balance = await readTokenBalance(chain, PATH_USD, localWallet.address);
              if (balance > 0) break;
            } catch { /* keep polling */ }
          }
          saveWallet({ ...localWallet, funded: true, lastFaucet: new Date().toISOString() });
          if (balance > 0) {
            line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD (funded)`);
          } else {
            fundingPending = true;
            line("Balance", "faucet sent — not yet confirmed on-chain");
          }
        } else {
          fundingError = data.error ?? { message: "Faucet failed" };
          line("Balance", `faucet failed: ${data.error?.message || "unknown error"}`);
        }
      } catch (err) {
        fundingError = err;
        line("Balance", `faucet error: ${(err as Error).message}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD`);
    }
  } else {
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const chain = createPublicClient({ chain: baseSepolia, transport: http() }) as unknown as { readContract(args: unknown): Promise<unknown> };
    try { balance = await readTokenBalance(chain, USDC_SEPOLIA, localWallet.address); } catch { /* unreadable → 0 */ }

    if (balance === 0) {
      line("Balance", "0 USDC — requesting faucet...");
      try {
        await r.wallets.faucet(localWallet.address);
        for (let i = 0; i < 30; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            balance = await readTokenBalance(chain, USDC_SEPOLIA, localWallet.address);
            if (balance > 0) break;
          } catch { /* keep polling */ }
        }
        saveWallet({ ...localWallet, funded: true, lastFaucet: new Date().toISOString() });
        if (balance > 0) {
          line("Balance", `${(balance / 1e6).toFixed(2)} USDC (funded)`);
        } else {
          fundingPending = true;
          line("Balance", "faucet sent — not yet confirmed on-chain");
        }
      } catch (err) {
        fundingError = err;
        line("Balance", `faucet failed: ${errorMessage(err)}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} USDC`);
    }
  }

  // 3b. Promo code. Runs after the wallet exists (it authenticates as this
  // agent) and before the allowance read (so the redeemed amount shows).
  // NOTHING here may fail init: every failure is `voucher_error`.
  if (voucherCode) {
    try {
      const redemption = (await r.vouchers.redeem(voucherCode)) as unknown as {
        voucher_id: string; amount_usd_micros: number; already_redeemed: boolean; next_actions?: unknown;
      };
      const redeemed = (redemption.amount_usd_micros / 1_000_000).toFixed(2);
      line(
        "Voucher",
        redemption.already_redeemed
          ? `$${redeemed} already added to the allowance (not added twice)`
          : `$${redeemed} added to the allowance`,
      );
      summary.voucher = {
        voucher_id: redemption.voucher_id,
        amount_usd_micros: redemption.amount_usd_micros,
        already_redeemed: redemption.already_redeemed,
        next_actions: Array.isArray(redemption.next_actions) ? (redemption.next_actions as Array<Record<string, unknown>>) : [],
      };
      // The gateway's own `set_tier` action names the largest tier the allowance covers.
      const covers = summary.voucher.next_actions.find((a) => a?.type === "set_tier" && typeof a.cli === "string");
      if (covers) {
        const tierName = (covers.highest_affordable_tier as string | undefined) ?? (covers.cli as string).replace(/^run402 tier set\s+/, "");
        line("Allowance", `$${redeemed} covers ${tierName} — ${covers.cli} (settles from the allowance; no wallet funds needed)`);
      }
    } catch (err) {
      const reason = errorMessage(err);
      line("Voucher", `not applied: ${reason}`);
      summary.voucher = null;
      summary.voucher_error = { code: errorCode(err, "VOUCHER_REDEEM_FAILED"), message: reason };
    }
  }

  // Balances mirror `status`: the on-chain figure plus the organization's
  // allowance, read best-effort.
  const billing = (await r.billing.checkBalance(localWallet.address).catch(() => null)) as unknown as {
    exists?: boolean; allowance_usd_micros?: number; held_usd_micros?: number;
  } | null;
  const hasBilling = billing && billing.exists !== false;
  summary.balances = {
    on_chain_usd_micros: balance,
    on_chain_token: isMpp ? "pathUSD" : "USDC",
    allowance_usd_micros: hasBilling ? billing!.allowance_usd_micros ?? null : null,
    held_usd_micros: hasBilling ? (billing!.held_usd_micros ?? 0) : null,
  };

  if (previousRail && previousRail !== (isMpp ? "mpp" : "x402")) {
    const prev = previousRail === "mpp" ? "Tempo pathUSD" : "Base Sepolia USDC";
    line("Note", `Switched from ${previousRail} — ${prev} balance still available if you switch back`);
  }

  // 3c. The Lightning wallet: minted on Run402's Hub, its pairing kept beside
  // the Base key and never returned. No Hub leaves x402 as the live fallback.
  summary.lightning = null;
  if (isLightning) {
    try {
      const result = await ensureLightningWallet(r.agent);
      localWallet = result.localWallet;
      const settled = result.outcome === "stored" || result.outcome === "present";
      const lnBalance = settled ? await readLightningBalance(localWallet) : null;
      summary.lightning = { ...(describeLightning(localWallet, result.wallet, lnBalance) ?? {}), outcome: result.outcome };
      if (result.outcome === "stored") {
        line("Lightning", `wallet minted on Run402's Hub (${result.wallet!.budget_sats} sats budget, ${result.wallet!.starter_sats} starter)`);
      } else if (result.outcome === "present") {
        line("Lightning", `wallet ${localWallet.lightning!.wallet_id}${lnBalance ? ` — ${lnBalance.balance_sats} sats` : ""}`);
      } else if (result.outcome === "minting") {
        line("Lightning", "the platform is still minting the wallet — rerun `run402 init lightning` in a few seconds");
      } else if (result.outcome === "unavailable") {
        line("Lightning", "no Hub on this gateway — paying over x402 until it is back");
      } else if (result.outcome === "pairing_lost") {
        line("Lightning", "wallet is active but its pairing was handed to another machine — `run402 wallets lightning revoke`, then init again");
      } else {
        line("Lightning", `wallet is ${result.outcome}`);
      }
    } catch (err) {
      summary.lightning = { outcome: "error", code: errorCode(err, "LIGHTNING_WALLET_FAILED"), message: (err as Error)?.message ?? String(err) };
      line("Lightning", `wallet setup failed: ${(err as Error)?.message ?? String(err)} — paying over x402 until it is fixed`);
    }
  }

  // 4. Tier.
  const store = loadKeyStore();
  let tierInfo: TierFacts | null = null;
  try {
    tierInfo = (await r.tier.status()) as unknown as TierFacts;
  } catch { /* read best-effort */ }

  if (tierInfo && tierInfo.tier && tierInfo.active) {
    const expiry = tierInfo.lease_expires_at ? tierInfo.lease_expires_at.split("T")[0] : "unknown";
    line("Tier", `${tierInfo.tier} (expires ${expiry})`);
    summary.tier = { name: tierInfo.tier, expires: tierInfo.lease_expires_at || null };
  } else {
    line("Tier", "(none)");
    summary.tier = null;
  }

  // 5. Projects with LOCAL keys ("saved", not "active").
  summary.projects_saved = Object.keys(store.projects).length;
  line("Projects", `${summary.projects_saved} saved`);

  // 5b. The vault git remote: purely local git, never an allocation. Adding
  // the remote inside an existing repository is the default (pure addition);
  // creating a repository needs `gitRemote`. Non-fatal in every branch.
  const { projectId: activeProjectId, skipped: noProjectSkip } = resolveScaffoldProject(opts.env ?? process.env);
  summary.active_project_id = activeProjectId;
  if (noProjectSkip) {
    summary.vault = null;
    summary.vault_skipped = noProjectSkip;
    line("Vault", "skipped — no project selected (run402 projects use <project_id>)");
  } else {
    summary.vault = null;
    try {
      let insideRepo = true;
      try {
        await hardenedGit(cwd, ["rev-parse", "--git-dir"]);
      } catch {
        insideRepo = false;
      }
      if (!insideRepo && !opts.gitRemote) {
        summary.vault_skipped = "not a git repository — re-run with --git-remote to create one and add the remote";
        line("Vault", "skipped — not a git repository (--git-remote creates one)");
      } else {
        const orgId = await r.orgs.owningOrgOf(activeProjectId!);
        if (!orgId) {
          summary.vault_skipped = `could not resolve the owning org for ${activeProjectId} — the run402 remote was not added`;
          line("Vault", "skipped — owning org unresolved");
        } else {
          const remote = (await r.repos.scaffoldRemote({ repo_dir: cwd, org_id: orgId, project_id: activeProjectId! })) as unknown as Record<string, any>;
          // Local git only: no vault exists for the project yet.
          summary.vault = { ...remote, allocated: false };
          if (remote.already_present && remote.existing_url !== remote.url) {
            line("Vault", `remote '${remote.name}' already points at ${remote.existing_url} — left unchanged (${remote.reason})`);
          } else if (remote.already_present) {
            line("Vault", `remote '${remote.name}' already set (${remote.url})`);
          } else {
            line("Vault", `${remote.created_repository ? "initialized a repository and added" : "added"} remote '${remote.name}' -> ${remote.url} (${remote.reason})`);
          }
        }
      }
    } catch (err) {
      const reason = errorMessage(err);
      summary.vault = null;
      summary.vault_error = { code: errorCode(err, "VAULT_SCAFFOLD_FAILED"), message: reason };
      line("Vault", `remote not added: ${reason}`);
    }
  }

  // 5c. The org: materialized by the tier read above; an identifier, not a credential.
  try {
    const orgs = (await r.orgs.list()) as unknown;
    const rows = (Array.isArray(orgs) ? orgs : ((orgs as { orgs?: unknown[] })?.orgs ?? [])) as Array<{ org_id: string; display_name?: string | null; role?: string | null }>;
    summary.orgs = rows.map((o) => ({ org_id: o.org_id, display_name: o.display_name ?? null, role: o.role ?? null }));
    if (rows.length === 1) {
      line("Org", `${rows[0]!.org_id}${rows[0]!.display_name ? ` (${rows[0]!.display_name})` : ""}`);
    } else if (rows.length > 1) {
      line("Org", `${rows.length} organizations — run402 orgs list`);
    }
  } catch {
    summary.orgs = null;
  }

  // 6. The next step: canonical typed action(s); `next_step` mirrors the first command.
  onLine("");
  const tierMissing = !tierInfo || !tierInfo.tier || !tierInfo.active;
  summary.funding = fundingRecovery(fundingError, fundingPending);
  const fundingBlocked = fundingBlocksBootstrap(summary.funding, {
    activeTier: !tierMissing,
    onChainBalance: balance,
    allowanceBalance: summary.balances.allowance_usd_micros,
    lightningBalance: (summary.lightning as { balance_sats?: number } | null)?.balance_sats,
  });
  summary.next_actions = [tierMissing ? upDeployAction() : deployAction()];
  if (fundingBlocked) {
    const quotedWallet = `'${walletName.replaceAll("'", "'\\''")}'`;
    summary.next_actions = summary.funding!.next_actions.map((action: NextAction) => ({
      ...action,
      ...(["retry", "check_balance"].includes(action.type) ? {
        command: `run402 --wallet ${quotedWallet} wallets ${action.type === "retry" ? "fund" : "balance"}`,
      } : {}),
    }));
  }
  summary.next_step = summary.next_actions[0]?.command ?? null;
  if (fundingBlocked) {
    line("Funding", summary.funding!.status);
    onLine(`  ${summary.next_actions[0]!.why}`);
    if (summary.next_step) onLine(`  Next: ${summary.next_step}`);
  } else if (tierMissing) {
    // `up -y` sets the prototype tier itself as part of the first deploy.
    const allowanceCovers = summary.voucher?.next_actions?.find((a) => a?.type === "set_tier" && typeof a.cli === "string");
    onLine("  Next: run402 up -y");
    onLine("        Deploy with run402 up -y — it sets the prototype tier (free on testnet) as part of the first deploy.");
    if (allowanceCovers) {
      onLine(`        Your allowance covers ${(allowanceCovers.highest_affordable_tier as string | undefined) ?? "a larger tier"}: ${allowanceCovers.cli} — then run402 up -y.`);
    } else {
      onLine("        Or set it separately: run402 tier set prototype.");
    }
  } else {
    onLine("  Ready to deploy. Run: run402 deploy --manifest app.json");
  }
  onLine("");

  // 5d. Display name, best-effort.
  if (displayName !== undefined) {
    try {
      const me = (await r.orgs.setDisplayName(displayName.trim())) as unknown as { principal?: { display_name?: string } };
      summary.display_name = me?.principal?.display_name ?? displayName.trim();
      line("Name", summary.display_name);
    } catch (err) {
      summary.display_name = null;
      summary.display_name_error = { code: errorCode(err, "DISPLAY_NAME_FAILED"), message: (err as Error)?.message ?? String(err) };
    }
  }

  return summary;
}
