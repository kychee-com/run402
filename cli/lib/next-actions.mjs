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
    why: "Create and fund a local wallet, then retry.",
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
    why: "Set a tier for the organization (prototype is free), then retry.",
  });
}

export function deployAction() {
  return nextAction("deploy", {
    command: "run402 deploy --manifest app.json",
    why: "Deploy your release manifest.",
  });
}

/**
 * The cold-start deploy when the account holds no tier yet: `run402 up -y`
 * sets the prototype tier itself as part of the first deploy, so `init`
 * hands the agent ONE command instead of `tier set` + a separate deploy.
 * `tier set prototype` stays named as the standalone alternative.
 */
export function upDeployAction() {
  return nextAction("deploy", {
    command: "run402 up -y",
    why: "Deploy with run402 up -y — it sets the prototype tier (free on testnet) as part of the first deploy. Or set it separately: run402 tier set prototype.",
  });
}

/**
 * `repos create` (and `gitvault init`) on an org with no slug set: the
 * response's `address: null` had no pointer to WHY, or to the named-addressing
 * feature at all. Owner-only. Wording deliberately
 * omits a price: the first slug per org is free, and renames/re-claims cost
 * $1 — a gateway change lands the fee separately, so this stays true under
 * both the old and new pricing rule.
 */
export function setOrgSlugAction() {
  return nextAction("set_org_slug", {
    command: "run402 org slug <slug>",
    why: "This organization has no slug set yet, so its repos have no run402::<slug>/<name> address. Owner-only.",
  });
}

/**
 * The org already has a slug, but this project's address-form repo name was
 * not set this time (a collision, or the best-effort set failed for
 * some other reason) — point at the explicit set verb instead of leaving
 * `address: null` unexplained.
 */
export function setRepoNameAction(projectId) {
  return nextAction("set_repo_name", {
    command: `run402 repos name <name> --project ${projectId}`,
    why: "The owning organization has a slug, but this project has no address-form name set yet.",
  });
}
