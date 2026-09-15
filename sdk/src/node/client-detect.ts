/**
 * Detect the coding-agent client this process runs under — the default
 * display name `up` sets on a principal that has none (principal-display-name
 * spec). Returns null when nothing specific is known: a guess is never
 * persisted as a name. `RUN402_AGENT_NAME` (read by `up` before detection)
 * is the way any runtime names itself with no per-command flag;
 * `RUN402_CLIENT` declares the client for detection purposes when it has no
 * marker of its own (checked first, before every marker).
 */
export type DetectedClientName = "claude-code" | "codex" | "cursor" | "grok";

/** Env var that names the client outright when it is not auto-detected. */
export const CLIENT_OVERRIDE_ENV = "RUN402_CLIENT";

/**
 * The env markers each known client is detected from, in detection order
 * (first client whose marker is truthy wins). Exported so tests and docs can
 * enumerate the table instead of copying it.
 */
export const KNOWN_CLIENT_MARKERS: ReadonlyArray<{ readonly client: DetectedClientName; readonly markers: ReadonlyArray<string> }> = [
  { client: "claude-code", markers: ["CLAUDECODE", "CLAUDE_CODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"] },
  { client: "codex", markers: ["CODEX_SANDBOX", "CODEX_CI", "OPENAI_CODEX", "CODEX_HOME"] },
  { client: "cursor", markers: ["CURSOR_TRACE_ID", "CURSOR_SESSION_ID", "CURSOR_AGENT"] },
  { client: "grok", markers: ["GROK_CLI", "GROK_SESSION_ID", "GROK_AGENT", "XAI_GROK", "GROK_CODE"] },
];

/** Every env var detection reads, `RUN402_CLIENT` first — for test isolation. */
export const CLIENT_DETECTION_ENV_VARS: ReadonlyArray<string> = [
  CLIENT_OVERRIDE_ENV,
  ...KNOWN_CLIENT_MARKERS.flatMap((entry) => entry.markers),
];

export function detectClientName(env: NodeJS.ProcessEnv = process.env): DetectedClientName | null {
  const declared = env[CLIENT_OVERRIDE_ENV];
  const declaredClient = typeof declared === "string" ? declared.trim() : "";
  if (declaredClient.length > 0) return declaredClient as DetectedClientName;
  for (const entry of KNOWN_CLIENT_MARKERS) {
    if (entry.markers.some((marker) => Boolean(env[marker]))) return entry.client;
  }
  return null;
}

/** The name an agent runtime declares for itself, if any (`RUN402_AGENT_NAME`, trimmed). */
export function declaredAgentName(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RUN402_AGENT_NAME;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length > 0 ? name : null;
}
