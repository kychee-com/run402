/**
 * run402 init — the CLI edge of `r.init()` (`@run402/sdk/node`), which sets up
 * the active profile (wallet, rail, funding, voucher, Lightning wallet, tier,
 * projects, vault remote, organization, next step) or, with `--api-base`,
 * configures a Run402 Core target. This module parses argv, refuses the flag
 * combinations that cannot mean anything, streams the progress lines to
 * stderr, and prints the summary. `run402 init astro` routes to the Astro
 * scaffolder.
 */
import { getSdk } from "./sdk.mjs";
import { fail, reportLocalOrSdkError } from "./sdk-errors.mjs";

const HELP = `run402 init — Set up wallet, funding, and check tier status

Usage:
  run402 init                Set up with x402 (Base Sepolia) — default
  run402 init --api-base <url>
                             Configure a Run402 Core/API target for the active
                             profile without setting up Cloud payment.
  run402 init mpp            Set up with MPP (Tempo Moderato)
  run402 init lightning      Set up the Lightning wallet: a budgeted wallet
                             minted on Run402's Hub (custody: Run402), plus the
                             Base wallet as the x402 fallback. Lightning
                             becomes the default rail for paid calls.
  run402 init <rail> --switch-rail
                             Switch the persisted payment rail to <rail>.
                             Required when a wallet already exists on
                             the other rail; protects scripted re-runs from
                             silently flipping billing networks.

Options:
  --voucher <code> Redeem a promo code after setup into this
                  organization's allowance. Never blocks setup: if the code is invalid,
                  expired, already used, or the call fails, init warns and
                  finishes normally with 'voucher_error' in the summary.
                  Equivalent to running 'run402 redeem <code>' afterwards.
  --api-base <url> Configure the active profile to use this API base. Use this
                  for a self-hosted Run402 Core Gateway, e.g.
                  http://my-core:4020.
  --switch-rail   Confirm switching the persisted payment rail. Re-running
                  init with the SAME rail as the existing wallet is always
                  idempotent and does not need this flag.
  --name <name>   Set this principal's display name (1-64 chars) — what promotion
                  credit, \`run402 up\`'s room presence, and audit surfaces show
                  for you. When it is empty, \`run402 up\` sets the detected
                  client (claude-code, codex, cursor, or grok; RUN402_CLIENT=<name>
                  declares one that is not auto-detected) and otherwise writes
                  nothing; RUN402_AGENT_NAME=<name> sets or overrides it. Change
                  it any time with \`run402 whoami --set-name <name>\`.
  --git-remote    Also 'git init' the current directory when it is not a
                  repository yet, so the vault remote can be added there.
                  Opt-in on purpose: init is often run outside a project
                  directory and must never create a repository somewhere you
                  did not ask it to. Inside an EXISTING repository the remote
                  is added without this flag (see below).

Output:
  Stdout is a JSON summary { config_dir, wallet, rail, network, balances,
  tier, projects_saved, active_project_id, next_step }. Progress lines
  (Config / Wallet / Balance / Tier / Next) go to stderr so a human
  re-running interactively sees what's happening while a script piping stdout
  to jq stays clean. The summary also carries { vault } (the scaffolded
  remote), or { vault: null, vault_skipped } naming why no remote was
  added, or { vault: null, vault_error } when it could not be added.
  \`projects_saved\` counts projects with LOCAL keys; \`active_project_id\` is the
  project the vault scaffold acted on.

  init scaffolds the git remote only. It does NOT allocate the vault — that is
  \`run402 repos create --project <project_id>\`, which mints key material and a
  recovery receipt and therefore stays an explicit step.

Steps (idempotent when re-run with the same rail; pass --switch-rail to change rails):
  1. Creates config directory (~/.config/run402)
  2. Creates agent wallet if none exists
  3. Checks on-chain balance; requests faucet if zero
  4. Shows current tier and lease status
  5. Lists local project count
  6. Suggests next step (run402 up -y when no tier is held yet — it sets
     the prototype tier as part of the first deploy — or run402 deploy)

Run this once to get started, or again to check your setup.
`;

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
/** Pull `--flag <value>` (or `--flag=<value>`) out of argv; returns { args, value }. */
function parseValueFlag(args, flag) {
  const out = [];
  let value;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      value = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
      continue;
    }
    out.push(arg);
  }
  return { args: out, value };
}

function parseGitRemoteFlag(args) {
  const idx = args.indexOf("--git-remote");
  if (idx === -1) return { value: false, args };
  return { value: true, args: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

export async function run(args = []) {
  // `run402 init astro <dir>` scaffolds an Astro project; handled BEFORE the
  // --help check so `run402 init astro --help` shows the scaffolder's help.
  if (args[0] === "astro") {
    const { runInitAstro } = await import("./init-astro.mjs");
    await runInitAstro(args.slice(1));
    return;
  }

  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }

  // Strip the value flags before the rail positional is read, so an
  // unrecognized token is never taken for a rail name.
  const parsedVoucher = parseVoucherFlag(args);
  args = parsedVoucher.args;
  const voucherCode = parsedVoucher.value;

  const parsedGitRemote = parseGitRemoteFlag(args);
  args = parsedGitRemote.args;
  const scaffoldGitRemote = parsedGitRemote.value;

  const parsedName = parseValueFlag(args, "--name");
  args = parsedName.args;
  const displayName = parsedName.value;
  if (displayName !== undefined && displayName.trim() === "") {
    fail({ code: "BAD_USAGE", message: "--name requires a non-empty value.", details: { flag: "--name" } });
  }

  const onLine = (line) => console.error(line);
  const parsedApiBase = parseApiBaseFlag(args);
  let summary;
  if (parsedApiBase.value) {
    if (parsedApiBase.args.some((arg) => typeof arg === "string" && !arg.startsWith("--"))) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with a payment rail.",
        hint: "Run `run402 init --api-base=http://my-core:4020` for Core, or `run402 init` for Run402 Cloud.",
      });
    }
    // The target branch touches no wallet and no project: a voucher has no
    // organization to credit and a git scaffold has nothing to point at.
    if (voucherCode) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with --voucher.",
        hint: "Configure the target first (`run402 init --api-base=…`), then redeem against Run402 Cloud with `run402 redeem <code>`.",
      });
    }
    if (scaffoldGitRemote) {
      fail({
        code: "BAD_USAGE",
        message: "run402 init --api-base cannot be combined with --git-remote.",
        hint: "Configure the target first (`run402 init --api-base=…`), provision a project, then run `run402 init --git-remote` from the project directory.",
      });
    }
    try {
      summary = await getSdk().init({ apiBase: parsedApiBase.value, onLine });
    } catch (err) {
      reportLocalOrSdkError(err);
      return;
    }
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const rail = args[0] === "lightning" ? "lightning" : args[0] === "mpp" ? "mpp" : "x402";
  try {
    summary = await getSdk().init({
      rail,
      switchRail: args.includes("--switch-rail"),
      voucher: voucherCode,
      gitRemote: scaffoldGitRemote,
      ...(displayName !== undefined ? { name: displayName } : {}),
      onLine,
    });
  } catch (err) {
    reportLocalOrSdkError(err);
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}
