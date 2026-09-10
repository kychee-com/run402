/**
 * Detect the coding-agent client this process runs under — the default
 * display name `up` sets on a principal that has none (principal-display-name
 * spec). Returns null when nothing specific is known: a guess is never
 * persisted as a name. `RUN402_AGENT_NAME` (read by `up` before detection)
 * is the way any runtime names itself with no per-command flag.
 */
export type DetectedClientName = "claude-code" | "codex" | "cursor";

export function detectClientName(env: NodeJS.ProcessEnv = process.env): DetectedClientName | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.OPENAI_CODEX || env.CODEX_HOME) return "codex";
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || env.CURSOR_AGENT) return "cursor";
  return null;
}

/** The name an agent runtime declares for itself, if any (`RUN402_AGENT_NAME`, trimmed). */
export function declaredAgentName(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RUN402_AGENT_NAME;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length > 0 ? name : null;
}
