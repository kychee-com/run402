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
 * (Legacy `{ action }` / bare-string `next_actions` entries elsewhere in the
 * CLI — `cache.mjs`, `subdomains.mjs`, `deploy-v2.mjs` — predate this and are
 * tracked as Tier-3 follow-up; they are intentionally left untouched here.)
 */

export function initializeWalletAction() {
  return {
    type: "initialize_wallet",
    command: "run402 init",
    why: "Create and fund an agent allowance, then retry.",
  };
}

export function createProjectAction() {
  return {
    type: "create_project",
    command: "run402 projects provision",
    why: "Provision a project to act on, then retry.",
  };
}

export function setTierAction(tier = "prototype") {
  return {
    type: "renew_tier",
    command: `run402 tier set ${tier}`,
    why: "Subscribe the account to a tier (free on testnet), then retry.",
  };
}

export function deployAction() {
  return {
    type: "deploy",
    command: "run402 deploy apply --manifest app.json",
    why: "Apply your release manifest to deploy.",
  };
}
