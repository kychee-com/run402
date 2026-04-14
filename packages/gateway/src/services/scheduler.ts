/**
 * Scheduler service — cron-based scheduled invocation of deployed functions.
 *
 * Uses croner for cron expression parsing and scheduling.
 * Timers are in-memory; schedule config is persisted in internal.functions.
 */

import { Cron } from "croner";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { invokeFunction } from "./functions.js";
import { incrementProjectCalls, getProjectCallCount } from "../middleware/metering.js";
import type { TierConfig } from "@run402/shared";

/** Active cron jobs keyed by "projectId:functionName" */
const jobs = new Map<string, Cron>();

/**
 * Whether scheduled-function invocation is allowed for a project in the given
 * lifecycle status. active/past_due/frozen keep running; dormant and terminal
 * states (purging/purged/archived) skip invocation and don't charge metering.
 */
export function scheduledInvocationAllowed(status: string): boolean {
  return status === "active" || status === "past_due" || status === "frozen";
}

function jobKey(projectId: string, name: string): string {
  return `${projectId}:${name}`;
}

/**
 * Validate a cron expression. Returns true if valid 5-field cron.
 */
export function isValidCron(expr: string): boolean {
  try {
    // Dry-run parse — don't actually schedule
    const job = new Cron(expr, { paused: true }, () => {});
    job.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the minimum interval in minutes for a cron expression.
 * Estimates by checking the gap between the next two scheduled runs.
 */
export function getCronIntervalMinutes(expr: string): number {
  try {
    const job = new Cron(expr, { paused: true }, () => {});
    const next1 = job.nextRun();
    const next2 = job.nextRuns(2)[1];
    job.stop();
    if (!next1 || !next2) return Infinity;
    return (next2.getTime() - next1.getTime()) / 60_000;
  } catch {
    return 0;
  }
}

/**
 * Update schedule_meta in the DB after a cron/trigger invocation.
 */
async function updateScheduleMeta(
  projectId: string,
  name: string,
  status: number,
  error: string | null,
  cronExpr: string | null,
): Promise<void> {
  const nextRunAt = cronExpr ? (() => {
    try {
      const job = new Cron(cronExpr, { paused: true }, () => {});
      const next = job.nextRun();
      job.stop();
      return next?.toISOString() ?? null;
    } catch { return null; }
  })() : null;

  await pool.query(
    sql(`UPDATE internal.functions SET schedule_meta = jsonb_build_object(
      'last_run_at', to_jsonb(now()),
      'last_status', $3::int,
      'run_count', COALESCE((schedule_meta->>'run_count')::int, 0) + 1,
      'last_error', $4::text,
      'next_run_at', $5::text
    ), updated_at = now()
    WHERE project_id = $1 AND name = $2`),
    [projectId, name, status, error, nextRunAt],
  );
}

/**
 * The cron tick handler — invokes a function and updates metadata.
 */
async function onTick(projectId: string, name: string, cronExpr: string): Promise<void> {
  try {
    // Check API quota and lifecycle state before invoking
    const projResult = await pool.query(
      sql(`SELECT tier, api_calls, status FROM internal.projects WHERE id = $1`),
      [projectId],
    );
    if (projResult.rows.length === 0) {
      console.error(`  Scheduler: project ${projectId} not found, skipping tick for ${name}`);
      return;
    }
    // Scheduled functions pause at dormancy.
    const status = projResult.rows[0].status as string;
    if (!scheduledInvocationAllowed(status)) {
      console.log(`  Scheduler: ${projectId}/${name} skipped (project status=${status}, scheduled_function_paused)`);
      return;
    }
    const { TIERS } = await import("@run402/shared");
    const tierConfig = TIERS[projResult.rows[0].tier as keyof typeof TIERS];
    const dbCalls = projResult.rows[0].api_calls ?? 0;
    const memCalls = getProjectCallCount(projectId);
    if (tierConfig && (dbCalls + memCalls) >= tierConfig.apiCalls) {
      console.warn(`  Scheduler: quota exceeded for ${projectId}/${name}, skipping`);
      await updateScheduleMeta(projectId, name, 0, "API quota exceeded", cronExpr);
      return;
    }

    // Increment metering
    incrementProjectCalls(projectId);

    const scheduledAt = new Date().toISOString();
    const result = await invokeFunction(
      projectId,
      name,
      "POST",
      `/functions/v1/${name}`,
      {
        "content-type": "application/json",
        "x-run402-trigger": "cron",
      },
      JSON.stringify({ trigger: "cron", scheduled_at: scheduledAt }),
      "",
    );

    await updateScheduleMeta(projectId, name, result.statusCode, null, cronExpr);
    console.log(`  Scheduler: ${projectId}/${name} → ${result.statusCode}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Scheduler: ${projectId}/${name} error: ${msg}`);
    await updateScheduleMeta(projectId, name, 500, msg, cronExpr).catch(() => {});
  }
}

/**
 * Register a cron schedule for a function. Cancels any existing schedule first.
 */
export function registerSchedule(projectId: string, name: string, cronExpr: string): void {
  const key = jobKey(projectId, name);
  // Cancel existing if any
  const existing = jobs.get(key);
  if (existing) {
    existing.stop();
    jobs.delete(key);
  }

  const job = new Cron(cronExpr, () => {
    onTick(projectId, name, cronExpr).catch((err) => {
      console.error(`  Scheduler tick error for ${key}:`, err);
    });
  });
  jobs.set(key, job);
}

/**
 * Cancel a cron schedule for a function.
 */
export function cancelSchedule(projectId: string, name: string): void {
  const key = jobKey(projectId, name);
  const job = jobs.get(key);
  if (job) {
    job.stop();
    jobs.delete(key);
  }
}

/**
 * Cancel all cron schedules (shutdown).
 */
export function cancelAll(): void {
  for (const [, job] of jobs) {
    job.stop();
  }
  jobs.clear();
}

/**
 * Trigger a function manually (same as cron tick). Updates schedule_meta.
 */
export async function triggerFunction(
  projectId: string,
  name: string,
): Promise<{ status: number; body: string }> {
  // Look up the function's schedule (if any) for next_run_at calculation
  const fnResult = await pool.query(
    sql(`SELECT schedule FROM internal.functions WHERE project_id = $1 AND name = $2`),
    [projectId, name],
  );
  if (fnResult.rows.length === 0) {
    throw new Error("Function not found");
  }
  const cronExpr = fnResult.rows[0].schedule;

  const scheduledAt = new Date().toISOString();
  const result = await invokeFunction(
    projectId,
    name,
    "POST",
    `/functions/v1/${name}`,
    {
      "content-type": "application/json",
      "x-run402-trigger": "manual",
    },
    JSON.stringify({ trigger: "manual", scheduled_at: scheduledAt }),
    "",
  );

  // Update schedule_meta if the function has a schedule
  if (cronExpr) {
    await updateScheduleMeta(projectId, name, result.statusCode, null, cronExpr);
  }

  return { status: result.statusCode, body: result.body };
}

/**
 * Start the scheduler — load all scheduled functions from DB and register timers.
 */
export async function startScheduler(): Promise<void> {
  const result = await pool.query(
    sql(`SELECT project_id, name, schedule FROM internal.functions WHERE schedule IS NOT NULL`),
  );
  let count = 0;
  for (const row of result.rows) {
    try {
      registerSchedule(row.project_id, row.name, row.schedule);
      count++;
    } catch (err: unknown) {
      console.error(`  Scheduler: failed to register ${row.project_id}/${row.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (count > 0) {
    console.log(`  Scheduler: registered ${count} scheduled function(s)`);
  }
}

/**
 * Stop the scheduler — cancel all timers.
 */
export function stopScheduler(): void {
  const count = jobs.size;
  cancelAll();
  if (count > 0) {
    console.log(`  Scheduler: cancelled ${count} timer(s)`);
  }
}
