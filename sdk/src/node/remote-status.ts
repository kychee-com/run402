import type { Run402 } from "../index.js";
/** Remote failures are unavailable evidence, never proof of missing setup. */
export async function readRemoteStatus(sdk: Pick<Run402, "tier" | "billing" | "projects">, wallet: string) {
  const settled = await Promise.allSettled([sdk.tier.status(), sdk.billing.checkBalance(wallet), sdk.projects.list()]);
  const availability = Object.fromEntries(settled.map((result, index) => {
    const name = ["tier", "billing", "projects"][index]!;
    if (result.status === "fulfilled") return [name, { state: "available" }];
    const error = result.reason as { code?: unknown; category?: unknown; kind?: unknown } | null;
    // Do not serialize raw exceptions, which can contain credentials or request bodies.
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : null;
    const category = ["network", "auth", "payment", "local"].includes(String(error?.category)) ? error!.category : null;
    return [name, { state: "unavailable", code, category }];
  }));
  return {
    tier: settled[0].status === "fulfilled" ? settled[0].value : null,
    billing: settled[1].status === "fulfilled" ? settled[1].value : null,
    remote: settled[2].status === "fulfilled" ? settled[2].value : null,
    availability,
    next_actions: settled.some(result => result.status === "rejected")
      ? [{ type: "retry", why: "Remote status is unavailable. Check connectivity or the reported authentication error and retry status; unavailable state does not mean setup is missing." }] : [],
  };
}
