/**
 * Functions routes — deploy, invoke, list, delete, logs, secrets.
 */

import { Router, Request, Response } from "express";
import {
  deployFunction,
  invokeFunction,
  listFunctions,
  deleteFunction,
  updateFunctionConfig,
  getFunctionLogs,
  setSecret,
  deleteSecret,
  listSecrets,
  FunctionError,
} from "../services/functions.js";
import {
  isValidCron,
  getCronIntervalMinutes,
  registerSchedule,
  cancelSchedule,
  triggerFunction,
} from "../services/scheduler.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { validatePaginationInt } from "../utils/validate.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { demoBlockedMiddleware, demoFunctionInvokeMiddleware } from "../middleware/demo.js";
import { walletAuthOrAdmin } from "../middleware/admin-auth.js";
import { pool } from "../db/pool.js";
import { sql, type SQL } from "../db/sql.js";
import { TIERS } from "@run402/shared";

const router = Router();

// GET /v1/functions — list all functions (admin: all, wallet: own projects)
router.get(
  "/functions/v1",
  walletAuthOrAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const apiBase = `${req.protocol}://${req.get("host")}`;
    let query: SQL;
    let params: unknown[];

    if (req.isAdmin) {
      query = sql(`SELECT f.name, f.project_id, f.created_at, f.updated_at FROM internal.functions f ORDER BY f.created_at DESC`);
      params = [];
    } else {
      const wallet = req.walletAddress;
      if (!wallet) { res.status(401).json({ error: "No wallet address" }); return; }
      query = sql(`SELECT f.name, f.project_id, f.created_at, f.updated_at FROM internal.functions f JOIN internal.projects p ON f.project_id = p.id WHERE p.wallet_address = $1 ORDER BY f.created_at DESC`);
      params = [wallet];
    }

    const result = await pool.query(query, params);
    res.json({
      functions: result.rows.map((r: Record<string, unknown>) => ({
        name: r.name,
        project_id: r.project_id,
        url: `${apiBase}/functions/v1/${r.name}`,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  }),
);

// --- Admin routes (service_key auth) ---

// POST /projects/v1/admin/:id/functions — deploy a function (blocked in demo mode)
router.post(
  "/projects/v1/admin/:id/functions",
  serviceKeyAuth,
  demoBlockedMiddleware("Function deployment"),
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = req.params.id as string;
    const { name, code, config, deps, schedule } = req.body || {};

    if (!name || typeof name !== "string") {
      throw new HttpError(400, "Missing or invalid 'name' field");
    }
    if (!code || typeof code !== "string") {
      throw new HttpError(400, "Missing or invalid 'code' field");
    }
    if (deps && !Array.isArray(deps)) {
      throw new HttpError(400, "'deps' must be an array of package names");
    }

    // Validate schedule if provided
    const scheduleExpr: string | null = schedule != null && schedule !== "" ? schedule : null;
    if (scheduleExpr !== null) {
      if (typeof scheduleExpr !== "string") {
        throw new HttpError(400, "'schedule' must be a cron expression string");
      }
      if (!isValidCron(scheduleExpr)) {
        throw new HttpError(400, `Invalid cron expression: "${scheduleExpr}". Use standard 5-field cron syntax (e.g., "*/15 * * * *").`);
      }
    }

    const project = req.project!;
    const tier = TIERS[project.tier];

    // Validate schedule tier limits
    if (scheduleExpr !== null) {
      // Check minimum interval
      const intervalMinutes = getCronIntervalMinutes(scheduleExpr);
      if (intervalMinutes < tier.minScheduleIntervalMinutes) {
        throw new HttpError(403, `Schedule interval too frequent (${intervalMinutes}min). Your ${project.tier} tier requires at least ${tier.minScheduleIntervalMinutes} minutes between runs.`);
      }

      // Check scheduled function count
      const { rows } = await pool.query(
        sql(`SELECT count(*)::int AS cnt FROM internal.functions WHERE project_id = $1 AND schedule IS NOT NULL AND name != $2`),
        [projectId, name],
      );
      if (rows[0].cnt >= tier.maxScheduledFunctions) {
        throw new HttpError(403, `Scheduled function limit reached (${tier.maxScheduledFunctions} for your ${project.tier} tier). Remove a schedule or upgrade.`);
      }
    }

    const apiBase = `${req.protocol}://${req.get("host")}`;
    // Extract service key from the Authorization header (serviceKeyAuth already validated it)
    const serviceKey = (req.headers.authorization || "").replace("Bearer ", "");

    try {
      const fn = await deployFunction(
        projectId,
        name,
        code,
        serviceKey,
        apiBase,
        config,
        deps,
        tier,
      );

      // Persist schedule to DB and register/cancel cron timer
      if (scheduleExpr !== null) {
        await pool.query(
          sql(`UPDATE internal.functions SET schedule = $3, schedule_meta = COALESCE(schedule_meta, '{"run_count": 0}'::jsonb) WHERE project_id = $1 AND name = $2`),
          [projectId, name, scheduleExpr],
        );
        registerSchedule(projectId, name, scheduleExpr);
      } else if (schedule === null) {
        // Explicit null = remove schedule
        await pool.query(
          sql(`UPDATE internal.functions SET schedule = NULL, schedule_meta = NULL WHERE project_id = $1 AND name = $2`),
          [projectId, name],
        );
        cancelSchedule(projectId, name);
      }

      res.status(201).json({
        name: fn.name,
        url: fn.url,
        status: "deployed",
        runtime: fn.runtime,
        timeout: fn.timeout,
        memory: fn.memory,
        schedule: scheduleExpr,
        created_at: fn.created_at,
      });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// GET /projects/v1/admin/:id/functions — list functions
router.get(
  "/projects/v1/admin/:id/functions",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const apiBase = `${req.protocol}://${req.get("host")}`;
    const functions = await listFunctions(req.params.id as string, apiBase);
    res.json({
      functions: functions.map((fn) => ({
        name: fn.name,
        url: fn.url,
        runtime: fn.runtime,
        timeout: fn.timeout,
        memory: fn.memory,
        schedule: fn.schedule,
        schedule_meta: fn.schedule_meta,
        created_at: fn.created_at,
        updated_at: fn.updated_at,
      })),
    });
  }),
);

// DELETE /projects/v1/admin/:id/functions/:name — delete a function
router.delete(
  "/projects/v1/admin/:id/functions/:name",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      cancelSchedule(req.params.id as string, req.params.name as string);
      await deleteFunction(req.params.id as string, req.params.name as string);
      res.json({ status: "deleted", name: req.params.name });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// PATCH /projects/v1/admin/:id/functions/:name — update function metadata (schedule, config)
router.patch(
  "/projects/v1/admin/:id/functions/:name",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = req.params.id as string;
    const name = req.params.name as string;
    const { schedule, config } = req.body || {};

    // Look up existing function
    const fnResult = await pool.query(
      sql(`SELECT name, runtime, timeout_seconds, memory_mb, schedule, schedule_meta, created_at, updated_at
       FROM internal.functions WHERE project_id = $1 AND name = $2`),
      [projectId, name],
    );
    if (fnResult.rows.length === 0) {
      throw new HttpError(404, `Function '${name}' not found`);
    }

    const project = req.project!;
    const tier = TIERS[project.tier];

    // --- Schedule update ---
    const scheduleExpr: string | null | undefined =
      schedule != null && schedule !== "" ? schedule : schedule;

    if (typeof scheduleExpr === "string") {
      if (!isValidCron(scheduleExpr)) {
        throw new HttpError(400, `Invalid cron expression: "${scheduleExpr}". Use standard 5-field cron syntax (e.g., "*/15 * * * *").`);
      }
      const intervalMinutes = getCronIntervalMinutes(scheduleExpr);
      if (intervalMinutes < tier.minScheduleIntervalMinutes) {
        throw new HttpError(403, `Schedule interval too frequent (${intervalMinutes}min). Your ${project.tier} tier requires at least ${tier.minScheduleIntervalMinutes} minutes between runs.`);
      }
      const { rows } = await pool.query(
        sql(`SELECT count(*)::int AS cnt FROM internal.functions WHERE project_id = $1 AND schedule IS NOT NULL AND name != $2`),
        [projectId, name],
      );
      if (rows[0].cnt >= tier.maxScheduledFunctions) {
        throw new HttpError(403, `Scheduled function limit reached (${tier.maxScheduledFunctions} for your ${project.tier} tier). Remove a schedule or upgrade.`);
      }
      await pool.query(
        sql(`UPDATE internal.functions SET schedule = $3, schedule_meta = COALESCE(schedule_meta, '{"run_count": 0}'::jsonb), updated_at = NOW() WHERE project_id = $1 AND name = $2`),
        [projectId, name, scheduleExpr],
      );
      registerSchedule(projectId, name, scheduleExpr);
    } else if (scheduleExpr === null) {
      await pool.query(
        sql(`UPDATE internal.functions SET schedule = NULL, schedule_meta = NULL, updated_at = NOW() WHERE project_id = $1 AND name = $2`),
        [projectId, name],
      );
      cancelSchedule(projectId, name);
    }

    // --- Config update (timeout / memory) ---
    if (config && typeof config === "object") {
      const timeout = config.timeout != null ? Number(config.timeout) : undefined;
      const memory = config.memory != null ? Number(config.memory) : undefined;

      if (timeout != null) {
        if (timeout < 1 || timeout > tier.functionTimeoutSec) {
          throw new HttpError(403, `Timeout must be 1-${tier.functionTimeoutSec}s for your ${project.tier} tier.`);
        }
      }
      if (memory != null) {
        if (memory < 128 || memory > tier.functionMemoryMb) {
          throw new HttpError(403, `Memory must be 128-${tier.functionMemoryMb}MB for your ${project.tier} tier.`);
        }
      }

      // Update DB
      const setClauses: string[] = ["updated_at = NOW()"];
      const params: unknown[] = [projectId, name];
      let paramIdx = 3;
      if (timeout != null) {
        setClauses.push(`timeout_seconds = $${paramIdx++}`);
        params.push(timeout);
      }
      if (memory != null) {
        setClauses.push(`memory_mb = $${paramIdx++}`);
        params.push(memory);
      }
      if (setClauses.length > 1) {
        await pool.query(
          sql(`UPDATE internal.functions SET ${setClauses.join(", ")} WHERE project_id = $1 AND name = $2`),
          params,
        );
        // Update Lambda configuration (no code re-upload)
        await updateFunctionConfig(projectId, name, { timeout, memory });
      }
    }

    // Return updated state
    const updated = await pool.query(
      sql(`SELECT name, runtime, timeout_seconds, memory_mb, schedule, schedule_meta, created_at, updated_at
       FROM internal.functions WHERE project_id = $1 AND name = $2`),
      [projectId, name],
    );
    const row = updated.rows[0];
    res.json({
      name: row.name,
      runtime: row.runtime,
      timeout: row.timeout_seconds,
      memory: row.memory_mb,
      schedule: row.schedule ?? null,
      schedule_meta: row.schedule_meta ?? null,
      updated_at: row.updated_at,
    });
  }),
);

// POST /projects/v1/admin/:id/functions/:name/trigger — manually trigger a function
router.post(
  "/projects/v1/admin/:id/functions/:name/trigger",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await triggerFunction(req.params.id as string, req.params.name as string);
      res.json({ status: result.status, body: result.body });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      if (err instanceof Error && err.message === "Function not found") {
        throw new HttpError(404, "Function not found");
      }
      throw err;
    }
  }),
);

// GET /projects/v1/admin/:id/functions/:name/logs — get function logs
router.get(
  "/projects/v1/admin/:id/functions/:name/logs",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const tail = validatePaginationInt(req.query.tail, "tail", { fallback: 50, max: 1000 });
    try {
      const logs = await getFunctionLogs(req.params.id as string, req.params.name as string, tail);
      res.json({ logs });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// --- Secrets routes ---

// POST /projects/v1/admin/:id/secrets — set a secret (blocked in demo mode)
router.post(
  "/projects/v1/admin/:id/secrets",
  serviceKeyAuth,
  demoBlockedMiddleware("Secret management"),
  asyncHandler(async (req: Request, res: Response) => {
    const { key, value } = req.body || {};
    if (!key || typeof key !== "string") {
      throw new HttpError(400, "Missing or invalid 'key' field");
    }
    if (value === undefined || value === null || typeof value !== "string") {
      throw new HttpError(400, "Missing or invalid 'value' field");
    }

    const project = req.project!;
    const tier = TIERS[project.tier];

    try {
      await setSecret(req.params.id as string, key, value, tier);
      res.status(201).json({ status: "set", key });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// DELETE /projects/v1/admin/:id/secrets/:key — delete a secret
router.delete(
  "/projects/v1/admin/:id/secrets/:key",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await deleteSecret(req.params.id as string, req.params.key as string);
      res.json({ status: "deleted", key: req.params.key });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// GET /projects/v1/admin/:id/secrets — list secrets (keys only)
router.get(
  "/projects/v1/admin/:id/secrets",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const secrets = await listSecrets(req.params.id as string);
    res.json({ secrets });
  }),
);

// --- Public invocation route ---

// ALL /functions/v1/:name — invoke a function (apikey auth + metering)
// Matches both /functions/v1/myFunc and /functions/v1/myFunc/sub/path
router.all(
  ["/functions/v1/:name", "/functions/v1/:name/*splat"],
  apikeyAuth,
  meteringMiddleware,
  demoFunctionInvokeMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project!;
    const fnName = req.params.name as string;

    // Forward relevant headers to the function
    const forwardHeaders: Record<string, string> = {};
    if (req.headers.authorization) {
      forwardHeaders["authorization"] = req.headers.authorization as string;
    }
    if (req.headers["content-type"]) {
      forwardHeaders["content-type"] = req.headers["content-type"] as string;
    }
    if (req.headers["apikey"]) {
      forwardHeaders["apikey"] = req.headers["apikey"] as string;
    }

    // Get request body as string
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const queryString = req.url.includes("?") ? req.url.split("?")[1] || "" : "";

    try {
      const result = await invokeFunction(
        project.id,
        fnName,
        req.method,
        req.path,
        forwardHeaders,
        body,
        queryString,
      );

      // Set CORS headers
      res.set("Access-Control-Allow-Origin", "*");

      // Forward response headers from Lambda
      for (const [key, value] of Object.entries(result.headers)) {
        if (key.toLowerCase() !== "transfer-encoding") {
          res.set(key, value);
        }
      }

      res.status(result.statusCode).send(result.body);
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

export default router;
