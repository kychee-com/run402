/**
 * Detect the coding-agent client this process runs under, for the default
 * display name `up` sets on a principal that has none (principal-display-name
 * spec, first-deploy-agent-dx). Reported back as `identity.source:
 * "detected"` so the agent knows it can override it any time with
 * `run402 whoami --set-name <name>`.
 */
export type DetectedClientName = "claude-code" | "codex" | "cursor" | "agent";

export function detectClientName(env: NodeJS.ProcessEnv = process.env): DetectedClientName {
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.OPENAI_CODEX || env.CODEX_HOME) return "codex";
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || env.CURSOR_AGENT) return "cursor";
  return "agent";
}
