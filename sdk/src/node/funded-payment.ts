import { setTimeout as delay } from "node:timers/promises";
import { isRun402Error } from "../errors.js";

/** A confirmed faucet receipt can precede visibility on the buyer's RPC.
 * Retry only the buyer's proven pre-payment balance miss, never a payment.
 * Called only immediately after a successful faucet in this workflow.
 */
export async function afterFaucet<T>(
  pay: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<T> {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + 30_000;
  for (let retry = 0; ; retry++) {
    try {
      return await pay();
    } catch (error) {
      const details = isRun402Error(error) ? error.details as Record<string, unknown> | undefined : undefined;
      if (!isRun402Error(error) || error.code !== "X402_INSUFFICIENT_FUNDS"
        || details?.phase !== "balance_preflight" || details.payment_started !== false
        || error.mutationState !== "not_started" || retry >= 30 || now() >= deadline) throw error;
      await sleep(Math.min(1000, deadline - now()));
      if (now() >= deadline) throw error;
    }
  }
}
