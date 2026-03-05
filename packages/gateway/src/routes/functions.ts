/**
 * Functions routes — deploy, invoke, list, delete, logs, secrets.
 */

import { Router, Request, Response } from "express";
import {
  deployFunction,
  invokeFunction,
  listFunctions,
  deleteFunction,
  getFunctionLogs,
  setSecret,
  deleteSecret,
  listSecrets,
  FunctionError,
} from "../services/functions.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { TIERS } from "@run402/shared";

const router = Router();

// --- Admin routes (service_key auth) ---

// POST /admin/v1/projects/:id/functions — deploy a function
router.post(
  "/admin/v1/projects/:id/functions",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = req.params.id as string;
    const { name, code, config, deps } = req.body || {};

    if (!name || typeof name !== "string") {
      throw new HttpError(400, "Missing or invalid 'name' field");
    }
    if (!code || typeof code !== "string") {
      throw new HttpError(400, "Missing or invalid 'code' field");
    }
    if (deps && !Array.isArray(deps)) {
      throw new HttpError(400, "'deps' must be an array of package names");
    }

    const project = req.project!;
    const tier = TIERS[project.tier];
    const apiBase = `${req.protocol}://${req.get("host")}`;

    try {
      const fn = await deployFunction(
        projectId,
        name,
        code,
        project.serviceKey,
        apiBase,
        config,
        deps,
        tier,
      );
      res.status(201).json({
        name: fn.name,
        url: fn.url,
        status: "deployed",
        runtime: fn.runtime,
        timeout: fn.timeout,
        memory: fn.memory,
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

// GET /admin/v1/projects/:id/functions — list functions
router.get(
  "/admin/v1/projects/:id/functions",
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
        created_at: fn.created_at,
        updated_at: fn.updated_at,
      })),
    });
  }),
);

// DELETE /admin/v1/projects/:id/functions/:name — delete a function
router.delete(
  "/admin/v1/projects/:id/functions/:name",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await deleteFunction(req.params.id as string, req.params.name as string);
      res.json({ status: "deleted" });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// GET /admin/v1/projects/:id/functions/:name/logs — get function logs
router.get(
  "/admin/v1/projects/:id/functions/:name/logs",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const tail = parseInt(req.query.tail as string || "50", 10);
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

// POST /admin/v1/projects/:id/secrets — set a secret
router.post(
  "/admin/v1/projects/:id/secrets",
  serviceKeyAuth,
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
      res.status(200).json({ status: "set", key });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// DELETE /admin/v1/projects/:id/secrets/:key — delete a secret
router.delete(
  "/admin/v1/projects/:id/secrets/:key",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await deleteSecret(req.params.id as string, req.params.key as string);
      res.json({ status: "deleted" });
    } catch (err: unknown) {
      if (err instanceof FunctionError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

// GET /admin/v1/projects/:id/secrets — list secrets (keys only)
router.get(
  "/admin/v1/projects/:id/secrets",
  serviceKeyAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const secrets = await listSecrets(req.params.id as string);
    res.json({ secrets });
  }),
);

// --- Public invocation route ---

// ALL /functions/v1/:name — invoke a function (apikey auth + metering)
router.all(
  "/functions/v1/:name",
  apikeyAuth,
  meteringMiddleware,
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
