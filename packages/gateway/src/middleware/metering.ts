import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.js";
import { METERING_FLUSH_INTERVAL } from "../config.js";
import { getTierLimits } from "@run402/shared";
import type { TierName } from "@run402/shared";
import { errorMessage } from "../utils/errors.js";

// In-memory counters, flushed to DB periodically
const counters = new Map<string, { apiCalls: number; lastFlushed: number }>();

/**
 * Middleware: increment API call counter and enforce budget.
 * Must run after apikey auth (requires req.project).
 *
 * If req.walletAddress is set (wallet auth), checks pool limits
 * across all the wallet's projects. Otherwise falls back to per-project limits.
 */
export function meteringMiddleware(req: Request, res: Response, next: NextFunction): void {
  const project = req.project;
  if (!project) {
    next();
    return;
  }

  // Get or create counter
  let counter = counters.get(project.id);
  if (!counter) {
    counter = { apiCalls: 0, lastFlushed: Date.now() };
    counters.set(project.id, counter);
  }

  // Increment
  counter.apiCalls++;
  project.apiCalls++;

  // Use wallet-level tier if available, otherwise project tier
  const tier = (req.walletTier as TierName) || project.tier;
  const limits = getTierLimits(tier);

  // Per-project budget check (individual project limits still apply)
  if (project.apiCalls >= limits.apiCalls) {
    res.status(402).json({
      error: "API call limit exceeded",
      message: `Your ${tier} tier allows ${limits.apiCalls.toLocaleString()} API calls. Upgrade your tier to continue.`,
      usage: { api_calls: project.apiCalls, limit: limits.apiCalls },
    });
    return;
  }

  if (project.storageBytes >= limits.storageBytes) {
    res.status(402).json({
      error: "Storage limit exceeded",
      message: `Your ${tier} tier allows ${(limits.storageBytes / 1024 / 1024).toFixed(0)}MB storage. Upgrade your tier to continue.`,
      usage: { storage_bytes: project.storageBytes, limit: limits.storageBytes },
    });
    return;
  }

  next();
}

/**
 * Flush in-memory counters to the database.
 * Called on interval and during graceful shutdown.
 */
export async function flushCounters(): Promise<void> {
  const entries = Array.from(counters.entries());
  if (entries.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [projectId, counter] of entries) {
      if (counter.apiCalls > 0) {
        await client.query(
          `UPDATE internal.projects SET api_calls = api_calls + $1 WHERE id = $2`,
          [counter.apiCalls, projectId],
        );
        counter.apiCalls = 0;
        counter.lastFlushed = Date.now();
      }
    }
    await client.query("COMMIT");
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    console.error("Failed to flush metering counters:", errorMessage(err));
  } finally {
    client.release();
  }
}

let flushInterval: ReturnType<typeof setInterval> | null = null;

export function startMeteringFlush(): void {
  flushInterval = setInterval(flushCounters, METERING_FLUSH_INTERVAL);
}

export function stopMeteringFlush(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}
