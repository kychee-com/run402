#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRED_CAPABILITIES = [
  ["init", "--help"],
  ["wallets", "current", "--help"],
  ["org", "whoami", "--help"],
  ["identity", "link", "nostr", "begin", "--help"],
  ["identity", "link", "nostr", "complete", "--help"],
  ["identity", "link", "list", "--help"],
  ["identity", "link", "show", "--help"],
];

export class BuzzSetupError extends Error {
  constructor(stage, code, message, options = {}) {
    super(message);
    this.name = "BuzzSetupError";
    this.stage = stage;
    this.code = code;
    this.mutationState = options.mutationState ?? "none";
    this.nextAction = options.nextAction ?? null;
    this.details = options.details ?? {};
  }

  toJSON() {
    return {
      status: "blocked",
      stage: this.stage,
      code: this.code,
      message: this.message,
      mutation_state: this.mutationState,
      next_action: this.nextAction,
      details: this.details,
    };
  }
}

function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function globalRun402Executable(runner, npmBin) {
  const result = runner(npmBin, ["prefix", "-g"], { encoding: "utf8", shell: false });
  if (result?.error || result?.status !== 0) {
    boundedFailure(
      "cli_preflight",
      result,
      "NPM_GLOBAL_PREFIX_FAILED",
      "Repair the user's global npm installation, then rerun setup.",
    );
  }
  const prefix = String(result.stdout ?? "").trim();
  if (!prefix) {
    throw new BuzzSetupError("cli_preflight", "NPM_GLOBAL_PREFIX_INVALID", "npm returned no global installation prefix.", {
      nextAction: "Repair the user's global npm configuration, then rerun setup.",
    });
  }
  return process.platform === "win32" ? join(prefix, "run402.cmd") : join(prefix, "bin", "run402");
}

function requiredFlag(argv, name, nextAction) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value || value.startsWith("--")) {
    throw new BuzzSetupError("input", "BAD_USAGE", `${name} is required`, {
      nextAction,
    });
  }
  return value;
}

function walletArgs(wallet, args) {
  return ["--wallet", wallet, ...args];
}

function defaultReporter(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function parseEnvelope(stderr) {
  for (const line of String(stderr ?? "").split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = parseStrictJson(line.trim(), "command error");
      if (value && typeof value === "object") return value;
    } catch { /* retain the stable local fallback below */ }
  }
  return null;
}

const SECRET_OUTPUT = /(?:\bnsec1|bearer\s+\S+|sign-in-with-x|x-payment|\bsiwx\b|private[_ -]?key|mnemonic|seed phrase|\bcookie\b|service[_ -]?key)/i;

function safeEnvelopeValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return SECRET_OUTPUT.test(typeof value === "string" ? value : JSON.stringify(value)) ? fallback : value;
  } catch {
    return fallback;
  }
}

function boundedFailure(stage, result, fallbackCode, fallbackAction) {
  const envelope = parseEnvelope(result?.stderr);
  const reportedAction = Array.isArray(envelope?.next_actions) && envelope.next_actions.length > 0
    ? envelope.next_actions[0]
    : fallbackAction;
  const action = safeEnvelopeValue(reportedAction, fallbackAction);
  const message = safeEnvelopeValue(envelope?.message, `${stage} failed`);
  throw new BuzzSetupError(
    stage,
    typeof envelope?.code === "string" ? envelope.code : fallbackCode,
    typeof message === "string" ? message : `${stage} failed`,
    {
      mutationState: typeof envelope?.mutation_state === "string" ? envelope.mutation_state : "none",
      nextAction: action,
      details: { exit_code: Number.isInteger(result?.status) ? result.status : null },
    },
  );
}

function run(runner, stage, command, args, fallbackCode, fallbackAction, options = {}) {
  const result = runner(command, args, options);
  if (result?.error || result?.status !== 0) {
    boundedFailure(stage, result, fallbackCode, fallbackAction);
  }
  return String(result.stdout ?? "");
}

function runJson(runner, stage, command, args, fallbackCode, fallbackAction, options = {}) {
  const stdout = run(runner, stage, command, args, fallbackCode, fallbackAction, options);
  try { return parseStrictJson(stdout, `${stage} output`); }
  catch (error) {
    throw new BuzzSetupError(stage, error.code ?? "INVALID_COMMAND_OUTPUT", `${stage} returned invalid JSON`, {
      nextAction: fallbackAction,
    });
  }
}

function installedVersion(runner, npmBin) {
  const result = runner(npmBin, ["list", "-g", "run402", "--depth=0", "--json"], { encoding: "utf8", shell: false });
  if (result?.error || result?.status !== 0) return null;
  try {
    const metadata = parseStrictJson(String(result.stdout ?? ""), "global npm package metadata");
    const version = metadata?.dependencies?.run402?.version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function isCompatible(runner, run402Bin, wallet, version) {
  for (const args of REQUIRED_CAPABILITIES) {
    const result = runner(run402Bin, walletArgs(wallet, args), { encoding: "utf8", shell: false });
    if (result?.error || result?.status !== 0) {
      return { compatible: false, version };
    }
  }
  return { compatible: true, version };
}

function needsInitialization(result) {
  const envelope = parseEnvelope(result?.stderr);
  if (envelope?.code === "NO_ALLOWANCE") return true;
  return Array.isArray(envelope?.next_actions)
    && envelope.next_actions.some((action) => action?.type === "initialize_wallet");
}

function walletAddress(subject) {
  if (typeof subject !== "string") return null;
  const match = subject.match(/(0x[0-9a-fA-F]{40})$/);
  return match?.[1] ?? null;
}

function assertExistingWalletProfile(profile, expectedLabel) {
  const address = typeof profile?.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(profile.address)
    ? profile.address
    : null;
  if (profile?.local_label !== expectedLabel || !address) {
    throw new BuzzSetupError(
      "profile_selection",
      "RUN402_WALLET_NOT_FOUND",
      `No existing Run402 wallet profile named '${expectedLabel}' was found.`,
      {
        nextAction: `Confirm the intended label, then create it separately with: run402 wallets new ${expectedLabel}`,
        details: { profile_label: expectedLabel },
      },
    );
  }
  if (profile?.source !== "flag" || profile?.source_detail !== "--wallet") {
    throw new BuzzSetupError(
      "profile_selection",
      "RUN402_WALLET_SELECTION_MISMATCH",
      "Run402 did not confirm that the requested profile came from the explicit --wallet argument.",
      {
        nextAction: `Stop and inspect run402 --wallet ${expectedLabel} wallets current before retrying setup.`,
        details: {
          profile_label: expectedLabel,
          observed_source: profile?.source ?? null,
          observed_source_detail: profile?.source_detail ?? null,
        },
      },
    );
  }
  return address;
}

function assertAgentWhoami(whoami) {
  const principal = whoami?.principal;
  const authenticator = whoami?.active_authenticator;
  if (!principal || principal.type !== "agent" || authenticator?.kind !== "siwx_eoa") {
    throw new BuzzSetupError(
      "principal_confirmation",
      "RUN402_AGENT_PRINCIPAL_REQUIRED",
      "The active Run402 profile is not a dedicated agent EOA principal.",
      {
        nextAction: "Select or initialize a dedicated agent profile; do not overwrite or reuse a human root, treasury, recovery, or production-owner profile.",
        details: {
          principal_type: principal?.type ?? null,
          authenticator_kind: authenticator?.kind ?? null,
        },
      },
    );
  }
  const address = walletAddress(authenticator.public_subject);
  if (!address) {
    throw new BuzzSetupError("principal_confirmation", "RUN402_WALLET_SUBJECT_INVALID", "The active EOA has no public wallet address.", {
      nextAction: "Inspect the selected Run402 profile and retry with a dedicated EOA profile.",
    });
  }
  return { principal, authenticator, address };
}

function activeNostrLinks(links) {
  const list = Array.isArray(links?.identity_links) ? links.identity_links : [];
  return list.filter((link) =>
    link?.kind === "nostr_nip01"
    && link?.effective_status === "active",
  );
}

function linkMatchesPubkey(link, pubkey) {
  return link?.public_subject === pubkey || link?.display_subject === pubkey;
}

function activeMatchingLink(links, pubkey) {
  return activeNostrLinks(links).find((link) =>
    link?.effective_status === "active"
    && linkMatchesPubkey(link, pubkey),
  ) ?? null;
}

function assertNoConflictingNostrLink(links, pubkey, profileLabel) {
  const conflict = activeNostrLinks(links).find((link) => !linkMatchesPubkey(link, pubkey));
  if (!conflict) return;
  throw new BuzzSetupError(
    "link_inspection",
    "RUN402_NOSTR_IDENTITY_CONFLICT",
    `Run402 wallet profile '${profileLabel}' is already linked to another active Nostr identity.`,
    {
      nextAction: `Stop and inspect the existing public link with: run402 --wallet ${profileLabel} identity link show ${conflict.identity_link_id}`,
      details: {
        profile_label: profileLabel,
        identity_link_id: conflict.identity_link_id ?? null,
        public_subject: conflict.public_subject ?? null,
        display_subject: conflict.display_subject ?? null,
      },
    },
  );
}

function verifyObservedLink(link, proof, pubkey, principalId) {
  if (!link || proof?.identity_link_id !== link.identity_link_id
    || proof?.effective_status !== "active"
    || proof?.nostr_event?.pubkey !== link.public_subject
    || (link.public_subject !== pubkey && link.display_subject !== pubkey)) {
    throw new BuzzSetupError("link_verification", "IDENTITY_LINK_VERIFICATION_MISMATCH", "The independently read identity proof does not match the intended active Buzz identity.", {
      nextAction: "Stop using this profile and inspect the link with run402 identity link show before retrying setup.",
      details: { principal_id: principalId, identity_link_id: link?.identity_link_id ?? null },
    });
  }
}

export async function runSetup({
  pubkey,
  wallet,
  runner = defaultRunner,
  run402Bin,
  npmBin = "npm",
  helperPath = join(HERE, "buzz-publish-proof.mjs"),
  temporaryRoot = tmpdir(),
  reporter = defaultReporter,
} = {}) {
  if (typeof wallet !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(wallet) || wallet === "default") {
    throw new BuzzSetupError("input", "BAD_USAGE", "A named Run402 wallet profile is required.", {
      nextAction: "Choose the intended dedicated profile from `run402 wallets list`, then retry with --wallet <profile>.",
    });
  }
  if (typeof pubkey !== "string" || pubkey.length === 0) {
    throw new BuzzSetupError("input", "BAD_USAGE", "A public Buzz agent npub or hex pubkey is required.", {
      nextAction: "Read the current Buzz agent pubkey from the managed-agent context and retry setup.",
    });
  }

  const globalRun402Bin = run402Bin ?? globalRun402Executable(runner, npmBin);

  let cliState = "reused";
  let version = installedVersion(runner, npmBin);
  const installOrUpdateCli = () => {
    run(
      runner,
      "cli_install",
      npmBin,
      ["install", "-g", "run402@latest"],
      "RUN402_GLOBAL_INSTALL_FAILED",
      "Fix the user's global npm installation, then rerun setup.",
    );
    cliState = "installed_or_updated";
    version = installedVersion(runner, npmBin);
    if (!version) {
      throw new BuzzSetupError("cli_capability", "RUN402_REQUIRED_CAPABILITY_MISSING", "The global Run402 CLI is unavailable after installation.", {
        nextAction: "Verify the global npm bin is on PATH, then rerun setup.",
      });
    }
  };
  if (!version) installOrUpdateCli();

  let walletInspectionCapability = runner(
    globalRun402Bin,
    walletArgs(wallet, ["wallets", "current", "--help"]),
    { encoding: "utf8", shell: false },
  );
  if (walletInspectionCapability?.error || walletInspectionCapability?.status !== 0) {
    if (cliState === "reused") installOrUpdateCli();
    walletInspectionCapability = runner(
      globalRun402Bin,
      walletArgs(wallet, ["wallets", "current", "--help"]),
      { encoding: "utf8", shell: false },
    );
    if (walletInspectionCapability?.error || walletInspectionCapability?.status !== 0) {
      throw new BuzzSetupError("cli_capability", "RUN402_REQUIRED_CAPABILITY_MISSING", "The global Run402 CLI cannot inspect an explicitly selected wallet profile.", {
        nextAction: "Verify the global npm bin is on PATH and update run402, then rerun setup.",
        details: { version },
      });
    }
  }

  const selectedProfile = runJson(
    runner,
    "profile_selection",
    globalRun402Bin,
    walletArgs(wallet, ["wallets", "current"]),
    "RUN402_PROFILE_INSPECTION_FAILED",
    `Inspect the intended profile with run402 --wallet ${wallet} wallets current, then rerun setup.`,
  );
  const selectedWalletAddress = assertExistingWalletProfile(selectedProfile, wallet);

  let capability = isCompatible(runner, globalRun402Bin, wallet, version);
  if (!capability.compatible) {
    if (cliState === "reused") installOrUpdateCli();
    capability = isCompatible(runner, globalRun402Bin, wallet, version);
    if (!capability.compatible) {
      throw new BuzzSetupError("cli_capability", "RUN402_REQUIRED_CAPABILITY_MISSING", "The global Run402 CLI still lacks required setup or identity-link commands.", {
        nextAction: "Verify the global npm bin is on PATH and update run402, then rerun setup.",
        details: { version: capability.version },
      });
    }
  }

  let profileState = "reused";
  let whoamiResult = runner(globalRun402Bin, walletArgs(wallet, ["org", "whoami"]), { encoding: "utf8", shell: false });
  if (whoamiResult?.error || whoamiResult?.status !== 0) {
    if (!needsInitialization(whoamiResult)) {
      boundedFailure(
        "profile_inspection",
        whoamiResult,
        "RUN402_PROFILE_INSPECTION_FAILED",
        "Inspect the selected global Run402 profile and retry setup.",
      );
    }
    runJson(
      runner,
      "profile_initialization",
      globalRun402Bin,
      walletArgs(wallet, ["init"]),
      "RUN402_INIT_FAILED",
      "Resolve the reported Run402 initialization problem, then rerun setup.",
    );
    profileState = "initialized";
    whoamiResult = runner(globalRun402Bin, walletArgs(wallet, ["org", "whoami"]), { encoding: "utf8", shell: false });
    if (whoamiResult?.error || whoamiResult?.status !== 0) {
      boundedFailure(
        "principal_confirmation",
        whoamiResult,
        "RUN402_WHOAMI_FAILED",
        "Verify the initialized agent profile can authenticate, then rerun setup.",
      );
    }
  }

  let whoami;
  try { whoami = parseStrictJson(String(whoamiResult.stdout ?? ""), "whoami output"); }
  catch (error) {
    throw new BuzzSetupError("principal_confirmation", error.code ?? "RUN402_WHOAMI_INVALID", "Run402 whoami returned invalid JSON.", {
      nextAction: "Update or repair the global Run402 CLI, then rerun setup.",
    });
  }
  const identity = assertAgentWhoami(whoami);
  if (identity.address.toLowerCase() !== selectedWalletAddress.toLowerCase()) {
    throw new BuzzSetupError("principal_confirmation", "RUN402_WALLET_ADDRESS_MISMATCH", "The selected profile address changed between local inspection and authenticated principal confirmation.", {
      nextAction: `Stop and inspect run402 --wallet ${wallet} wallets current plus org whoami before retrying.`,
      details: { profile_label: wallet, wallet_address: selectedWalletAddress },
    });
  }
  let links = runJson(
    runner,
    "link_inspection",
    globalRun402Bin,
    walletArgs(wallet, ["identity", "link", "list"]),
    "IDENTITY_LINK_LIST_FAILED",
    "Inspect the active Run402 profile's identity links, then rerun setup.",
  );
  assertNoConflictingNostrLink(links, pubkey, wallet);
  let link = activeMatchingLink(links, pubkey);
  let linkState = "reused";

  reporter({
    status: "progress",
    stage: "profile_selection",
    mutation_state: "none",
    profile_label: wallet,
    wallet_address: identity.address,
    selection_source: "explicit_argument",
  });

  if (!link) {
    const privateTempDir = mkdtempSync(join(temporaryRoot, "run402-buzz-"));
    chmodSync(privateTempDir, 0o700);
    const beginPath = join(privateTempDir, "begin.json");
    const eventPath = join(privateTempDir, "event.json");
    try {
      const begin = runJson(
        runner,
        "link_begin",
        globalRun402Bin,
        walletArgs(wallet, ["identity", "link", "nostr", "begin", "--pubkey", pubkey, "--visibility", "public"]),
        "IDENTITY_LINK_BEGIN_FAILED",
        "Resolve the challenge error and rerun setup; an expired challenge requires a fresh event.",
      );
      writeFileSync(beginPath, `${JSON.stringify(begin)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      runJson(
        runner,
        "buzz_publish",
        process.execPath,
        [helperPath, "--begin", beginPath, "--event", eventPath],
        "BUZZ_PUBLIC_PROOF_FAILED",
        "Update Buzz or restore its public social publish/raw-event capability, then rerun setup with a fresh challenge.",
      );
      const completed = runJson(
        runner,
        "link_complete",
        globalRun402Bin,
        walletArgs(wallet, ["identity", "link", "nostr", "complete", "--event-file", eventPath]),
        "IDENTITY_LINK_COMPLETE_FAILED",
        "Use the reported stable code to correct the public event or create a fresh challenge, then rerun setup.",
      );
      linkState = "created";
      links = runJson(
        runner,
        "link_reinspection",
        globalRun402Bin,
        walletArgs(wallet, ["identity", "link", "list"]),
        "IDENTITY_LINK_LIST_FAILED",
        "Inspect the completed identity link before retrying setup.",
      );
      link = activeMatchingLink(links, pubkey);
      if (!link && typeof completed?.identity_link_id === "string") {
        link = { ...completed, identity_link_id: completed.identity_link_id };
      }
    } finally {
      rmSync(privateTempDir, { recursive: true, force: true });
    }
  }

  if (!link?.identity_link_id) {
    throw new BuzzSetupError("link_verification", "IDENTITY_LINK_NOT_OBSERVED", "The intended Buzz identity link was not visible after setup.", {
      nextAction: "Inspect run402 identity link list and retry setup without publishing another proof unless the intended link is absent.",
    });
  }
  const proof = runJson(
    runner,
    "link_verification",
    globalRun402Bin,
    walletArgs(wallet, ["identity", "link", "show", link.identity_link_id]),
    "IDENTITY_LINK_SHOW_FAILED",
    "Inspect the public proof by identity-link id, then rerun setup.",
  );
  verifyObservedLink(link, proof, pubkey, identity.principal.id);

  const finalWhoami = runJson(
    runner,
    "final_identity_verification",
    globalRun402Bin,
    walletArgs(wallet, ["org", "whoami"]),
    "RUN402_WHOAMI_FAILED",
    "Verify the dedicated agent profile and intended public identity link, then rerun setup.",
  );
  const finalIdentity = assertAgentWhoami(finalWhoami);
  const finalLink = activeMatchingLink({ identity_links: finalWhoami.linked_identities }, pubkey);
  if (!finalLink || finalLink.identity_link_id !== link.identity_link_id
    || finalIdentity.principal.id !== identity.principal.id
    || finalIdentity.address.toLowerCase() !== identity.address.toLowerCase()) {
    throw new BuzzSetupError("final_identity_verification", "IDENTITY_LINK_VERIFICATION_MISMATCH", "Final whoami does not show the independently verified Buzz identity link.", {
      nextAction: "Stop before deployment and inspect run402 org whoami plus identity link show.",
      details: { identity_link_id: link.identity_link_id },
    });
  }

  return {
    status: "ready",
    cli: { version: capability.version, state: cliState, installation: "user_global_npm" },
    profile: {
      state: profileState,
      profile_label: wallet,
      wallet_address: finalIdentity.address,
      selection_source: "explicit_argument",
    },
    buzz_identity: {
      public_subject: finalLink.public_subject,
      display_subject: finalLink.display_subject,
    },
    run402_wallet: finalIdentity.address,
    principal_id: finalIdentity.principal.id,
    principal_type: finalIdentity.principal.type,
    identity_link: {
      identity_link_id: finalLink.identity_link_id,
      status: finalLink.effective_status,
      state: linkState,
    },
    deployment: "none",
    next_action: {
      type: "offer_contextual_test",
      requires_approval: true,
    },
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node setup.mjs --wallet <existing-profile> --pubkey <Buzz agent npub|hex>");
    return;
  }
  try {
    const argv = process.argv.slice(2);
    const result = await runSetup({
      wallet: requiredFlag(argv, "--wallet", "Choose the intended dedicated profile from `run402 wallets list`, then retry with --wallet <profile>."),
      pubkey: requiredFlag(argv, "--pubkey", "Run this setup again with --pubkey set to the public Buzz agent npub or hex pubkey."),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const body = error instanceof BuzzSetupError
      ? error.toJSON()
      : new BuzzSetupError("setup", error?.code ?? "RUN402_BUZZ_SETUP_FAILED", error?.message ?? String(error), {
        nextAction: "Inspect the local setup error and rerun without exposing credentials.",
      }).toJSON();
    console.error(JSON.stringify(body));
    process.exitCode = 1;
  }
}

if (process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  await main();
}
