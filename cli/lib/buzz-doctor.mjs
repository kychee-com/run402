import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { delimiter, extname, join } from "node:path";
import ipaddr from "ipaddr.js";
import { bech32 } from "@scure/base";
import { activeProfile, apiBase } from "./config.mjs";
import { currentRun402Version, detectInstallContext, doctorUpdateCheck } from "./update-check.mjs";
import { profileExists, readMeta } from "../core-dist/profiles.js";
import {
  BUZZ_DOCTOR_CHECK_ORDER,
  BUZZ_DOCTOR_CONTRACT,
  BUZZ_DOCTOR_CONTRACT_ID,
} from "./buzz-doctor-contract.mjs";

const BUZZ_CAPABILITIES = JSON.parse(readFileSync(
  new URL("../fixtures/buzz-v0.5.2-cli-capabilities.json", import.meta.url),
  "utf8",
));

export const BUZZ_DOCTOR_TIMEOUT_MS = 3_000;
export const BUZZ_DOCTOR_MAX_RESPONSE_BYTES = 64 * 1024;
export const BUZZ_DOCTOR_MIN_NODE_MAJOR = 22;
// v4.17.2 is the first client whose Buzz doctor keeps a safely contained relay
// availability failure warning-only for founder-agent setup. Older clients can
// expose the same command surface while enforcing the wrong setup semantics.
export const BUZZ_DOCTOR_MIN_RUN402_VERSION = "4.17.2";

const SPEND_NONE = Object.freeze({ currency: "USD", max_amount: "0" });
const SAFE_TOKEN = /^[A-Za-z0-9_./:=@+,-]+$/;

export const BUZZ_DOCTOR_REPAIR_MATRIX = Object.freeze({
  BUZZ_PREFLIGHT_SHELL_UNAVAILABLE: { type: "repair_buzz_agent_runtime", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_NODE_UNAVAILABLE: { type: "repair_buzz_node_runtime", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_NODE_INCOMPATIBLE: { type: "repair_buzz_node_runtime", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_RUN402_UNAVAILABLE: { type: "install_run402_cli", surface: "shell" },
  BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE: { type: ["upgrade_run402_cli", "inspect_run402_cli", "install_run402_cli"], surface: "shell" },
  BUZZ_PREFLIGHT_RUN402_UPDATE_AVAILABLE: { type: "upgrade_run402_cli", surface: "shell" },
  BUZZ_PREFLIGHT_BUZZ_CLI_UNAVAILABLE: { type: "repair_buzz_cli_sidecar", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_BUZZ_CLI_INCOMPATIBLE: { type: "repair_buzz_cli_sidecar", surface: "buzz_settings" },
  BUZZ_AGENT_TARGET_REQUIRED: { type: "rerun_buzz_setup_with_explicit_identity", surface: "buzz_chat" },
  BUZZ_AGENT_TARGET_UNVERIFIED: { type: ["publish_buzz_public_profile", "repair_buzz_cli_sidecar"], surface: ["buzz_chat", "buzz_settings"] },
  BUZZ_AGENT_TARGET_MISMATCH: { type: "select_expected_buzz_agent", surface: "buzz_chat" },
  BUZZ_PREFLIGHT_API_UNREACHABLE: { type: "restore_run402_api_access", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_CONSOLE_UNREACHABLE: { type: "restore_run402_console_access", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_RELAY_UNSAFE: { type: "repair_buzz_relay_url", surface: "buzz_settings" },
  BUZZ_PREFLIGHT_RELAY_UNREACHABLE: {
    type: ["repair_buzz_relay_tls", "repair_buzz_relay_dns", "repair_buzz_relay_service", "restore_buzz_relay_access"],
    surface: "buzz_settings",
  },
  BUZZ_PREFLIGHT_WALLET_PROFILE_REQUIRED: { type: "rerun_buzz_setup_with_explicit_identity", surface: "buzz_chat" },
  BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND: { type: "create_buzz_wallet_profile", surface: "shell" },
  BUZZ_PREFLIGHT_WALLET_PROFILE_MISMATCH: { type: "rerun_buzz_doctor", surface: "shell" },
});

export function normalizeNostrSubject(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (!normalized.startsWith("npub1")) return null;
  try {
    const decoded = bech32.decode(normalized);
    if (decoded.prefix !== "npub") return null;
    const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
    return bytes.length === 32 ? Buffer.from(bytes).toString("hex") : null;
  } catch {
    return null;
  }
}

export function parseBuzzDoctorArgs(all = []) {
  const buzzIndexes = indexesOf(all, "--buzz");
  const agentIndexes = indexesOf(all, "--buzz-agent");
  if (agentIndexes.length > 0 && buzzIndexes.length === 0) {
    return { error: usageError("BUZZ_MODE_REQUIRED", "--buzz-agent requires --buzz", "--buzz-agent") };
  }
  if (buzzIndexes.length > 1) return { error: usageError("DUPLICATE_FLAG", "--buzz may be supplied only once", "--buzz") };
  if (agentIndexes.length > 1) return { error: usageError("DUPLICATE_FLAG", "--buzz-agent may be supplied only once", "--buzz-agent") };
  if (buzzIndexes.length === 0) return { buzz: false, expectedSubjectHex: null };
  let expectedSubjectHex = null;
  if (agentIndexes.length === 1) {
    const raw = all[agentIndexes[0] + 1];
    if (!raw || raw.startsWith("--")) {
      return { error: usageError("BAD_FLAG", "--buzz-agent requires an npub or 64-character hex value", "--buzz-agent") };
    }
    expectedSubjectHex = normalizeNostrSubject(raw);
    if (!expectedSubjectHex) {
      return { error: usageError("BAD_BUZZ_AGENT", "--buzz-agent must be an npub or 64-character hex public key", "--buzz-agent") };
    }
  }
  return { buzz: true, expectedSubjectHex };
}

export async function buildBuzzDoctorReport({
  expectedSubjectHex = null,
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  cliExecutable = process.argv[1],
  cwd = process.cwd(),
  platform = process.platform,
  now = Date.now(),
  runCommand = defaultRunCommand,
  lookup = dnsLookup,
  pinnedRelayRead = defaultPinnedRelayRead,
  originProbe = defaultOriginProbe,
  updateCheck = doctorUpdateCheck,
  getActiveProfile = activeProfile,
  profileExistsImpl = profileExists,
  readMetaImpl = readMeta,
  apiOrigin = apiBase(),
  consoleOrigin = "https://console.run402.com",
} = {}) {
  const shellPath = configuredShell(env, platform);
  const nodeExecutable = safeRealpath(execPath) ?? execPath ?? null;
  const run402Executable = safeRealpath(cliExecutable) ?? cliExecutable ?? null;
  const walletProfile = getActiveProfile();
  const relay = parseRelayOrigin(env.BUZZ_RELAY_URL);
  const binding = {
    contract_id: BUZZ_DOCTOR_CONTRACT_ID,
    expected_subject_hex: expectedSubjectHex,
    wallet_profile: walletProfile,
    node_executable: nodeExecutable,
    run402_executable: run402Executable,
    relay_origin: relay?.origin ?? null,
  };

  const sessionShell = checkSessionShell({ shellPath, platform, runCommand });
  const nodeRuntime = checkNodeRuntime({ nodeExecutable, runCommand });
  const run402Cli = await checkRun402Cli({ cwd, env, argv, run402Executable, updateCheck });
  const buzzExecutable = findExecutable("buzz", env, platform);
  const buzzCli = checkBuzzCli({ buzzExecutable, runCommand });

  const [buzzAgentTarget, run402Api, run402Console, buzzRelay, walletProfileCheck] = await Promise.all([
    checkBuzzAgentTarget({ expectedSubjectHex, buzzExecutable, buzzCli, runCommand }),
    checkOrigin("run402_api", apiOrigin, "BUZZ_PREFLIGHT_API_UNREACHABLE", originProbe, apiRepair(apiOrigin)),
    checkOrigin("run402_console", consoleOrigin, "BUZZ_PREFLIGHT_CONSOLE_UNREACHABLE", originProbe, consoleRepair()),
    checkBuzzRelay({ relay, lookup, pinnedRelayRead }),
    Promise.resolve(checkWalletProfile({ walletProfile, env, profileExistsImpl, readMetaImpl, expectedSubjectHex })),
  ]);

  const checks = [
    sessionShell,
    nodeRuntime,
    run402Cli,
    buzzCli,
    buzzAgentTarget,
    run402Api,
    run402Console,
    buzzRelay,
    walletProfileCheck,
  ];
  if (checks.some((check, index) => check.name !== BUZZ_DOCTOR_CHECK_ORDER[index])) {
    throw new Error("Buzz doctor check order drifted from the frozen contract");
  }
  return {
    ok: checks.every((check) => check.status !== "blocked"),
    mode: "buzz",
    contract_id: BUZZ_DOCTOR_CONTRACT_ID,
    generated_at: new Date(now).toISOString(),
    mutation_state: BUZZ_DOCTOR_CONTRACT.zero_mutation.mutation_state,
    binding,
    checks,
    telemetry: {
      status: env.RUN402_TELEMETRY === "0" ? "disabled" : "not_configured",
      queued: false,
    },
  };
}

function checkSessionShell({ shellPath, platform, runCommand }) {
  if (!shellPath) return blocked("session_shell", "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE", "The managed session has no configured shell executable.", shellRepair());
  const args = platform === "win32" ? ["/d", "/s", "/c", "exit", "0"] : ["-c", ":"];
  const result = runCommand(shellPath, args, { timeout: BUZZ_DOCTOR_TIMEOUT_MS, shell: false });
  if (!commandPassed(result)) {
    return blocked("session_shell", "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE", "The configured shell cannot execute a bounded no-op.", shellRepair(), {
      shell: safePath(shellPath),
      failure: commandFailureClass(result),
    });
  }
  return ok("session_shell", { shell: safePath(shellPath) });
}

function checkNodeRuntime({ nodeExecutable, runCommand }) {
  if (!nodeExecutable) return blocked("node_runtime", "BUZZ_PREFLIGHT_NODE_UNAVAILABLE", "The managed session has no Node executable.", nodeRepair());
  const result = runCommand(nodeExecutable, ["--version"], { timeout: BUZZ_DOCTOR_TIMEOUT_MS, shell: false });
  if (!commandPassed(result)) {
    return blocked("node_runtime", "BUZZ_PREFLIGHT_NODE_UNAVAILABLE", "The exact Node executable cannot be spawned.", nodeRepair(), {
      executable: safePath(nodeExecutable),
      failure: commandFailureClass(result),
    });
  }
  const version = String(result.stdout ?? "").trim();
  const major = Number(version.match(/^v?(\d+)/)?.[1]);
  if (!Number.isSafeInteger(major) || major < BUZZ_DOCTOR_MIN_NODE_MAJOR) {
    return blocked("node_runtime", "BUZZ_PREFLIGHT_NODE_INCOMPATIBLE", `Node ${BUZZ_DOCTOR_MIN_NODE_MAJOR}+ is required by this Run402 package.`, nodeRepair(), {
      executable: safePath(nodeExecutable),
      version: version || null,
      required_major: BUZZ_DOCTOR_MIN_NODE_MAJOR,
    });
  }
  return ok("node_runtime", { executable: safePath(nodeExecutable), version, major, compatibility_source: "version" });
}

async function checkRun402Cli({ cwd, env, argv, run402Executable, updateCheck }) {
  if (!run402Executable) {
    return blocked("run402_cli", "BUZZ_PREFLIGHT_RUN402_UNAVAILABLE", "The Run402 CLI executable is unavailable.", run402InstallRepair());
  }
  const version = currentRun402Version();
  const install = detectInstallContext({ cwd, env, argv, execPath: run402Executable });
  if (compareMajorMinorPatch(version, BUZZ_DOCTOR_MIN_RUN402_VERSION) < 0) {
    return blocked("run402_cli", "BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE", "The executing Run402 CLI predates the Buzz doctor contract.", run402RepairForInstall(install, cwd), {
      version,
      minimum_version: BUZZ_DOCTOR_MIN_RUN402_VERSION,
      executable: safePath(run402Executable),
      install_context: install.kind,
    });
  }
  let update = null;
  try {
    update = await updateCheck({ refresh: false, cwd, env, argv, execPath: run402Executable, current: version });
  } catch {
    update = null;
  }
  const value = {
    version,
    executable: safePath(run402Executable),
    install_context: install.kind,
    install_confidence: install.confidence,
    package_manager: install.package_manager,
    compatibility_source: "version_and_capability_probe",
    required_capabilities: ["doctor --buzz", "doctor --buzz-agent", "wallets current", "org whoami", "identity link nostr"],
  };
  if (update?.status === "warning") {
    const rawAction = update?.value?.next_actions?.[0];
    return warning("run402_cli", "BUZZ_PREFLIGHT_RUN402_UPDATE_AVAILABLE", "A newer compatible Run402 CLI is available; setup may continue.", normalizeUpgradeAction(rawAction, install, cwd), value);
  }
  return ok("run402_cli", value);
}

function checkBuzzCli({ buzzExecutable, runCommand }) {
  if (!buzzExecutable) {
    return blocked("buzz_cli", "BUZZ_PREFLIGHT_BUZZ_CLI_UNAVAILABLE", "The managed Buzz CLI sidecar is unavailable.", buzzSidecarRepair());
  }
  const observations = [];
  for (const probe of BUZZ_CAPABILITIES.help_probes) {
    const args = probe.argv.slice(1);
    const result = runCommand(buzzExecutable, args, { timeout: BUZZ_DOCTOR_TIMEOUT_MS, shell: false });
    const output = String(result?.stdout ?? "");
    const compatible = commandPassed(result) && probe.stdout_contains.every((fragment) => output.includes(fragment));
    observations.push({ capability: args.join(" "), compatible });
    if (!compatible) {
      return blocked("buzz_cli", "BUZZ_PREFLIGHT_BUZZ_CLI_INCOMPATIBLE", "The managed Buzz CLI lacks a released capability required by setup.", buzzSidecarRepair(), {
        executable: safePath(buzzExecutable),
        fixture_id: BUZZ_CAPABILITIES.fixture_id,
        compatibility_source: "capability_probe",
        observations,
      });
    }
  }
  return ok("buzz_cli", {
    executable: safePath(buzzExecutable),
    fixture_id: BUZZ_CAPABILITIES.fixture_id,
    install_context: "managed_buzz_sidecar",
    compatibility_source: "capability_probe",
    version_status: "version_unknown_capabilities_ok",
    observations,
  });
}

async function checkBuzzAgentTarget({ expectedSubjectHex, buzzExecutable, buzzCli, runCommand }) {
  if (!expectedSubjectHex) {
    return blocked("buzz_agent_target", "BUZZ_AGENT_TARGET_REQUIRED", "Buzz setup requires the intended agent's public npub or hex subject.", targetRequiredRepair());
  }
  if (buzzCli.status === "blocked" || !buzzExecutable) {
    return blocked("buzz_agent_target", "BUZZ_AGENT_TARGET_UNVERIFIED", "The active Buzz agent cannot be proven until the managed Buzz CLI is repaired.", buzzSidecarRepair(), {
      expected_subject_hex: expectedSubjectHex,
      observed_subject_hex: null,
    });
  }
  const result = runCommand(buzzExecutable, ["users", "get"], { timeout: BUZZ_DOCTOR_TIMEOUT_MS, shell: false });
  if (!commandPassed(result)) {
    return blocked("buzz_agent_target", "BUZZ_AGENT_TARGET_UNVERIFIED", "The released Buzz public self query did not return a verifiable profile.", targetUnverifiedRepair(), {
      expected_subject_hex: expectedSubjectHex,
      observed_subject_hex: null,
      failure: commandFailureClass(result),
    });
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? "")); }
  catch { parsed = null; }
  const observed = Array.isArray(parsed) && parsed.length === 1 ? normalizeNostrSubject(parsed[0]?.pubkey) : null;
  if (!observed) {
    return blocked("buzz_agent_target", "BUZZ_AGENT_TARGET_UNVERIFIED", "The released Buzz public self query returned no single public signer profile.", targetUnverifiedRepair(), {
      expected_subject_hex: expectedSubjectHex,
      observed_subject_hex: null,
    });
  }
  if (observed !== expectedSubjectHex) {
    return blocked("buzz_agent_target", "BUZZ_AGENT_TARGET_MISMATCH", "The active Buzz CLI identity is not the explicitly requested managed agent.", targetMismatchRepair(), {
      expected_subject_hex: expectedSubjectHex,
      observed_subject_hex: observed,
    });
  }
  return ok("buzz_agent_target", { expected_subject_hex: expectedSubjectHex, observed_subject_hex: observed, observation: "buzz users get" });
}

async function checkOrigin(name, origin, code, originProbe, repair) {
  try {
    const url = new URL("/status", origin);
    if (name === "run402_console") url.pathname = "/";
    const result = await originProbe(url, { timeoutMs: BUZZ_DOCTOR_TIMEOUT_MS, maxBytes: BUZZ_DOCTOR_MAX_RESPONSE_BYTES });
    if (!result?.ok) throw new Error(result?.failure ?? `http_${result?.status ?? "unknown"}`);
    return ok(name, { origin: new URL(origin).origin, elapsed_ms: result.elapsed_ms ?? null });
  } catch (error) {
    return blocked(name, code, `${name === "run402_api" ? "Run402 API" : "Run402 console"} reachability failed.`, repair, {
      origin: safeOrigin(origin),
      failure: safeFailure(error),
    });
  }
}

async function checkBuzzRelay({ relay, lookup, pinnedRelayRead }) {
  if (!relay) {
    return blocked("buzz_relay", "BUZZ_PREFLIGHT_RELAY_UNSAFE", "BUZZ_RELAY_URL must be a credential-free public wss:// origin.", relayUnsafeRepair());
  }
  try {
    const records = await lookup(relay.hostname, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0) throw new Error("dns_empty");
    for (const record of records) {
      if (!isPublicAddress(record.address)) throw new UnsafeRelayError("dns_non_public");
    }
    const result = await pinnedRelayRead(relay, records[0], {
      timeoutMs: BUZZ_DOCTOR_TIMEOUT_MS,
      maxBytes: BUZZ_DOCTOR_MAX_RESPONSE_BYTES,
    });
    if (!result?.ok) throw new Error(result?.failure ?? `http_${result?.status ?? "unknown"}`);
    return ok("buzz_relay", {
      origin: relay.origin,
      elapsed_ms: result.elapsed_ms ?? null,
      compatibility_source: "nip11_public_read",
      address_count: records.length,
    });
  } catch (error) {
    if (error instanceof UnsafeRelayError) {
      return blocked("buzz_relay", "BUZZ_PREFLIGHT_RELAY_UNSAFE", "The configured Buzz relay is not a safe public destination.", relayUnsafeRepair(), {
        origin: relay.origin,
        failure: error.message,
      });
    }
    const failure = safeFailure(error);
    return warning("buzz_relay", "BUZZ_PREFLIGHT_RELAY_UNREACHABLE", "The configured Buzz relay is safe to probe but unavailable; founder-agent setup may continue without community installation or enrollment.", relayAvailabilityRepair(relay.origin, failure), {
      origin: relay.origin,
      failure,
      community_operations: "unavailable",
    });
  }
}

function checkWalletProfile({ walletProfile, env, profileExistsImpl, readMetaImpl, expectedSubjectHex }) {
  const context = parseWalletContext(env.RUN402_ACTIVE_WALLET_JSON);
  if (!walletProfile || walletProfile === "default") {
    return blocked("wallet_profile", "BUZZ_PREFLIGHT_WALLET_PROFILE_REQUIRED", "Buzz setup requires a unique named Run402 wallet profile.", targetRequiredRepair(expectedSubjectHex));
  }
  if (context?.source !== "flag" || context?.sourceDetail !== "--wallet") {
    return blocked("wallet_profile", "BUZZ_PREFLIGHT_WALLET_PROFILE_MISMATCH", "The Run402 profile was not selected by the explicit --wallet argument.", rerunDoctorRepair(walletProfile, expectedSubjectHex), {
      profile_label: walletProfile,
      selection_source: context?.source ?? "unknown",
      selection_source_detail: context?.sourceDetail ?? null,
    });
  }
  if (!profileExistsImpl(walletProfile)) {
    return blocked("wallet_profile", "BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND", `The dedicated Run402 profile '${walletProfile}' does not exist yet.`, walletCreateRepair(walletProfile), {
      profile_label: walletProfile,
      profile_type: "eoa_wallet",
      initialized: false,
      selection_source: "explicit_argument",
    });
  }
  const meta = readMetaImpl(walletProfile);
  if (meta?.name && meta.name !== walletProfile) {
    return blocked("wallet_profile", "BUZZ_PREFLIGHT_WALLET_PROFILE_MISMATCH", "The selected profile metadata does not match the explicit profile label.", rerunDoctorRepair(walletProfile, expectedSubjectHex), {
      profile_label: walletProfile,
      observed_label: meta.name,
      initialized: true,
      selection_source: "explicit_argument",
    });
  }
  return ok("wallet_profile", {
    profile_label: walletProfile,
    profile_type: "eoa_wallet",
    rail: meta?.rail ?? null,
    initialized: true,
    selection_source: "explicit_argument",
  });
}

export async function defaultOriginProbe(url, { timeoutMs = BUZZ_DOCTOR_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json,text/html;q=0.5" },
    });
    await response.body?.cancel().catch(() => {});
    return { ok: response.status >= 200 && response.status < 300, status: response.status, elapsed_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function defaultPinnedRelayRead(relay, record, { timeoutMs = BUZZ_DOCTOR_TIMEOUT_MS, maxBytes = BUZZ_DOCTOR_MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const request = httpsRequest({
      protocol: "https:",
      hostname: relay.hostname,
      port: relay.port || 443,
      path: "/",
      method: "GET",
      servername: relay.hostname,
      headers: { accept: "application/nostr+json,application/json" },
      lookup: pinnedLookup(record, relay.hostname),
      timeout: timeoutMs,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reject(new Error("redirect_rejected"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`http_${response.statusCode}`));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("nip11_invalid");
          resolve({ ok: true, status: response.statusCode, elapsed_ms: Date.now() - started });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

export function isPublicAddress(address) {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function pinnedLookup(record, expectedHostname) {
  return (hostname, _options, callback) => {
    if (hostname !== expectedHostname) {
      callback(new Error("relay_hostname_changed"));
      return;
    }
    callback(null, record.address, record.family);
  };
}

function defaultRunCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: BUZZ_DOCTOR_MAX_RESPONSE_BYTES,
    timeout: BUZZ_DOCTOR_TIMEOUT_MS,
    ...options,
  });
}

function findExecutable(name, env, platform) {
  const pathValue = typeof env.PATH === "string" ? env.PATH : "";
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" && !extname(name) ? `${name}${extension}` : name);
      try {
        accessSync(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return safeRealpath(candidate) ?? candidate;
      } catch { /* keep searching */ }
    }
  }
  return null;
}

function configuredShell(env, platform) {
  if (platform === "win32") return env.ComSpec || env.COMSPEC || null;
  return typeof env.SHELL === "string" && env.SHELL.trim() ? env.SHELL.trim() : null;
}

function parseRelayOrigin(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "wss:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.hostname === "localhost" || ipaddr.isValid(url.hostname)) return null;
    return { origin: url.origin, hostname: url.hostname, port: url.port ? Number(url.port) : 443 };
  } catch {
    return null;
  }
}

function blocked(name, code, message, action, value) {
  assertRepairMatches(code, action);
  return { name, status: "blocked", code, ...(value ? { value } : {}), message, next_actions: [action] };
}

function warning(name, code, message, action, value) {
  assertRepairMatches(code, action);
  return { name, status: "warning", code, ...(value ? { value } : {}), message, next_actions: [action] };
}

function ok(name, value) {
  return { name, status: "ok", ...(value ? { value } : {}) };
}

function shellAction({ type, argv, why, cwd, safeToAutoExecute = false, requiresApproval = true }) {
  return {
    type,
    surface: "shell",
    command: shellCommand(argv),
    argv,
    ...(cwd ? { cwd } : {}),
    why,
    safe_to_auto_execute: safeToAutoExecute,
    requires_approval: requiresApproval,
    destructive: false,
    idempotent: true,
    spend_impact: SPEND_NONE,
  };
}

function nonShellAction({ type, surface, command, why }) {
  return {
    type,
    surface,
    command,
    why,
    safe_to_auto_execute: false,
    requires_approval: true,
    destructive: false,
    idempotent: true,
    spend_impact: SPEND_NONE,
  };
}

function shellRepair() {
  return nonShellAction({
    type: "repair_buzz_agent_runtime",
    surface: "buzz_settings",
    command: "Open Buzz Desktop > Settings > Agents, select this agent, choose a runtime with command execution enabled, restart the agent, then rerun Run402 setup.",
    why: "Run402 setup needs the managed agent's configured shell before it can diagnose or mutate anything.",
  });
}

function nodeRepair() {
  return nonShellAction({
    type: "repair_buzz_node_runtime",
    surface: "buzz_settings",
    command: "Open Buzz Desktop > Settings > Updates, install the available Buzz update, restart this agent, then rerun Run402 setup.",
    why: `The managed session must provide a spawnable Node ${BUZZ_DOCTOR_MIN_NODE_MAJOR}+ runtime.`,
  });
}

function run402InstallRepair() {
  return shellAction({
    type: "install_run402_cli",
    argv: ["npm", "install", "-g", "run402@latest"],
    why: "Install Run402 in the user-global npm context used by the Buzz setup helper.",
    safeToAutoExecute: true,
    requiresApproval: false,
  });
}

function run402RepairForInstall(install, cwd) {
  if (install?.kind === "global_npm") return run402InstallRepair();
  if (install?.kind === "local_project") {
    const manager = install.package_manager ?? "npm";
    const argv = manager === "pnpm" ? ["pnpm", "add", "-D", "run402@latest"]
      : manager === "yarn" ? ["yarn", "add", "-D", "run402@latest"]
        : manager === "bun" ? ["bun", "add", "-d", "run402@latest"]
          : ["npm", "install", "-D", "run402@latest"];
    return shellAction({ type: "upgrade_run402_cli", argv, cwd, why: "Upgrade the project-local Run402 CLI that executed this diagnostic." });
  }
  return shellAction({
    type: "inspect_run402_cli",
    argv: ["run402", "doctor", "--refresh"],
    cwd,
    why: "The Run402 executable context is custom or ambiguous; inspect it without guessing a package-manager mutation.",
    safeToAutoExecute: true,
    requiresApproval: false,
  });
}

function normalizeUpgradeAction(rawAction, install, cwd) {
  const argv = Array.isArray(rawAction?.argv) && rawAction.argv.every((item) => typeof item === "string")
    ? rawAction.argv
    : run402RepairForInstall(install, cwd).argv;
  return shellAction({
    type: "upgrade_run402_cli",
    argv,
    cwd: rawAction?.cwd ?? cwd,
    why: "Upgrade guidance is advisory because the executing Run402 CLI remains compatible.",
  });
}

function buzzSidecarRepair() {
  return nonShellAction({
    type: "repair_buzz_cli_sidecar",
    surface: BUZZ_CAPABILITIES.managed_sidecar.repair_surface,
    command: BUZZ_CAPABILITIES.managed_sidecar.repair_instruction,
    why: "The Buzz CLI is bundled with Buzz Desktop; a public package-manager command would be an unverified repair path.",
  });
}

function targetRequiredRepair(expectedSubjectHex) {
  return nonShellAction({
    type: "rerun_buzz_setup_with_explicit_identity",
    surface: "buzz_chat",
    command: expectedSubjectHex
      ? "@Fizz rerun Run402 setup using your current public Buzz npub and a unique dedicated Run402 profile."
      : "@Fizz rerun Run402 setup using your current public Buzz npub and a unique dedicated Run402 profile such as buzz-fizz.",
    why: "The agent must bind setup to one explicit public Buzz identity and one dedicated Run402 profile.",
  });
}

function targetUnverifiedRepair() {
  return nonShellAction({
    type: "publish_buzz_public_profile",
    surface: "buzz_chat",
    command: "@Fizz publish or repair your public Buzz profile, then rerun Run402 setup.",
    why: "The released read-only `buzz users get` boundary needs one public self profile to prove the active agent.",
  });
}

function targetMismatchRepair() {
  return nonShellAction({
    type: "select_expected_buzz_agent",
    surface: "buzz_chat",
    command: "Send the Run402 setup request to the intended Buzz agent, then have that agent rerun setup from its own managed session.",
    why: "Run402 will not relink or infer identity when the active Buzz signer differs from the requested public agent.",
  });
}

function apiRepair(origin) {
  return nonShellAction({
    type: "restore_run402_api_access",
    surface: "buzz_settings",
    command: `Open Buzz Desktop > Settings > Agents, select this agent, allow HTTPS access to ${safeOrigin(origin)}, restart the agent, then rerun Run402 setup.`,
    why: "The agent must reach the Run402 API before setup can safely initialize or verify state.",
  });
}

function consoleRepair() {
  return nonShellAction({
    type: "restore_run402_console_access",
    surface: "buzz_settings",
    command: "Open Buzz Desktop > Settings > Agents, select this agent, allow HTTPS access to https://console.run402.com, restart the agent, then rerun Run402 setup.",
    why: "The no-terminal human adoption handoff requires the Run402 console origin.",
  });
}

function relayUnsafeRepair() {
  return nonShellAction({
    type: "repair_buzz_relay_url",
    surface: "buzz_settings",
    command: "Open Buzz Desktop > Settings > Communities, select the current community, choose its public wss:// relay, restart this agent, then rerun Run402 setup.",
    why: "Run402 refuses literal, private, reserved, mixed-address, credential-bearing, or non-TLS relay destinations.",
  });
}

function relayAvailabilityRepair(origin, failure) {
  if (failure === "tls_handshake_failed") {
    return nonShellAction({
      type: "repair_buzz_relay_tls",
      surface: "buzz_settings",
      command: `Ask the Buzz community operator to provision a valid TLS certificate and public hostname route for ${origin}; after the endpoint completes verified TLS, restart this agent and rerun Run402 setup.`,
      why: "Reconnect cannot repair a relay hostname whose public TLS handshake fails; community installation and enrollment stay unavailable until the endpoint is fixed.",
    });
  }
  if (failure === "dns") {
    return nonShellAction({
      type: "repair_buzz_relay_dns",
      surface: "buzz_settings",
      command: `Ask the Buzz community operator to publish working public DNS for ${origin}; after the hostname resolves publicly, restart this agent and rerun Run402 setup.`,
      why: "Community installation and enrollment require a publicly resolvable relay, while founder-agent setup remains independent.",
    });
  }
  if (failure.startsWith("http_") || failure === "nip11_invalid" || failure === "redirect_rejected" || failure === "response_too_large") {
    return nonShellAction({
      type: "repair_buzz_relay_service",
      surface: "buzz_settings",
      command: `Ask the Buzz community operator to restore the public NIP-11 endpoint at ${origin}; after it returns a bounded non-redirecting JSON response, restart this agent and rerun Run402 setup.`,
      why: "Community installation and enrollment require the relay's public NIP-11 service, while founder-agent setup remains independent.",
    });
  }
  return nonShellAction({
    type: "restore_buzz_relay_access",
    surface: "buzz_settings",
    command: `Ask the Buzz community operator to restore public relay access at ${origin}; after the endpoint is reachable, restart this agent and rerun Run402 setup.`,
    why: "Community installation and enrollment require a live public relay, while founder-agent setup remains independent.",
  });
}

function walletCreateRepair(walletProfile) {
  return shellAction({
    type: "create_buzz_wallet_profile",
    argv: ["run402", "wallets", "new", walletProfile],
    why: "Create the explicitly named dedicated agent profile, then rerun the complete preflight before setup.",
    safeToAutoExecute: true,
    requiresApproval: false,
  });
}

function rerunDoctorRepair(walletProfile, expectedSubjectHex) {
  const argv = ["run402", "--wallet", walletProfile, "doctor", "--buzz"];
  if (expectedSubjectHex) argv.push("--buzz-agent", expectedSubjectHex);
  return shellAction({
    type: "rerun_buzz_doctor",
    argv,
    why: "Rerun the read-only diagnostic with the exact explicit profile and public Buzz identity.",
    safeToAutoExecute: true,
    requiresApproval: false,
  });
}

function shellCommand(argv) {
  return argv.map((part) => SAFE_TOKEN.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}

function commandPassed(result) {
  return !result?.error && result?.status === 0;
}

function commandFailureClass(result) {
  if (result?.error?.code === "ETIMEDOUT") return "timeout";
  if (result?.error?.code === "ENOENT") return "not_found";
  if (result?.error) return "spawn_error";
  return Number.isInteger(result?.status) ? `exit_${result.status}` : "unknown";
}

function compareMajorMinorPatch(left, right) {
  const parse = (value) => String(value).match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number) ?? null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function parseWalletContext(raw) {
  try {
    const parsed = JSON.parse(raw || "");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function usageError(code, message, flag) {
  return { code, message, details: { flag }, retryable: false, safe_to_retry: true };
}

function indexesOf(values, expected) {
  return values.flatMap((value, index) => value === expected ? [index] : []);
}

function safeRealpath(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  try { return existsSync(path) ? realpathSync(path) : path; }
  catch { return path; }
}

function safePath(path) {
  return typeof path === "string" ? path : null;
}

function safeOrigin(value) {
  try { return new URL(value).origin; }
  catch { return null; }
}

function safeFailure(error) {
  if (error?.name === "AbortError") return "timeout";
  const message = error instanceof Error ? `${error.message} ${error.code ?? ""} ${error.cause?.message ?? ""} ${error.cause?.code ?? ""}` : String(error);
  if (/certificate|tls|ssl|eproto|secure tls connection|handshake/i.test(message)) return "tls_handshake_failed";
  if (/dns|dns_empty|getaddrinfo|enotfound|eai_again/i.test(message)) return "dns";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/redirect/i.test(message)) return "redirect_rejected";
  if (/response_too_large/i.test(message)) return "response_too_large";
  if (/nip11_invalid/i.test(message)) return "nip11_invalid";
  if (/http_\d+/.test(message)) return message.match(/http_\d+/)[0];
  return "network";
}

function assertRepairMatches(code, action) {
  const expected = BUZZ_DOCTOR_REPAIR_MATRIX[code];
  if (!expected) throw new Error(`No frozen Buzz doctor repair mapping for ${code}`);
  const types = Array.isArray(expected.type) ? expected.type : [expected.type];
  const surfaces = Array.isArray(expected.surface) ? expected.surface : [expected.surface];
  if (!types.includes(action?.type) || !surfaces.includes(action?.surface)) {
    throw new Error(`Buzz doctor repair drift for ${code}`);
  }
}

class UnsafeRelayError extends Error {}
