/**
 * The bootstrap `next_actions` the Node SDK's local-state verbs author
 * (`wallets.current`, `init`, `status`, `doctor`), in the one spelling every
 * surface prints. Each is the literal CLI invocation plus why, the same shape
 * the gateway's `next_actions` carry extended with `command`.
 */

import type { NextAction } from "../errors.js";

export function localAction(type: string, fields: { command?: string; why?: string; method?: string; path?: string; auth?: string } = {}): NextAction {
  const action: NextAction = { type };
  for (const key of ["command", "method", "path", "auth", "why"] as const) {
    if (fields[key] !== undefined) action[key] = fields[key];
  }
  return action;
}

export function initializeWalletAction(): NextAction {
  return localAction("initialize_wallet", {
    command: "run402 init",
    why: "Create and fund a local wallet, then retry.",
  });
}

export function deployAction(): NextAction {
  return localAction("deploy", {
    command: "run402 deploy --manifest app.json",
    why: "Deploy your release manifest.",
  });
}

/**
 * The cold-start deploy when the account holds no tier yet: `run402 up -y`
 * sets the prototype tier itself as part of the first deploy, so `init`
 * hands the agent ONE command instead of `tier set` + a separate deploy.
 */
export function upDeployAction(): NextAction {
  return localAction("deploy", {
    command: "run402 up -y",
    why: "Deploy with run402 up -y — it sets the prototype tier (free on testnet) as part of the first deploy. Or set it separately: run402 tier set prototype.",
  });
}
