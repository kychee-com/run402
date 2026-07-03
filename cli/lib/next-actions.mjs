/**
 * Canonical bootstrap `next_actions` entries
 * (change: keep-agent-in-loop-on-cold-start).
 *
 * One spelling, surface-wide: each cold-start wall hands the agent a typed
 * action whose `command` is the literal CLI invocation. The shape mirrors the
 * gateway's `next_actions` (`{ type, why, ... }`) extended with `command` for
 * CLI-resolvable, client-side actions — the same shape already used by
 * `cli/lib/email.mjs`. The `type` values match the SDK `NextActionType` union.
 *
 * Use these helpers whenever the CLI itself authors next actions. Gateway/SDK
 * `next_actions` remain the lower-layer source of truth and should pass through.
 */

export function nextAction(type, fields = {}) {
  const action = { type };
  for (const key of ["command", "method", "path", "auth", "why"]) {
    if (fields[key] !== undefined) action[key] = fields[key];
  }
  return action;
}

export function cliCommandAction(type, command, why) {
  return nextAction(type, { command, why });
}

export function editRequestAction(command, why) {
  return cliCommandAction("edit_request", command, why);
}

export function retryAction(command, why) {
  return cliCommandAction("retry", command, why);
}

export function initializeWalletAction() {
  return nextAction("initialize_wallet", {
    command: "run402 init",
    why: "Create and fund an agent allowance, then retry.",
  });
}

export function createProjectAction() {
  return nextAction("create_project", {
    command: "run402 projects provision",
    why: "Provision a project to act on, then retry.",
  });
}

export function selectProjectAction() {
  return nextAction("edit_request", {
    command: "run402 projects use <project_id>",
    why: "Select a server-visible project, or pass --project <project_id> on the command.",
  });
}

export function setTierAction(tier = "prototype") {
  return nextAction("renew_tier", {
    command: `run402 tier set ${tier}`,
    why: "Subscribe the account to a tier (free on testnet), then retry.",
  });
}

export function deployAction() {
  return nextAction("deploy", {
    command: "run402 deploy apply --manifest app.json",
    why: "Apply your release manifest to deploy.",
  });
}
