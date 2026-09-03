/**
 * Tool profiles — and the rule that guidance must respect them.
 *
 * `RUN402_MCP_PROFILE=buyer` registers a 6-tool surface instead of 198 (a 98.5%
 * context cut for an agent that only wants to buy one thing). Filtering the
 * REGISTRATION was the easy half. The half that broke: our guidance strings
 * kept naming tools from the full surface, so a buyer following our own advice
 * was sent to tools that do not exist for them.
 *
 * Cold-walking the buyer profile:
 *
 *   allowance_status  ->  "Use `allowance_create` ..."   NOT in the buyer profile
 *   init              ->  "Next: Use `set_tier` ..."     NOT in the buyer profile
 *
 * and `set_tier` is not merely absent, it is irrelevant — a tier is for hosting
 * projects, not for buying a $0.03 image. This is the same defect class as our
 * ClawHub skill opening with `run402 wallet status` for four months: a surface
 * naming a command that does not exist FOR THE USER BEING ADDRESSED.
 *
 * So guidance asks `isToolAvailable()` before naming a tool, and
 * `profile-guidance.test.mjs` fails the build if any guidance string names a
 * tool the active profile does not register.
 */

export const TOOL_PROFILES: Record<string, readonly string[]> = {
  buyer: [
    "generate_image",
    "init",
    "allowance_status",
    "allowance_export",
    "check_balance",
    "request_faucet",
    // Redeeming a promo code is funding, the same shape as the faucet: it is
    // how a buyer-profile agent gets a spendable balance without a wallet
    // top-up. Leaving it out would strand exactly the agent most likely to be
    // handed a code.
    "redeem_voucher",
  ],
};
// NOTE: `x402_price_check` is deliberately absent — it lives on the remote
// discovery server, not here. Listing it would be a phantom entry that silently
// registers nothing, which is exactly how a typo in this list would hide.

const requested = process.env.RUN402_MCP_PROFILE?.trim();

/** The requested profile name, or null when the full surface is registered. */
export const requestedProfileName: string | null = requested ? requested : null;

/**
 * The active profile's tool list, or null for the full surface.
 *
 * An UNKNOWN profile name resolves to null here and is rejected by the caller
 * in `index.ts` — this module does not exit the process, so it stays importable
 * from tool modules and from tests.
 */
export const activeProfile: readonly string[] | null =
  requested && TOOL_PROFILES[requested] ? TOOL_PROFILES[requested] : null;

/**
 * Can the caller actually invoke this tool right now?
 *
 * With no active profile every tool is registered, so this is `true` — guidance
 * on the full surface is unchanged. Use this to CHOOSE guidance, never to
 * decide whether an operation is permitted; registration is the gate.
 */
export function isToolAvailable(name: string): boolean {
  return activeProfile === null || activeProfile.includes(name);
}

/**
 * "You have no allowance yet" — phrased for whoever is actually asking.
 *
 * Five call sites needed this sentence and four of them hard-coded
 * `allowance_create`, which the buyer profile does not register. One helper
 * rather than five ternaries, so the next call site inherits the fix instead of
 * repeating the bug.
 */
export function noAllowanceHint(): string {
  return isToolAvailable("allowance_create")
    ? "No agent allowance found. Use `allowance_create` to create one."
    : "No agent allowance found. Use `init` to create and fund one in a single call.";
}
