import { readAllowance, saveAllowance, loadKeyStore, configDir, configureApiBase, getActiveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { fail } from "./sdk-errors.mjs";
import { setTierAction, deployAction } from "./next-actions.mjs";
import { getActiveProfile } from "../core-dist/config.js";
import { readMeta } from "../core-dist/profiles.js";
import { mkdirSync } from "fs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

const HELP = `run402 init — Set up allowance, funding, and check tier status

Usage:
  run402 init                Set up with x402 (Base Sepolia) — default
  run402 init --api-base <url>
                             Configure a Run402 Core/API target for the active
                             profile without setting up Cloud payment.
  run402 init mpp            Set up with MPP (Tempo Moderato)
  run402 init <rail> --switch-rail
                             Switch the persisted payment rail to <rail>.
                             Required when an allowance already exists on
                             the other rail; protects scripted re-runs from
                             silently flipping billing networks.

Options:
  --voucher <code> Redeem a promo code after setup and credit this
                  organization. Never blocks setup: if the code is invalid,
                  expired, already used, or the call fails, init warns and
                  finishes normally with 'voucher_error' in the summary.
                  Equivalent to running 'run402 redeem <code>' afterwards.
  --api-base <url> Configure the active profile to use this API base. Use this
                  for a self-hosted Run402 Core Gateway, e.g.
                  http://my-core:4020.
  --switch-rail   Confirm switching the persisted payment rail. Re-running
                  init with the SAME rail as the existing allowance is always
                  idempotent and does not need this flag.
  --git-remote    Also 'git init' the current directory when it is not a
                  repository yet, so the gitvault remote can be added there.
                  Opt-in on purpose: init is often run outside a project
                  directory and must never create a repository somewhere you
                  did not ask it to. Inside an EXISTING repository the remote
                  is added without this flag (see below).

Output:
  Stdout is a JSON summary { config_dir, wallet, rail, network, balances,
  tier, projects_saved, next_step }. Progress lines (Config / Allowance /
  Balance / Tier / Next) go to stderr so a human re-running interactively
  sees what's happening while a script piping stdout to jq stays clean.
  With --git-remote the summary also carries { gitvault } (the scaffolded
  remote) or { gitvault: null, gitvault_error } when it could not be added.

Steps (idempotent when re-run with the same rail; pass --switch-rail to change rails):
  1. Creates config directory (~/.config/run402)
  2. Creates agent allowance if none exists
  3. Checks on-chain balance; requests faucet if zero
  4. Shows current tier subscription status
  5. Lists local project count
  6. Suggests next step (tier set or deploy)

Run this once to get started, or again to check your setup.
`;

function short(addr) { return addr.slice(0, 6) + "..." + addr.slice(-4); }

function parseApiBaseFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api-base") {
      const value = args[i + 1];
      if (value === undefined || String(value).startsWith("--")) {
        fail({
          code: "BAD_USAGE",
          message: "--api-base requires a value.",
          details: { flag: "--api-base" },
        });
      }
      return { value, args: [...args.slice(0, i), ...args.slice(i + 2)] };
    }
    if (typeof arg === "string" && arg.startsWith("--api-base=")) {
      const value = arg.slice("--api-base=".length);
      if (!value) {
        fail({
          code: "BAD_USAGE",
          message: "--api-base requires a non-empty value.",
          details: { flag: "--api-base" },
        });
      }
      return { value, args: [...args.slice(0, i), ...args.slice(i + 1)] };
    }
  }
  return { value: null, args };
}

/**
 * Pull `--voucher <code>` / `--voucher=<code>` out of argv, mirroring
 * `parseApiBaseFlag`. A MISSING VALUE still fails fast — that is a usage error
 * the caller can fix, unlike a redemption failure, which must never take init
 * down with it (see the redemption step at the end of `run`).
 */
function parseVoucherFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--voucher") {
      const value = args[i + 1];
      if (value === undefined || String(value).startsWith("--")) {
        fail({
          code: "BAD_USAGE",
          message: "--voucher requires a value.",
          hint: "run402 init --voucher R402-K8F3-Q2W9",
          details: { flag: "--voucher" },
        });
      }
      return { value, args: [...args.slice(0, i), ...args.slice(i + 2)] };
    }
    if (typeof arg === "string" && arg.startsWith("--voucher=")) {
      const value = arg.slice("--voucher=".length);
      if (!value) {
        fail({
          code: "BAD_USAGE",
          message: "--voucher requires a non-empty value.",
          hint: "run402 init --voucher R402-K8F3-Q2W9",
          details: { flag: "--voucher" },
        });
      }
      return { value, args: [...args.slice(0, i), ...args.slice(i + 1)] };
    }
  }
  return { value: null, args };
}

/**
 * Pull the boolean `--git-remote` out of argv before the rail/positional logic
 * runs, so `run402 init --git-remote mpp` still selects the mpp rail (the same
 * reason `--voucher` is stripped first).
 */
function parseGitRemoteFlag(args) {
  const idx = args.indexOf("--git-remote");
  if (idx === -1) return { value: false, args };
  return { value: true, args: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function detectTarget(apiBase) {
  try {
    const health = await getSdk({ apiBase, disablePaidFetch: true, authMode: "none" }).service.health();
    const kind = health && typeof health === "object" && health.mode === "core"
      ? "core"
      : sameOrigin(apiBase, "https://api.run402.com") ? "cloud" : "core";
    return {
      kind,
      health_status: typeof health?.status === "string" ? health.status : "ok",
    };
  } catch (err) {
    return {
      kind: sameOrigin(apiBase, "https://api.run402.com") ? "cloud" : "core",
      health_error: errorMessage(err),
    };
  }
}

function errorMessage(err) {
  if (err?.body && typeof err.body === "object") return err.body.message || err.body.error || err.message;
  return err?.message || String(err);
}

/**
 * The owning org of the locally-active project, read from the named inventory.
 *
 * Best-effort by construction — the caller treats `null` as "do not scaffold".
 * The local keystore does not cache `org_id`, so this read is the only place to
 * learn it, and an EXACT id match is required: a near-miss must never make init
 * add a remote pointing at somebody else's project.
 */
async function resolveOwningOrgId(projectId) {
  try {
    const listed = await getSdk().projects.list();
    const rows = Array.isArray(listed?.projects) ? listed.projects : [];
    const row = rows.find((p) => (p?.id ?? p?.project_id) === projectId);
    const orgId = row?.org_id;
    return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
  } catch {
    return null;
  }
}

export async function run(args = []) {
  // Capability `astro-ssr-runtime` (v1.52): scaffold an Astro project.
  // Sub-routes when first positional is 'astro'. Handle BEFORE the
  // outer --help check so `run402 init astro --help` shows the astro
  // scaffolder's help, not the rail-setup help. The rest of init's
  // payment-rail setup is intentionally orthogonal — agents typically
  // run `run402 init astro <dir>` to scaffold AND `run402 init` once
  // to set up allowance / tier.
  if (args[0] === "astro") {
    const { runInitAstro } = await import("./init-astro.mjs");
    await runInitAstro(args.slice(1));
    return;
  }

  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }

  // Strip --voucher before anything else parses argv, so the rail/positional
  // logic below never sees it (an unrecognized token there would be read as a
  // rail name).
  const parsedVoucher = parseVoucherFlag(args);
  args = parsedVoucher.args;
  const voucherCode = parsedVoucher.value;

  const parsedGitRemote = parseGitRemoteFlag(args);
  args = parsedGitRemote.args;
  const scaffoldGitRemote = parsedGitRemote.value;

  const parsedApiBase = parseApiBaseFlag(args);
  if (parsedApiBase.value) {
    if (parsedApiBase.args.some((arg) => typeof arg === "string" && !arg.startsWith("--"))) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with a payment rail.",
        hint: "Run `run402 init --api-base=http://my-core:4020` for Core, or `run402 init` for Run402 Cloud.",
      });
    }
    // This branch configures a Core/API target and returns without setting up
    // an allowance — there is no organization here to credit, and promo
    // vouchers are a Run402 Cloud concept. Say so instead of accepting the
    // flag and silently dropping it.
    if (voucherCode) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with --voucher.",
        hint: "Configure the target first (`run402 init --api-base=…`), then redeem against Run402 Cloud with `run402 redeem <code>`.",
      });
    }
    // Same reasoning as --voucher: this branch configures a target and returns
    // without an active project, so a git scaffold has nothing to point at.
    // Say so rather than accepting the flag and silently dropping it.
    if (scaffoldGitRemote) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with --git-remote.",
        hint: "Configure the target first (`run402 init --api-base=…`), provision a project, then run `run402 init --git-remote` from the project directory.",
      });
    }
    const CONFIG_DIR = configDir();
    const detected = await detectTarget(parsedApiBase.value);
    const config = configureApiBase(parsedApiBase.value, {
      target_kind: detected.kind,
      ...(detected.health_status ? { health_status: detected.health_status } : {}),
      ...(detected.health_error ? { health_error: detected.health_error } : {}),
    });
    mkdirSync(CONFIG_DIR, { recursive: true });
    console.error("");
    console.error(`  ${"Config".padEnd(10)} ${CONFIG_DIR}`);
    console.error(`  ${"API base".padEnd(10)} ${config.api_base}`);
    console.error(`  ${"Target".padEnd(10)} ${config.target_kind}`);
    if (detected.health_status) console.error(`  ${"Health".padEnd(10)} ${detected.health_status}`);
    if (detected.health_error) console.error(`  ${"Health".padEnd(10)} ${detected.health_error}`);
    console.error("");
    const summary = {
      config_dir: CONFIG_DIR,
      api_base: config.api_base,
      api_base_source: "profile",
      target: {
        kind: config.target_kind,
        ...(config.health_status ? { health_status: config.health_status } : {}),
        ...(config.health_error ? { health_error: config.health_error } : {}),
      },
      payment_required: config.target_kind === "cloud",
      next_actions: [{
        type: "create_project",
        command: 'run402 projects provision --name "my-app"',
      }],
      next_step: 'run402 projects provision --name "my-app"',
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Resolve once for this invocation — reflects the active wallet/profile that
  // cli.mjs published to RUN402_WALLET before this module loaded.
  const CONFIG_DIR = configDir();

  const isMpp = args[0] === "mpp";
  const requestedRail = isMpp ? "mpp" : "x402";
  const switchRailConfirmed = args.includes("--switch-rail");

  const existingAllowance = readAllowance();
  if (existingAllowance?.rail && existingAllowance.rail !== requestedRail && !switchRailConfirmed) {
    fail({
      code: "RAIL_SWITCH_REQUIRES_CONFIRM",
      message: `Already on rail '${existingAllowance.rail}'. Pass --switch-rail to switch to '${requestedRail}'.`,
      details: { current_rail: existingAllowance.rail, requested_rail: requestedRail },
    });
  }

  // Human-readable progress lines go to stderr so stdout stays JSON-clean for
  // agents. Final structured summary emits to stdout at the end.
  const write = (s) => console.error(s);
  const line = (label, value) => write(`  ${label.padEnd(10)} ${value}`);
  const summary = {
    config_dir: CONFIG_DIR,
    wallet: null,
    rail: null,
    network: null,
    balances: null,
    // Present (null or an object) only when --voucher was passed, so its
    // absence means "no code was offered" rather than "a code silently
    // vanished". `voucher_error` appears alongside a null `voucher`.
    ...(voucherCode ? { voucher: null } : {}),
    tier: null,
    projects_saved: 0,
    next_actions: [],
    next_step: null,
  };

  write("");

  // 1. Config directory
  mkdirSync(CONFIG_DIR, { recursive: true });
  line("Config", CONFIG_DIR);

  // 2. Allowance
  let allowance = existingAllowance;
  const previousRail = allowance?.rail;
  if (!allowance) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    allowance = { address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: isMpp ? "mpp" : "x402" };
    saveAllowance(allowance);
    line("Allowance", `${short(allowance.address)} (created)`);
  } else {
    // Update rail if switching
    if ((isMpp && allowance.rail !== "mpp") || (!isMpp && allowance.rail === "mpp")) {
      allowance = { ...allowance, rail: isMpp ? "mpp" : "x402" };
      saveAllowance(allowance);
    } else if (!allowance.rail) {
      allowance = { ...allowance, rail: isMpp ? "mpp" : "x402" };
      saveAllowance(allowance);
    }
    line("Allowance", short(allowance.address));
  }

  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);
  summary.wallet = { local_label: walletName, server_label: walletMeta?.label ?? null, address: allowance.address };
  summary.network = isMpp ? "tempo-moderato" : "base-sepolia";
  summary.rail = isMpp ? "mpp" : "x402";

  line("Network", isMpp ? "Tempo Moderato (testnet)" : "Base Sepolia (testnet)");
  line("Rail", isMpp ? "mpp" : "x402");

  // 3. Balance — check on-chain, faucet if zero
  let balance = 0;

  if (isMpp) {
    // Tempo Moderato: read pathUSD balance
    const { createPublicClient, http, defineChain } = await import("viem");
    const tempoModerato = defineChain({
      id: 42431,
      name: "Tempo Moderato",
      nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
      rpcUrls: { default: { http: [TEMPO_RPC] } },
    });
    const client = createPublicClient({ chain: tempoModerato, transport: http() });

    try {
      const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
      balance = Number(raw);
    } catch {}

    if (balance === 0) {
      line("Balance", "0 pathUSD — requesting Tempo faucet...");
      try {
        const res = await fetch(TEMPO_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tempo_fundAddress", params: [allowance.address], id: 1 }),
        });
        const data = await res.json();
        if (data.result) {
          // Tempo faucet is "instant" on-chain, but the client RPC read can be
          // racy relative to faucet settlement — poll up to 30s (GH-81), mirroring
          // the x402 path below.
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
              balance = Number(raw);
              if (balance > 0) break;
            } catch {}
          }
          saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
          if (balance > 0) {
            line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD (funded)`);
          } else {
            line("Balance", "faucet sent — not yet confirmed on-chain");
          }
        } else {
          line("Balance", `faucet failed: ${data.error?.message || "unknown error"}`);
        }
      } catch (err) {
        line("Balance", `faucet error: ${err.message}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} pathUSD`);
    }
  } else {
    // Base Sepolia: read USDC balance (existing behavior)
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const client = createPublicClient({ chain: baseSepolia, transport: http() });

    try {
      const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
      balance = Number(raw);
    } catch {}

    if (balance === 0) {
      line("Balance", "0 USDC — requesting faucet...");
      try {
        await getSdk().allowance.faucet(allowance.address);
        // Poll for up to 30s
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const raw = await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] });
            balance = Number(raw);
            if (balance > 0) break;
          } catch {}
        }
        saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
        if (balance > 0) {
          line("Balance", `${(balance / 1e6).toFixed(2)} USDC (funded)`);
        } else {
          line("Balance", "faucet sent — not yet confirmed on-chain");
        }
      } catch (err) {
        line("Balance", `faucet failed: ${errorMessage(err)}`);
      }
    } else {
      line("Balance", `${(balance / 1e6).toFixed(2)} USDC`);
    }
  }

  // 3b. Promo code, when one was handed to us.
  //
  // This runs BEFORE the balance read below so the credited amount shows up in
  // `prepaid_credit_usd_micros` without a second round-trip, and AFTER the
  // wallet exists so the redemption authenticates as this agent.
  //
  // NOTHING here may fail init. An advertised gift that dead-ends a build is
  // worse than no gift at all: the agent was told to run one command, and that
  // command must still leave it set up and able to work. Every failure — bad
  // code, expired, already used by someone else, org at its ceiling, network
  // down, gateway too old to know the route — warns on stderr, records
  // `voucher_error` in the JSON summary, and lets setup finish.
  if (voucherCode) {
    try {
      const redemption = await getSdk().vouchers.redeem(voucherCode);
      const credited = (redemption.amount_usd_micros / 1_000_000).toFixed(2);
      line(
        "Voucher",
        redemption.already_redeemed
          ? `$${credited} already credited (no second credit)`
          : `$${credited} credited`,
      );
      summary.voucher = {
        voucher_id: redemption.voucher_id,
        amount_usd_micros: redemption.amount_usd_micros,
        already_redeemed: redemption.already_redeemed,
      };
    } catch (err) {
      // Faithful: name what failed and keep going. `voucher_error` is a
      // first-class summary field, not an omission the caller has to infer.
      const reason = errorMessage(err);
      line("Voucher", `not applied: ${reason}`);
      summary.voucher = null;
      summary.voucher_error = {
        code: err?.body?.code ?? err?.code ?? "VOUCHER_REDEEM_FAILED",
        message: reason,
      };
    }
  }

  // Balances mirror `run402 status`: the on-chain figure above plus the
  // Run402-held prepaid credit (rail-independent). Prepaid credit is fetched
  // best-effort so a billing read failure never blocks setup.
  const billing = await getSdk().billing.checkBalance(allowance.address).catch(() => null);
  const hasBilling = billing && billing.exists !== false;
  summary.balances = {
    on_chain_usd_micros: balance,
    on_chain_token: isMpp ? "pathUSD" : "USDC",
    prepaid_credit_usd_micros: hasBilling ? billing.available_usd_micros : null,
    held_usd_micros: hasBilling ? (billing.held_usd_micros ?? 0) : null,
  };

  // Show note if switching rails
  if (previousRail && previousRail !== (isMpp ? "mpp" : "x402")) {
    const prev = previousRail === "mpp" ? "Tempo pathUSD" : "Base Sepolia USDC";
    line("Note", `Switched from ${previousRail} — ${prev} balance still available if you switch back`);
  }

  // 4. Tier status
  const store = loadKeyStore();
  let tierInfo = null;
  try {
    tierInfo = await getSdk().tier.status();
  } catch {}

  if (tierInfo && tierInfo.tier && tierInfo.active) {
    const expiry = tierInfo.lease_expires_at ? tierInfo.lease_expires_at.split("T")[0] : "unknown";
    line("Tier", `${tierInfo.tier} (expires ${expiry})`);
    summary.tier = { name: tierInfo.tier, expires: tierInfo.lease_expires_at || null };
  } else {
    line("Tier", "(none)");
    summary.tier = null;
  }

  // 5. Projects — count locally saved project entries. Note: "saved" (not
  // "active") — these are all projects in the keystore, regardless of whether
  // the server considers them active.
  summary.projects_saved = Object.keys(store.projects).length;
  line("Projects", `${summary.projects_saved} saved`);

  // 5b. gitvault git remote (gitvault-client-surface, task 5.7).
  //
  // Purely LOCAL git. No vault is allocated and no key material is written
  // here — the spec is explicit that neither exists until first capture, so the
  // cold-start path gains no prompt and no new failure mode. Allocation happens
  // on the first `run402 gitvault push` (or deploy).
  //
  // Adding the remote is the DEFAULT inside a repository that already exists,
  // because it is pure addition: `origin` is never modified or claimed, no file
  // is created, nothing is rewritten. CREATING a repository is NOT the default
  // — `run402 init` is routinely run outside a project directory, and
  // `git init`-ing whatever directory the user happened to be in would be a
  // genuinely bad surprise. `--git-remote` opts into that one step.
  //
  // NON-FATAL in every branch: a missing git, a directory that is not a
  // repository, an unreachable gateway, or a `run402` remote already pointing
  // somewhere else must warn and let setup finish.
  const activeProjectId = getActiveProjectId();
  if (activeProjectId) {
    summary.gitvault = null;
    try {
      // Dynamic import: the scaffold is the only thing here that needs the
      // Node SDK's hardened git runner, and a top-level import would drag it
      // into every init invocation (and every test that mocks ./sdk.mjs).
      const { hardenedGit } = await import("#sdk/node");
      let insideRepo = true;
      try {
        await hardenedGit(process.cwd(), ["rev-parse", "--git-dir"]);
      } catch {
        insideRepo = false;
      }
      if (!insideRepo && !scaffoldGitRemote) {
        summary.gitvault_skipped = "not a git repository — re-run with --git-remote to create one and add the remote";
        line("Gitvault", "skipped — not a git repository (--git-remote creates one)");
      } else {
        const orgId = await resolveOwningOrgId(activeProjectId);
        if (!orgId) {
          summary.gitvault_skipped = `could not resolve the owning org for ${activeProjectId} — the run402 remote was not added`;
          line("Gitvault", "skipped — owning org unresolved");
        } else {
          const remote = await getSdk().gitvault.scaffoldRemote({
            repo_dir: process.cwd(),
            org_id: orgId,
            project_id: activeProjectId,
          });
          // `allocated: false` is stated, not left to be inferred: this was
          // local git only, and no vault exists for the project yet.
          summary.gitvault = { ...remote, allocated: false };
          if (remote.already_present && remote.existing_url !== remote.url) {
            // Left exactly as it was. Name the URL that is actually in place
            // rather than implying the remote now points at this project.
            line("Gitvault", `remote '${remote.name}' already points at ${remote.existing_url} — left unchanged`);
          } else if (remote.already_present) {
            line("Gitvault", `remote '${remote.name}' already set (${remote.url})`);
          } else {
            line("Gitvault", `${remote.created_repository ? "initialized a repository and added" : "added"} remote '${remote.name}' -> ${remote.url}`);
          }
        }
      }
    } catch (err) {
      const reason = errorMessage(err);
      summary.gitvault = null;
      summary.gitvault_error = {
        code: err?.body?.code ?? err?.code ?? "GITVAULT_SCAFFOLD_FAILED",
        message: reason,
      };
      line("Gitvault", `remote not added: ${reason}`);
    }
  }

  // 6. Next step — canonical typed action(s); `next_step` is the back-compat
  // string mirror of the first action's command (one spelling, surface-wide).
  write("");
  const tierMissing = !tierInfo || !tierInfo.tier || !tierInfo.active;
  summary.next_actions = [tierMissing ? setTierAction("prototype") : deployAction()];
  summary.next_step = summary.next_actions[0].command;
  if (tierMissing) {
    write("  Next: run402 tier set prototype");
  } else {
    write("  Ready to deploy. Run: run402 deploy apply --manifest app.json");
  }
  write("");

  console.log(JSON.stringify(summary, null, 2));
}
