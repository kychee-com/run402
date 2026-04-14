import { advanceLifecycle } from "./project-lifecycle.js";
import { errorMessage } from "../utils/errors.js";

let leaseInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Hourly tick: advance the project lifecycle state machine.
 *
 * The previous implementation called `archiveProject` directly when a wallet's
 * lease had been expired for more than 7 days. Under the lifecycle state
 * machine (see services/project-lifecycle.ts), this tick now just advances
 * transitions and the cascade fires only when a project reaches `purged` at
 * the end of the ~100-day grace window.
 *
 * A failure in one project's transition does not affect others — each
 * transition is independently error-isolated inside `advanceLifecycle`.
 */
async function tick(): Promise<void> {
  try {
    await advanceLifecycle();
  } catch (err) {
    console.error("  [lifecycle-scheduler] tick failed:", errorMessage(err));
  }
}

export function startLeaseChecker(): void {
  leaseInterval = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  console.log("  Lifecycle scheduler started (hourly)");
}

export function stopLeaseChecker(): void {
  if (leaseInterval) {
    clearInterval(leaseInterval);
    leaseInterval = null;
  }
}
