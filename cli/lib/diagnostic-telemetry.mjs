import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiBase, configDir } from "./config.mjs";
import { currentRun402Version } from "./update-check.mjs";

export const DIAGNOSTIC_TELEMETRY_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_TELEMETRY_FLOW_VERSION = "run402.buzz-doctor.v1";
export const DIAGNOSTIC_TELEMETRY_BUZZ_FIXTURE_ID = "buzz-cli-v0.5.2-capabilities";
export const DIAGNOSTIC_TELEMETRY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_TELEMETRY_MAX_EVENTS = 32;
export const DIAGNOSTIC_TELEMETRY_MAX_QUEUE_BYTES = 16 * 1024;
export const DIAGNOSTIC_TELEMETRY_TIMEOUT_MS = 2_000;

export const DIAGNOSTIC_TELEMETRY_FIELDS = Object.freeze([
  "event_id",
  "event_at",
  "schema_version",
  "flow_version",
  "event",
  "check_name",
  "code",
  "os_family",
  "node_major",
  "run402_major",
  "run402_minor",
  "buzz_fixture_id",
  "install_context",
]);

const ALLOWED_EVENTS = new Set(["preflight_started", "preflight_passed", "preflight_blocked"]);
const ALLOWED_CHECKS = new Set([
  "session_shell", "node_runtime", "run402_cli", "buzz_cli", "buzz_agent_target",
  "run402_api", "run402_console", "buzz_relay", "wallet_profile",
]);
const ALLOWED_CODES = new Set([
  "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE",
  "BUZZ_PREFLIGHT_NODE_UNAVAILABLE", "BUZZ_PREFLIGHT_NODE_INCOMPATIBLE",
  "BUZZ_PREFLIGHT_RUN402_UNAVAILABLE", "BUZZ_PREFLIGHT_RUN402_INCOMPATIBLE",
  "BUZZ_PREFLIGHT_RUN402_UPDATE_AVAILABLE",
  "BUZZ_PREFLIGHT_BUZZ_CLI_UNAVAILABLE", "BUZZ_PREFLIGHT_BUZZ_CLI_INCOMPATIBLE",
  "BUZZ_AGENT_TARGET_REQUIRED", "BUZZ_AGENT_TARGET_UNVERIFIED", "BUZZ_AGENT_TARGET_MISMATCH",
  "BUZZ_PREFLIGHT_API_UNREACHABLE", "BUZZ_PREFLIGHT_CONSOLE_UNREACHABLE",
  "BUZZ_PREFLIGHT_RELAY_UNSAFE", "BUZZ_PREFLIGHT_RELAY_UNREACHABLE",
  "BUZZ_PREFLIGHT_WALLET_PROFILE_REQUIRED", "BUZZ_PREFLIGHT_WALLET_PROFILE_NOT_FOUND",
  "BUZZ_PREFLIGHT_WALLET_PROFILE_MISMATCH",
]);
const ALLOWED_INSTALL_CONTEXTS = new Set([
  "project_local", "user_global_npm", "ephemeral_exec", "managed_buzz_sidecar", "custom_path", "unknown",
]);
const ALLOWED_OS_FAMILIES = new Set(["macos", "linux", "windows", "other"]);
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function diagnosticTelemetryQueuePath({ dir = configDir() } = {}) {
  return join(dir, "diagnostic-events-v1.json");
}

export function isDiagnosticTelemetryDisabled(env = process.env) {
  return env.RUN402_TELEMETRY === "0";
}

function coarseOsFamily(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}

function versionParts(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)/);
  return {
    major: Number(match?.[1] ?? 0),
    minor: Number(match?.[2] ?? 0),
  };
}

function installContext(report) {
  const observed = report?.checks?.find((check) => check?.name === "run402_cli")?.value?.install_context;
  switch (observed) {
    case "local_project": return "project_local";
    case "global_npm": return "user_global_npm";
    case "ephemeral_exec": return "ephemeral_exec";
    case "managed_buzz_sidecar": return "managed_buzz_sidecar";
    case "custom_path":
    case "package_manager_shim": return "custom_path";
    default: return "unknown";
  }
}

function nodeMajor(report) {
  const value = report?.checks?.find((check) => check?.name === "node_runtime")?.value?.major;
  return Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : 0;
}

export function buildDiagnosticTelemetryEvent({
  report,
  event,
  eventAt = new Date().toISOString(),
  eventId = randomUUID(),
  platform = process.platform,
  run402Version = currentRun402Version(),
} = {}) {
  if (!ALLOWED_EVENTS.has(event)) throw new Error("Unsupported diagnostic telemetry event");
  const blocked = event === "preflight_blocked"
    ? report?.checks?.find((check) => check?.status === "blocked")
    : null;
  if (event === "preflight_blocked" &&
      (!ALLOWED_CHECKS.has(blocked?.name) || !ALLOWED_CODES.has(blocked?.code))) {
    throw new Error("Blocked diagnostic telemetry requires one frozen check/code pair");
  }
  const version = versionParts(run402Version);
  return {
    event_id: eventId,
    event_at: eventAt,
    schema_version: DIAGNOSTIC_TELEMETRY_SCHEMA_VERSION,
    flow_version: DIAGNOSTIC_TELEMETRY_FLOW_VERSION,
    event,
    check_name: blocked?.name ?? null,
    code: blocked?.code ?? null,
    os_family: coarseOsFamily(platform),
    node_major: nodeMajor(report),
    run402_major: version.major,
    run402_minor: version.minor,
    buzz_fixture_id: DIAGNOSTIC_TELEMETRY_BUZZ_FIXTURE_ID,
    install_context: installContext(report),
  };
}

function isRedactedEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== DIAGNOSTIC_TELEMETRY_FIELDS.length) return false;
  if (!DIAGNOSTIC_TELEMETRY_FIELDS.every((field) => Object.hasOwn(value, field))) return false;
  if (!ALLOWED_EVENTS.has(value.event)) return false;
  if (value.event === "preflight_blocked") {
    if (!ALLOWED_CHECKS.has(value.check_name) || !ALLOWED_CODES.has(value.code)) return false;
  } else if (value.check_name !== null || value.code !== null) {
    return false;
  }
  return value.schema_version === DIAGNOSTIC_TELEMETRY_SCHEMA_VERSION &&
    value.flow_version === DIAGNOSTIC_TELEMETRY_FLOW_VERSION &&
    value.buzz_fixture_id === DIAGNOSTIC_TELEMETRY_BUZZ_FIXTURE_ID &&
    ALLOWED_INSTALL_CONTEXTS.has(value.install_context) &&
    ALLOWED_OS_FAMILIES.has(value.os_family) &&
    [value.node_major, value.run402_major, value.run402_minor]
      .every((part) => Number.isSafeInteger(part) && part >= 0 && part <= 999) &&
    typeof value.event_at === "string" && new Date(value.event_at).toISOString() === value.event_at &&
    typeof value.event_id === "string" && UUID_V4_RE.test(value.event_id);
}

export function readDiagnosticTelemetryQueue({
  path = diagnosticTelemetryQueuePath(),
  now = Date.now(),
} = {}) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.events)) return [];
    return parsed.events.filter((event) =>
      isRedactedEvent(event) && now - Date.parse(event.event_at) <= DIAGNOSTIC_TELEMETRY_RETENTION_MS,
    ).slice(-DIAGNOSTIC_TELEMETRY_MAX_EVENTS);
  } catch {
    return [];
  }
}

export function writeDiagnosticTelemetryQueue(events, {
  path = diagnosticTelemetryQueuePath(),
  now = Date.now(),
} = {}) {
  try {
    let bounded = events.filter((event) =>
      isRedactedEvent(event) && now - Date.parse(event.event_at) <= DIAGNOSTIC_TELEMETRY_RETENTION_MS,
    ).slice(-DIAGNOSTIC_TELEMETRY_MAX_EVENTS);
    let payload = `${JSON.stringify({ schema_version: 1, events: bounded })}\n`;
    while (bounded.length > 0 && Buffer.byteLength(payload, "utf8") > DIAGNOSTIC_TELEMETRY_MAX_QUEUE_BYTES) {
      bounded = bounded.slice(1);
      payload = `${JSON.stringify({ schema_version: 1, events: bounded })}\n`;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, payload, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function removeDiagnosticTelemetryQueue(path) {
  try { rmSync(path, { force: true }); } catch { /* best-effort opt-out */ }
}

export function queueBuzzDoctorTelemetry(report, {
  env = process.env,
  path = diagnosticTelemetryQueuePath(),
  startedAt = Date.now(),
  finishedAt = Date.now(),
  createEventId = randomUUID,
  platform = process.platform,
  run402Version = currentRun402Version(),
  launchWorker = launchDiagnosticTelemetryWorker,
} = {}) {
  if (isDiagnosticTelemetryDisabled(env)) {
    removeDiagnosticTelemetryQueue(path);
    return { status: "disabled", queued: false };
  }
  try {
    const finalEvent = report?.ok ? "preflight_passed" : "preflight_blocked";
    const added = [
      buildDiagnosticTelemetryEvent({
        report,
        event: "preflight_started",
        eventAt: new Date(startedAt).toISOString(),
        eventId: createEventId(),
        platform,
        run402Version,
      }),
      buildDiagnosticTelemetryEvent({
        report,
        event: finalEvent,
        eventAt: new Date(finishedAt).toISOString(),
        eventId: createEventId(),
        platform,
        run402Version,
      }),
    ];
    const queued = [...readDiagnosticTelemetryQueue({ path, now: finishedAt }), ...added];
    if (!writeDiagnosticTelemetryQueue(queued, { path, now: finishedAt })) {
      return { status: "dropped", queued: false };
    }
    try { launchWorker({ path, env }); } catch { /* queue remains for a later connection */ }
    return { status: "queued", queued: true };
  } catch {
    return { status: "dropped", queued: false };
  }
}

export function launchDiagnosticTelemetryWorker({ path, env = process.env } = {}) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./diagnostic-telemetry-worker.mjs", import.meta.url)),
    path ?? diagnosticTelemetryQueuePath(),
    apiBase(),
  ], {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: true,
  });
  child.unref();
}

export async function flushDiagnosticTelemetryQueue({
  path = diagnosticTelemetryQueuePath(),
  apiOrigin = apiBase(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DIAGNOSTIC_TELEMETRY_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  if (isDiagnosticTelemetryDisabled(env)) {
    removeDiagnosticTelemetryQueue(path);
    return { sent: 0, retained: 0, status: "disabled" };
  }
  const events = readDiagnosticTelemetryQueue({ path, now });
  const retained = [];
  let sent = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL("/client-diagnostic-events/v1", apiOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (response.status === 204) {
        sent += 1;
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // A non-retryable schema rejection is safest to drop. The calling
        // doctor has already completed and cannot be affected.
      } else {
        retained.push(event, ...events.slice(index + 1));
        break;
      }
    } catch {
      retained.push(event, ...events.slice(index + 1));
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  writeDiagnosticTelemetryQueue(retained, { path, now: Date.now() });
  return { sent, retained: retained.length, status: retained.length > 0 ? "queued" : "flushed" };
}
