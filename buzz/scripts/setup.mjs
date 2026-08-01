#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";
import { rerunDoctorAction, setupRejectionCode, validatePassingDoctorReport } from "./doctor-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRED_CAPABILITIES = [
  ["init", "--help"],
  ["wallets", "current", "--help"],
  ["org", "whoami", "--help"],
  ["identity", "link", "nostr", "begin", "--help"],
  ["identity", "link", "nostr", "complete", "--help"],
  ["identity", "link", "list", "--help"],
  ["identity", "link", "show", "--help"],
  ["buzz", "status", "--help"],
  ["buzz", "install", "discover", "--help"],
];
export const BUZZ_SETUP_MIN_RUN402_VERSION = "4.17.2";

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

function safeRealpath(path) {
  try { return realpathSync(path); }
  catch { return path; }
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

function normalizedVersion(value) {
  const match = String(value ?? "").trim().match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function compareVersions(left, right) {
  const a = normalizedVersion(left)?.split(".").map(Number);
  const b = normalizedVersion(right)?.split(".").map(Number);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function executableVersion(runner, run402Bin) {
  const result = runner(run402Bin, ["--version"], { encoding: "utf8", shell: false });
  if (result?.error || result?.status !== 0) return null;
  return normalizedVersion(result.stdout);
}

function run402CliRepair({ upgrade }) {
  return {
    type: upgrade ? "upgrade_run402_cli" : "install_run402_cli",
    surface: "shell",
    command: "npm install -g run402@latest",
    argv: ["npm", "install", "-g", "run402@latest"],
    why: upgrade
      ? `Upgrade the user-global Run402 CLI to ${BUZZ_SETUP_MIN_RUN402_VERSION} or newer before Buzz setup.`
      : `Install Run402 ${BUZZ_SETUP_MIN_RUN402_VERSION} or newer in the user-global npm context used by the Buzz setup helper.`,
    safe_to_auto_execute: true,
    requires_approval: false,
    destructive: false,
    idempotent: true,
    spend_impact: { currency: "USD", max_amount: "0" },
  };
}

function cliMeetsBuzzSemanticFloor(packageVersion, runningVersion) {
  const packageComparison = compareVersions(packageVersion, BUZZ_SETUP_MIN_RUN402_VERSION);
  const runningComparison = compareVersions(runningVersion, BUZZ_SETUP_MIN_RUN402_VERSION);
  return packageComparison !== null && packageComparison >= 0
    && runningComparison !== null && runningComparison >= 0;
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

function buzzCommunitySubjectFromRelay(relayUrl) {
  if (typeof relayUrl !== "string" || relayUrl.trim() === "") return null;
  try {
    const parsed = new URL(relayUrl);
    if (!["ws:", "wss:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) return null;
    return `buzz:community:${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function discoverCommunityInstallations({ runner, run402Bin, wallet, relayUrl }) {
  const communitySubject = buzzCommunitySubjectFromRelay(relayUrl);
  if (!communitySubject) {
    return { status: "unavailable", installations: [], default_installations: [] };
  }
  const discovered = runner(
    run402Bin,
    walletArgs(wallet, ["buzz", "install", "discover", "--community", communitySubject]),
    { encoding: "utf8", shell: false },
  );
  if (discovered?.error || discovered?.status !== 0) {
    return { status: "unavailable", installations: [], default_installations: [] };
  }
  let parsed;
  try { parsed = parseStrictJson(String(discovered.stdout ?? ""), "Run402 community descriptor discovery output"); }
  catch {
    return { status: "invalid", installations: [], default_installations: [] };
  }
  const candidates = Array.isArray(parsed) ? parsed : [];
  const verified = candidates.flatMap((descriptor) => descriptor?.status === "active"
    && descriptor?.provider === "run402"
    && descriptor?.buzz_community_subject === communitySubject
    && typeof descriptor?.buzz_community_installation_id === "string"
    && typeof descriptor?.org_id === "string"
    && Number.isSafeInteger(descriptor?.descriptor_revision)
    && typeof descriptor?.content_hash === "string"
    && descriptor?.approval_event?.kind === 1
    && ["owner", "admin"].includes(descriptor?.authority_membership?.role)
    && typeof descriptor?.relay_self === "string"
    ? [{
        buzz_community_installation_id: descriptor.buzz_community_installation_id,
        buzz_community_subject: descriptor.buzz_community_subject,
        org_id: descriptor.org_id,
        descriptor_revision: descriptor.descriptor_revision,
        default_for_enrollment: descriptor.default_for_enrollment === true,
        safe_policy_summary: descriptor.safe_policy_summary,
        verified: true,
      }]
    : []);
  return {
    status: "run402_verified",
    installations: verified,
    default_installations: verified.filter((entry) => entry.default_for_enrollment),
  };
}

export async function runSetup({
  pubkey,
  wallet,
  runner = defaultRunner,
  run402Bin,
  npmBin = "npm",
  relayUrl = process.env.BUZZ_RELAY_URL,
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
  let packageVersion = installedVersion(runner, npmBin);
  let version = executableVersion(runner, globalRun402Bin);
  if (!cliMeetsBuzzSemanticFloor(packageVersion, version)) {
    const upgrade = Boolean(packageVersion || version);
    const repair = run402CliRepair({ upgrade });
    const installResult = runner(npmBin, repair.argv.slice(1), { encoding: "utf8", shell: false });
    if (installResult?.error || installResult?.status !== 0) {
      throw new BuzzSetupError(
        "buzz_preflight",
        upgrade ? "BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE" : "BUZZ_PREFLIGHT_RUN402_UNAVAILABLE",
        "The agent could not converge the user-global Run402 CLI before setup.",
        {
          mutationState: "not_started",
          nextAction: repair,
          details: {
            installed_version: packageVersion,
            executing_version: version,
            minimum_version: BUZZ_SETUP_MIN_RUN402_VERSION,
            cli_update_state: "failed_or_unknown",
          },
        },
      );
    }
    packageVersion = installedVersion(runner, npmBin);
    version = executableVersion(runner, globalRun402Bin);
    if (!cliMeetsBuzzSemanticFloor(packageVersion, version)) {
      throw new BuzzSetupError("buzz_preflight", "BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE", "The Run402 CLI remained below the Buzz semantic compatibility floor after its one safe update attempt.", {
        mutationState: "not_started",
        nextAction: repair,
        details: {
          installed_version: packageVersion,
          executing_version: version,
          minimum_version: BUZZ_SETUP_MIN_RUN402_VERSION,
          cli_update_state: "version_not_converged",
        },
      });
    }
    cliState = upgrade ? "updated" : "installed";
  }

  const doctorResult = runner(
    globalRun402Bin,
    walletArgs(wallet, ["doctor", "--buzz", "--buzz-agent", pubkey]),
    { encoding: "utf8", shell: false },
  );
  let doctorReport = null;
  try { doctorReport = parseStrictJson(String(doctorResult?.stdout ?? ""), "Buzz doctor output"); }
  catch { /* mapped to the frozen invalid-report repair below */ }
  const validation = validatePassingDoctorReport(doctorReport, {
    wallet,
    nodeExecutable: safeRealpath(process.execPath),
    run402Executable: safeRealpath(globalRun402Bin),
    relayUrl,
  });
  if (!validation.valid) {
    const blockedCheck = validation.blockedCheck;
    throw new BuzzSetupError(
      "buzz_preflight",
      blockedCheck?.code ?? setupRejectionCode(validation.reason),
      blockedCheck?.message ?? "Buzz setup requires a fresh, unedited, passing doctor report for this exact agent and profile.",
      {
        mutationState: "not_started",
        nextAction: blockedCheck?.next_actions?.[0] ?? rerunDoctorAction(wallet, pubkey),
        details: {
          preflight_reason: validation.reason,
          doctor_exit_code: Number.isInteger(doctorResult?.status) ? doctorResult.status : null,
          preflight: doctorReport,
        },
      },
    );
  }
  const relayWarning = doctorReport.checks.find((check) =>
    check?.name === "buzz_relay"
    && check?.status === "warning"
    && check?.code === "BUZZ_PREFLIGHT_RELAY_UNREACHABLE",
  ) ?? null;

  let walletInspectionCapability = runner(
    globalRun402Bin,
    walletArgs(wallet, ["wallets", "current", "--help"]),
    { encoding: "utf8", shell: false },
  );
  if (walletInspectionCapability?.error || walletInspectionCapability?.status !== 0) {
    throw new BuzzSetupError("cli_capability", "RUN402_REQUIRED_CAPABILITY_MISSING", "The global Run402 CLI cannot inspect an explicitly selected wallet profile.", {
      nextAction: rerunDoctorAction(wallet, pubkey),
      details: { version },
    });
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
    throw new BuzzSetupError("cli_capability", "RUN402_REQUIRED_CAPABILITY_MISSING", "The global Run402 CLI lacks required setup or identity-link commands after a passing doctor.", {
      nextAction: rerunDoctorAction(wallet, pubkey),
      details: { version: capability.version },
    });
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
        "Restore the released Buzz public social publish/raw-event capability, then rerun setup with a fresh challenge; no Buzz change is required.",
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


  const controlPlaneStatus = runJson(
    runner,
    "buzz_control_plane_status",
    globalRun402Bin,
    walletArgs(wallet, ["buzz", "status"]),
    "RUN402_BUZZ_STATUS_FAILED",
    "Update the Run402 CLI and retry the read-only Buzz control-plane status check.",
  );
  const remoteBuzz = controlPlaneStatus?.supported === true
    && controlPlaneStatus?.buzz && typeof controlPlaneStatus.buzz === "object"
    ? controlPlaneStatus.buzz
    : null;
  const communityDiscovery = remoteBuzz && !relayWarning
    ? discoverCommunityInstallations({ runner, run402Bin: globalRun402Bin, wallet, relayUrl })
    : relayWarning
      ? {
          status: "relay_unavailable",
          installations: [],
          default_installations: [],
          next_action: relayWarning.next_actions?.[0] ?? null,
        }
      : { status: "gateway_not_supported", installations: [], default_installations: [] };
  const defaultInstallations = communityDiscovery.default_installations;
  const coldStartFallbackAvailable = remoteBuzz?.eligibility?.cold_start_fallback_available === true;
  const enrollmentResources = Array.isArray(remoteBuzz?.agent_enrollments) ? remoteBuzz.agent_enrollments : [];
  const activeEnrollments = enrollmentResources.filter((entry) => entry?.status === "active");
  const nonterminalEnrollments = enrollmentResources.filter((entry) => entry?.status === "pending" || entry?.status === "active");
  const canSelectCommunityInstallation = remoteBuzz?.eligibility?.can_select_community_installation === true
    || (remoteBuzz?.eligibility?.can_request_enrollment === true && nonterminalEnrollments.length === 0);
  const canRequestEnrollment = !relayWarning && canSelectCommunityInstallation && nonterminalEnrollments.length === 0;
  const nextAction = canRequestEnrollment && activeEnrollments.length === 0 && defaultInstallations.length === 1
    ? {
        type: "offer_community_enrollment",
        buzz_community_installation_id: defaultInstallations[0].buzz_community_installation_id,
        org_id: defaultInstallations[0].org_id,
        requires_approval: true,
        fallback: coldStartFallbackAvailable ? "org_of_one" : null,
      }
    : canRequestEnrollment && activeEnrollments.length === 0 && defaultInstallations.length > 1
      ? {
          type: "resolve_ambiguous_community_installation",
          candidate_ids: defaultInstallations.map((entry) => entry.buzz_community_installation_id),
          requires_approval: true,
          fallback: coldStartFallbackAvailable ? "org_of_one" : null,
        }
      : { type: "offer_contextual_test", requires_approval: true };

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
    control_plane: {
      protocol: "run402.buzz-control-plane.v1",
      supported: controlPlaneStatus?.supported === true,
      skill_installation: { status: "installed", authoritative: false },
      human_adoption: {
        status: Array.isArray(remoteBuzz?.human_adoptions) && remoteBuzz.human_adoptions.length > 0 ? "observed" : "none",
        resources: Array.isArray(remoteBuzz?.human_adoptions) ? remoteBuzz.human_adoptions : [],
      },
      community_installation: {
        status: communityDiscovery.status,
        resources: communityDiscovery.installations,
        ...(communityDiscovery.next_action ? { next_action: communityDiscovery.next_action } : {}),
      },
      agent_enrollment: {
        status: activeEnrollments.length > 0 ? "active"
          : nonterminalEnrollments.some((entry) => entry?.status === "pending") ? "pending" : "none",
        resources: Array.isArray(remoteBuzz?.agent_enrollments) ? remoteBuzz.agent_enrollments : [],
      },
      cold_start_fallback_available: coldStartFallbackAvailable,
    },
    deployment: "none",
    next_action: nextAction,
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
