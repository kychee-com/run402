/**
 * Functions service — deploy/invoke/delete/logs for serverless functions (Lambda).
 */

import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  ResourceNotFoundException,
  ResourceConflictException,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { transform } from "esbuild";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pool } from "../db/pool.js";
import {
  LAMBDA_ROLE_ARN,
  LAMBDA_LAYER_ARN,
  LAMBDA_SUBNET_IDS,
  LAMBDA_SG_ID,
  FUNCTIONS_LOG_GROUP,
  S3_REGION,
  JWT_SECRET,
} from "../config.js";
import type { FunctionRecord } from "@run402/shared";

// AWS clients (only initialized if LAMBDA_ROLE_ARN is set)
const lambda = LAMBDA_ROLE_ARN
  ? new LambdaClient({ region: S3_REGION })
  : null;
const cwLogs = LAMBDA_ROLE_ARN
  ? new CloudWatchLogsClient({ region: S3_REGION })
  : null;

const FUNCTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_CODE_SIZE = 1_000_000; // 1 MB

/**
 * Custom error with HTTP status code.
 */
export class FunctionError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

/**
 * Build the Lambda function name from project + function name.
 */
function lambdaName(projectId: string, name: string): string {
  return `run402_${projectId}_${name}`;
}

/**
 * Transpile TypeScript to JavaScript using esbuild.
 * Valid JS passes through unchanged (TS loader is a superset of JS).
 */
async function transpileTS(code: string): Promise<string> {
  try {
    const result = await transform(code, { loader: "ts" });
    return result.code;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FunctionError(`Transpilation failed: ${msg}`, 400);
  }
}

/**
 * Build the shim wrapper code that imports user code and exposes a Lambda handler.
 */
async function buildShimCode(userCode: string): Promise<string> {
  // The shim wraps the user's default export in a Lambda handler.
  // User code is written to /tmp at cold start so bare module specifiers
  // (e.g. "@run402/functions", "openai") resolve from the layer's node_modules.
  const transpiled = await transpileTS(userCode);
  const encoded = Buffer.from(transpiled).toString("base64");
  return `
import { writeFileSync } from "node:fs";

const USER_CODE_B64 = ${JSON.stringify(encoded)};
const USER_CODE_PATH = "/tmp/_user_code_" + Date.now() + ".mjs";

// Write user code to /tmp at cold start
writeFileSync(USER_CODE_PATH, Buffer.from(USER_CODE_B64, "base64").toString("utf-8"));

let userModule;
try {
  userModule = await import(USER_CODE_PATH);
} catch (importErr) {
  console.error("Failed to import user code:", importErr);
}

export async function handler(event, context) {
  if (!userModule) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }

  const handlerFn = userModule.default || userModule.handler;
  if (typeof handlerFn !== "function") {
    console.error("User code does not export a default function or handler");
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }

  // Build a Web Request from the Lambda event
  const method = event.httpMethod || event.requestContext?.http?.method || "POST";
  const path = event.path || event.rawPath || "/";
  const queryString = event.rawQueryString || "";
  const fullUrl = "https://localhost" + path + (queryString ? "?" + queryString : "");
  const headers = event.headers || {};
  const bodyStr = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf-8")
    : (event.body || "");

  const reqInit = {
    method,
    headers,
  };
  if (method !== "GET" && method !== "HEAD" && bodyStr) {
    reqInit.body = bodyStr;
  }

  const request = new Request(fullUrl, reqInit);

  try {
    const response = await handlerFn(request);

    // Handle Web Response
    if (response instanceof Response) {
      const resBody = await response.text();
      const resHeaders = {};
      response.headers.forEach((v, k) => { resHeaders[k] = v; });
      return {
        statusCode: response.status,
        headers: resHeaders,
        body: resBody,
      };
    }

    // Handle plain object return
    if (response && typeof response === "object") {
      return {
        statusCode: response.statusCode || 200,
        headers: { "content-type": "application/json", ...(response.headers || {}) },
        body: typeof response.body === "string" ? response.body : JSON.stringify(response.body || response),
      };
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error("Function error:", err.stack || err.message || err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }
}
`;
}

/**
 * Ensure the functions and secrets tables exist (idempotent).
 */
export async function initFunctionsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS internal.functions (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      lambda_arn TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'node22',
      timeout_seconds INTEGER NOT NULL DEFAULT 10,
      memory_mb INTEGER NOT NULL DEFAULT 128,
      code_hash TEXT NOT NULL,
      deps TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(project_id, name)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_functions_project
      ON internal.functions(project_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS internal.secrets (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(project_id, key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_secrets_project
      ON internal.secrets(project_id)
  `);
}

/**
 * Validate function name.
 */
function validateFunctionName(name: string): void {
  if (!FUNCTION_NAME_RE.test(name)) {
    throw new FunctionError(
      "Function name must be lowercase alphanumeric + hyphens, 1-63 chars, starting with alphanumeric",
      400,
    );
  }
}

/**
 * Deploy (create or update) a function.
 */
export async function deployFunction(
  projectId: string,
  name: string,
  code: string,
  serviceKey: string,
  apiBase: string,
  config?: { timeout?: number; memory?: number },
  deps?: string[],
  tierLimits?: { maxFunctions: number; functionTimeoutSec: number; functionMemoryMb: number; maxSecrets: number },
): Promise<FunctionRecord> {
  validateFunctionName(name);

  if (!code || code.length === 0) {
    throw new FunctionError("Code is required", 400);
  }
  if (code.length > MAX_CODE_SIZE) {
    throw new FunctionError(`Code exceeds 1MB limit (${(code.length / 1024).toFixed(0)}KB)`, 400);
  }

  // Check function count quota
  if (tierLimits) {
    const existing = await pool.query(
      `SELECT count(*)::int AS cnt FROM internal.functions WHERE project_id = $1`,
      [projectId],
    );
    const count = existing.rows[0].cnt;
    // Allow update of existing function
    const existingFn = await pool.query(
      `SELECT 1 FROM internal.functions WHERE project_id = $1 AND name = $2`,
      [projectId, name],
    );
    if (existingFn.rows.length === 0 && count >= tierLimits.maxFunctions) {
      throw new FunctionError(
        `Function limit reached (${tierLimits.maxFunctions} for your tier). Delete a function first.`,
        403,
      );
    }
  }

  const timeout = Math.min(
    config?.timeout || tierLimits?.functionTimeoutSec || 10,
    tierLimits?.functionTimeoutSec || 60,
  );
  const memory = Math.min(
    config?.memory || tierLimits?.functionMemoryMb || 128,
    tierLimits?.functionMemoryMb || 512,
  );

  const codeHash = createHash("sha256").update(code).digest("hex");
  const fnName = lambdaName(projectId, name);
  let lambdaArn = "";

  if (!lambda) {
    // --- Local mode: store code on disk, skip Lambda ---
    lambdaArn = `local://${fnName}`;
    await writeLocalFunction(projectId, name, code, serviceKey, apiBase);
    console.log(`  Function deployed (local): ${fnName}`);
  } else {
    // --- Lambda mode ---
    // Build the shim + user code zip
    const shimCode = await buildShimCode(code);
    const zipBuffer = await buildZip(shimCode);

    // Load project secrets for env vars
    const secretRows = await pool.query(
      `SELECT key, value_encrypted FROM internal.secrets WHERE project_id = $1`,
      [projectId],
    );
    const envVars: Record<string, string> = {
      RUN402_PROJECT_ID: projectId,
      RUN402_API_BASE: apiBase,
      RUN402_SERVICE_KEY: serviceKey,
      RUN402_JWT_SECRET: JWT_SECRET,
    };
    for (const row of secretRows.rows) {
      envVars[row.key] = row.value_encrypted;
    }

    // Check if function already exists
    try {
      await lambda.send(new GetFunctionCommand({ FunctionName: fnName }));

      // Wait for any in-progress updates to complete
      try {
        await waitUntilFunctionUpdatedV2(
          { client: lambda, maxWaitTime: 30 },
          { FunctionName: fnName },
        );
      } catch {
        // Best effort — proceed anyway
      }

      // Update existing function code — retry on ResourceConflictException
      // (function may still be in Pending state from a previous deploy)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const updateCodeResult = await lambda.send(new UpdateFunctionCodeCommand({
            FunctionName: fnName,
            ZipFile: zipBuffer,
          }));
          lambdaArn = updateCodeResult.FunctionArn!;
          break;
        } catch (retryErr) {
          if (retryErr instanceof ResourceConflictException && attempt < 2) {
            await waitUntilFunctionUpdatedV2(
              { client: lambda, maxWaitTime: 30 },
              { FunctionName: fnName },
            );
            continue;
          }
          throw retryErr;
        }
      }

      // Wait for code update to complete before updating config
      await waitUntilFunctionUpdatedV2(
        { client: lambda, maxWaitTime: 30 },
        { FunctionName: fnName },
      );

      // Update configuration
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: fnName,
        Timeout: timeout,
        MemorySize: memory,
        Environment: { Variables: envVars },
        Layers: LAMBDA_LAYER_ARN ? [LAMBDA_LAYER_ARN] : undefined,
      }));
    } catch (err: unknown) {
      if (err instanceof ResourceNotFoundException) {
        // Create new function
        const subnetIds = LAMBDA_SUBNET_IDS ? LAMBDA_SUBNET_IDS.split(",") : undefined;
        const createResult = await lambda.send(new CreateFunctionCommand({
          FunctionName: fnName,
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Role: LAMBDA_ROLE_ARN,
          Code: { ZipFile: zipBuffer },
          Timeout: timeout,
          MemorySize: memory,
          Environment: { Variables: envVars },
          Layers: LAMBDA_LAYER_ARN ? [LAMBDA_LAYER_ARN] : undefined,
          VpcConfig: subnetIds ? {
            SubnetIds: subnetIds,
            SecurityGroupIds: LAMBDA_SG_ID ? [LAMBDA_SG_ID] : [],
          } : undefined,
          LoggingConfig: {
            LogGroup: FUNCTIONS_LOG_GROUP,
          },
        }));
        lambdaArn = createResult.FunctionArn!;
      } else if ((err as Error).name === "CredentialsProviderError") {
        throw new FunctionError(
          "AWS credentials not available. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure an IAM role.",
          503,
        );
      } else {
        throw err;
      }
    }
  }

  // Upsert DB record (including source for publish/fork)
  await pool.query(
    `INSERT INTO internal.functions (project_id, name, lambda_arn, runtime, timeout_seconds, memory_mb, code_hash, deps, source)
     VALUES ($1, $2, $3, 'node22', $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, name) DO UPDATE SET
       lambda_arn = $3,
       timeout_seconds = $4,
       memory_mb = $5,
       code_hash = $6,
       deps = $7,
       source = $8,
       updated_at = now()`,
    [projectId, name, lambdaArn, timeout, memory, codeHash, deps || [], code],
  );

  const url = `${apiBase}/functions/v1/${name}`;
  if (lambda) console.log(`  Function deployed: ${fnName} → ${url}`);

  return {
    name,
    url,
    lambda_arn: lambdaArn,
    runtime: "node22",
    timeout,
    memory,
    code_hash: codeHash,
    deps: deps || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Invoke a function synchronously.
 */
export async function invokeFunction(
  projectId: string,
  name: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  queryString: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  // Look up function in DB
  const result = await pool.query(
    `SELECT lambda_arn FROM internal.functions WHERE project_id = $1 AND name = $2`,
    [projectId, name],
  );
  if (result.rows.length === 0) {
    throw new FunctionError("Function not found", 404);
  }

  const fnName = lambdaName(projectId, name);

  if (!lambda) {
    // --- Local mode: execute function in-process ---
    return invokeLocalFunction(projectId, name, method, path, headers, body, queryString);
  }

  // --- Lambda mode ---
  // Build Lambda event (API Gateway v2 format)
  const event = {
    httpMethod: method,
    path,
    rawPath: path,
    rawQueryString: queryString,
    headers,
    body: body || "",
    isBase64Encoded: false,
  };

  let invokeResult;
  try {
    invokeResult = await lambda.send(new InvokeCommand({
      FunctionName: fnName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(event)),
    }));
  } catch (err: unknown) {
    if (err instanceof ResourceConflictException) {
      throw new FunctionError("Function is still deploying, try again in a few seconds", 503);
    }
    if ((err as Error).name === "CredentialsProviderError") {
      throw new FunctionError(
        "AWS credentials not available. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure an IAM role.",
        503,
      );
    }
    throw err;
  }

  if (invokeResult.FunctionError) {
    console.error(`Function ${fnName} error: ${invokeResult.FunctionError}`);
    const payload = invokeResult.Payload
      ? JSON.parse(Buffer.from(invokeResult.Payload).toString())
      : null;
    console.error("Error payload:", JSON.stringify(payload));
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }

  if (!invokeResult.Payload) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
  }

  const payload = JSON.parse(Buffer.from(invokeResult.Payload).toString());
  return {
    statusCode: payload.statusCode || 200,
    headers: payload.headers || {},
    body: payload.body || "",
  };
}

/**
 * Invoke the bootstrap function for a project (if it exists).
 * Returns { result, error } — never throws. Fork/deploy should not fail if bootstrap fails.
 */
export async function invokeBootstrap(
  projectId: string,
  serviceKey: string,
  anonKey: string,
  variables: Record<string, unknown>,
  apiBase: string,
): Promise<{ result: unknown | null; error: string | null }> {
  // Check if a bootstrap function exists
  const fnResult = await pool.query(
    `SELECT lambda_arn FROM internal.functions WHERE project_id = $1 AND name = 'bootstrap'`,
    [projectId],
  );
  if (fnResult.rows.length === 0) {
    return { result: null, error: null };
  }

  try {
    const response = await invokeFunction(
      projectId,
      "bootstrap",
      "POST",
      "/functions/v1/bootstrap",
      {
        "content-type": "application/json",
        apikey: anonKey,
        authorization: `Bearer ${serviceKey}`,
      },
      JSON.stringify(variables),
      "",
    );

    if (response.statusCode >= 200 && response.statusCode < 300) {
      try {
        return { result: JSON.parse(response.body), error: null };
      } catch {
        return { result: response.body, error: null };
      }
    } else {
      return { result: null, error: `Bootstrap function returned ${response.statusCode}: ${response.body}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timed out") || message.includes("timeout")) {
      return { result: null, error: "Bootstrap function timed out" };
    }
    return { result: null, error: `Bootstrap function failed: ${message}` };
  }
}

/**
 * List functions for a project.
 */
export async function listFunctions(projectId: string, apiBase: string): Promise<FunctionRecord[]> {
  const result = await pool.query(
    `SELECT name, lambda_arn, runtime, timeout_seconds, memory_mb, code_hash, deps, created_at, updated_at
     FROM internal.functions WHERE project_id = $1 ORDER BY name`,
    [projectId],
  );
  return result.rows.map((row) => ({
    name: row.name,
    url: `${apiBase}/functions/v1/${row.name}`,
    lambda_arn: row.lambda_arn,
    runtime: row.runtime,
    timeout: row.timeout_seconds,
    memory: row.memory_mb,
    code_hash: row.code_hash,
    deps: row.deps || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * Delete a function.
 */
export async function deleteFunction(projectId: string, name: string): Promise<void> {
  const result = await pool.query(
    `SELECT lambda_arn FROM internal.functions WHERE project_id = $1 AND name = $2`,
    [projectId, name],
  );
  if (result.rows.length === 0) {
    throw new FunctionError("Function not found", 404);
  }

  const fnName = lambdaName(projectId, name);

  if (lambda) {
    try {
      await lambda.send(new DeleteFunctionCommand({ FunctionName: fnName }));
    } catch (err: unknown) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
      // Already deleted in Lambda, continue to clean up DB
    }
  }

  await pool.query(
    `DELETE FROM internal.functions WHERE project_id = $1 AND name = $2`,
    [projectId, name],
  );

  console.log(`  Function deleted: ${fnName}`);
}

/**
 * Delete all functions for a project (cleanup on project archive).
 */
export async function deleteAllFunctions(projectId: string): Promise<void> {
  if (!lambda) return;

  const result = await pool.query(
    `SELECT name FROM internal.functions WHERE project_id = $1`,
    [projectId],
  );

  for (const row of result.rows) {
    const fnName = lambdaName(projectId, row.name);
    try {
      await lambda.send(new DeleteFunctionCommand({ FunctionName: fnName }));
    } catch {
      // Best effort cleanup
    }
  }

  await pool.query(`DELETE FROM internal.functions WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM internal.secrets WHERE project_id = $1`, [projectId]);
}

/**
 * Get function logs from CloudWatch.
 */
export async function getFunctionLogs(
  projectId: string,
  name: string,
  tail: number = 50,
): Promise<Array<{ timestamp: string; message: string }>> {
  if (!cwLogs) {
    throw new FunctionError("CloudWatch Logs not configured", 503);
  }

  // Verify function exists
  const result = await pool.query(
    `SELECT 1 FROM internal.functions WHERE project_id = $1 AND name = $2`,
    [projectId, name],
  );
  if (result.rows.length === 0) {
    throw new FunctionError("Function not found", 404);
  }

  const fnName = lambdaName(projectId, name);

  try {
    // Lambda custom LogGroup streams are named YYYY/MM/DD/<fnName>[$LATEST]<hex>,
    // so logStreamNamePrefix with just fnName won't match. Find matching streams first.
    const streams = await cwLogs.send(new DescribeLogStreamsCommand({
      logGroupName: FUNCTIONS_LOG_GROUP,
      orderBy: "LastEventTime",
      descending: true,
      limit: 50,
    }));

    const matchingStreams = (streams.logStreams || [])
      .filter((s) => s.logStreamName?.includes(fnName))
      .map((s) => s.logStreamName!);

    if (matchingStreams.length === 0) {
      return [];
    }

    const logsResult = await cwLogs.send(new FilterLogEventsCommand({
      logGroupName: FUNCTIONS_LOG_GROUP,
      logStreamNames: matchingStreams,
      limit: Math.min(tail, 200),
      interleaved: true,
    }));

    return (logsResult.events || []).map((event) => ({
      timestamp: new Date(event.timestamp || 0).toISOString(),
      message: (event.message || "").trim(),
    }));
  } catch {
    // Log group may not exist yet
    return [];
  }
}

// === Secrets ===

/**
 * Set a project secret.
 */
export async function setSecret(
  projectId: string,
  key: string,
  value: string,
  tierLimits?: { maxSecrets: number },
): Promise<void> {
  if (!key || !/^[A-Z_][A-Z0-9_]{0,62}$/.test(key)) {
    throw new FunctionError(
      "Secret key must be uppercase alphanumeric + underscores, 1-63 chars, starting with letter or underscore",
      400,
    );
  }

  // Check secrets quota
  if (tierLimits) {
    const existing = await pool.query(
      `SELECT count(*)::int AS cnt FROM internal.secrets WHERE project_id = $1`,
      [projectId],
    );
    const existingKey = await pool.query(
      `SELECT 1 FROM internal.secrets WHERE project_id = $1 AND key = $2`,
      [projectId, key],
    );
    if (existingKey.rows.length === 0 && existing.rows[0].cnt >= tierLimits.maxSecrets) {
      throw new FunctionError(
        `Secrets limit reached (${tierLimits.maxSecrets} for your tier). Delete a secret first.`,
        403,
      );
    }
  }

  // Upsert secret (value stored as plaintext — encryption at rest via Aurora)
  await pool.query(
    `INSERT INTO internal.secrets (project_id, key, value_encrypted)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET
       value_encrypted = $3,
       updated_at = now()`,
    [projectId, key, value],
  );

  // Update env vars on all project functions
  await refreshFunctionEnvVars(projectId);
}

/**
 * Delete a project secret.
 */
export async function deleteSecret(projectId: string, key: string): Promise<void> {
  const result = await pool.query(
    `DELETE FROM internal.secrets WHERE project_id = $1 AND key = $2 RETURNING key`,
    [projectId, key],
  );
  if (result.rows.length === 0) {
    throw new FunctionError("Secret not found", 404);
  }

  await refreshFunctionEnvVars(projectId);
}

/**
 * List project secrets (keys only, no values).
 */
export async function listSecrets(projectId: string): Promise<Array<{ key: string; created_at: string; updated_at: string }>> {
  const result = await pool.query(
    `SELECT key, created_at, updated_at FROM internal.secrets WHERE project_id = $1 ORDER BY key`,
    [projectId],
  );
  return result.rows;
}

/**
 * Refresh env vars on all functions after secret changes.
 */
async function refreshFunctionEnvVars(projectId: string): Promise<void> {
  if (!lambda) return;

  const functions = await pool.query(
    `SELECT name FROM internal.functions WHERE project_id = $1`,
    [projectId],
  );
  if (functions.rows.length === 0) return;

  const secrets = await pool.query(
    `SELECT key, value_encrypted FROM internal.secrets WHERE project_id = $1`,
    [projectId],
  );

  // Read existing service key from the first Lambda function's env vars
  // (service keys aren't stored in DB — they're JWTs given to the user at provision)
  const firstFnName = lambdaName(projectId, functions.rows[0].name);
  let existingServiceKey = "";
  try {
    const fnConfig = await lambda.send(new GetFunctionCommand({ FunctionName: firstFnName }));
    existingServiceKey = fnConfig.Configuration?.Environment?.Variables?.RUN402_SERVICE_KEY || "";
  } catch {
    // Best effort
  }

  const envVars: Record<string, string> = {
    RUN402_PROJECT_ID: projectId,
    RUN402_API_BASE: process.env.API_BASE || "https://api.run402.com",
    RUN402_SERVICE_KEY: existingServiceKey,
    RUN402_JWT_SECRET: JWT_SECRET,
  };
  for (const row of secrets.rows) {
    envVars[row.key] = row.value_encrypted;
  }

  for (const fn of functions.rows) {
    const fnName = lambdaName(projectId, fn.name);
    try {
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: fnName,
        Environment: { Variables: envVars },
      }));
    } catch {
      console.error(`  Failed to update env vars for ${fnName}`);
    }
  }
}

// ============================================================
// Local function execution (no Lambda)
// ============================================================

const LOCAL_FUNCTIONS_DIR = join(tmpdir(), "run402-local-functions");

/**
 * Write a local function module to disk for in-process execution.
 * The file inlines the @run402/functions helper so the user code's
 * `import { db } from '@run402/functions'` resolves without a Lambda layer.
 */
async function writeLocalFunction(
  projectId: string,
  name: string,
  userCode: string,
  serviceKey: string,
  apiBase: string,
): Promise<void> {
  const dir = join(LOCAL_FUNCTIONS_DIR, projectId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Transpile TypeScript to JavaScript, then inline the @run402/functions helper.
  const transpiled = await transpileTS(userCode);
  const stripped = transpiled
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]@run402\/functions['"]\s*;?/g, "");

  const module = `
// --- inlined @run402/functions helper ---
import { createRequire as _cr } from "node:module";
const _require = _cr(import.meta.url);
const _jwt = _require("jsonwebtoken");
const _API_BASE = ${JSON.stringify(apiBase)};
const _SERVICE_KEY = ${JSON.stringify(serviceKey)};
const _JWT_SECRET = ${JSON.stringify(JWT_SECRET)};
const _PROJECT_ID = ${JSON.stringify(projectId)};

class _QueryBuilder {
  #table; #params = new URLSearchParams(); #method = "GET"; #body = undefined;
  constructor(t) { this.#table = t; }
  select(c = "*") { this.#params.set("select", c); return this; }
  eq(c, v) { this.#params.append(c, "eq." + v); return this; }
  neq(c, v) { this.#params.append(c, "neq." + v); return this; }
  gt(c, v) { this.#params.append(c, "gt." + v); return this; }
  lt(c, v) { this.#params.append(c, "lt." + v); return this; }
  gte(c, v) { this.#params.append(c, "gte." + v); return this; }
  lte(c, v) { this.#params.append(c, "lte." + v); return this; }
  like(c, p) { this.#params.append(c, "like." + p); return this; }
  ilike(c, p) { this.#params.append(c, "ilike." + p); return this; }
  in(c, vs) { this.#params.append(c, "in.(" + vs.join(",") + ")"); return this; }
  order(c, { ascending = true } = {}) { this.#params.append("order", c + "." + (ascending ? "asc" : "desc")); return this; }
  limit(n) { this.#params.set("limit", String(n)); return this; }
  offset(n) { this.#params.set("offset", String(n)); return this; }
  insert(d) { this.#method = "POST"; this.#body = Array.isArray(d) ? d : [d]; return this; }
  update(d) { this.#method = "PATCH"; this.#body = d; return this; }
  delete() { this.#method = "DELETE"; return this; }
  async then(resolve, reject) {
    try {
      const qs = this.#params.toString();
      const url = _API_BASE + "/rest/v1/" + this.#table + (qs ? "?" + qs : "");
      const res = await fetch(url, {
        method: this.#method,
        headers: { apikey: _SERVICE_KEY, Authorization: "Bearer " + _SERVICE_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
        body: this.#body ? JSON.stringify(this.#body) : undefined,
      });
      if (!res.ok) { reject(new Error("PostgREST error (" + res.status + "): " + await res.text())); return; }
      resolve(await res.json());
    } catch (e) { reject(e); }
  }
}
const db = { from(t) { return new _QueryBuilder(t); } };

function getUser(req) {
  const authHeader = req.headers.get ? req.headers.get("authorization") : req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = _jwt.verify(token, _JWT_SECRET);
    if (payload.project_id !== _PROJECT_ID) return null;
    return { id: payload.sub, role: payload.role };
  } catch { return null; }
}

// --- user code ---
${stripped}
`;

  writeFileSync(join(dir, name + ".mjs"), module);
}

/**
 * Invoke a locally-stored function in-process.
 */
async function invokeLocalFunction(
  projectId: string,
  name: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  queryString: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const filePath = join(LOCAL_FUNCTIONS_DIR, projectId, name + ".mjs");
  if (!existsSync(filePath)) {
    throw new FunctionError("Function not found locally", 404);
  }

  // Cache-bust: append timestamp query to force re-import on redeploy
  const fileUrl = "file://" + filePath + "?t=" + Date.now();

  let userModule;
  try {
    userModule = await import(fileUrl);
  } catch (err: unknown) {
    console.error(`Local function import error (${name}):`, err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }

  const handlerFn = userModule.default || userModule.handler;
  if (typeof handlerFn !== "function") {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Function does not export a default handler" }),
    };
  }

  // Build a Web Request
  const fullUrl = "http://localhost" + path + (queryString ? "?" + queryString : "");
  const reqInit: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && body) {
    reqInit.body = body;
  }
  const request = new Request(fullUrl, reqInit);

  try {
    const response = await handlerFn(request);

    if (response instanceof Response) {
      const resBody = await response.text();
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { resHeaders[k] = v; });
      return { statusCode: response.status, headers: resHeaders, body: resBody };
    }

    if (response && typeof response === "object") {
      return {
        statusCode: response.statusCode || 200,
        headers: { "content-type": "application/json", ...(response.headers || {}) },
        body: typeof response.body === "string" ? response.body : JSON.stringify(response.body || response),
      };
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (err: unknown) {
    console.error(`Local function error (${name}):`, err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }
}

/**
 * Build a minimal zip containing index.mjs with the shim code.
 * Uses raw zip format (no external dependency needed).
 */
async function buildZip(code: string): Promise<Uint8Array> {
  const filename = "index.mjs";
  const fileData = Buffer.from(code, "utf-8");
  const fnameBytes = Buffer.from(filename, "utf-8");

  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const crc = crc32(fileData);
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  // Local file header
  const localHeader = Buffer.alloc(30 + fnameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4);   // version needed
  localHeader.writeUInt16LE(0, 6);    // flags
  localHeader.writeUInt16LE(0, 8);    // compression (stored)
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(fileData.length, 18); // compressed size
  localHeader.writeUInt32LE(fileData.length, 22); // uncompressed size
  localHeader.writeUInt16LE(fnameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length
  fnameBytes.copy(localHeader, 30);

  const centralDirOffset = localHeader.length + fileData.length;

  // Central directory header
  const centralHeader = Buffer.alloc(46 + fnameBytes.length);
  centralHeader.writeUInt32LE(0x02014b50, 0); // signature
  centralHeader.writeUInt16LE(20, 4);  // version made by
  centralHeader.writeUInt16LE(20, 6);  // version needed
  centralHeader.writeUInt16LE(0, 8);   // flags
  centralHeader.writeUInt16LE(0, 10);  // compression
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(fileData.length, 20);
  centralHeader.writeUInt32LE(fileData.length, 24);
  centralHeader.writeUInt16LE(fnameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // file comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attributes
  centralHeader.writeUInt32LE(0, 38); // external attributes
  centralHeader.writeUInt32LE(0, 42); // local header offset
  fnameBytes.copy(centralHeader, 46);

  // End of central directory
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4); // disk number
  endRecord.writeUInt16LE(0, 6); // disk with central dir
  endRecord.writeUInt16LE(1, 8); // entries on disk
  endRecord.writeUInt16LE(1, 10); // total entries
  endRecord.writeUInt32LE(centralHeader.length, 12); // central dir size
  endRecord.writeUInt32LE(centralDirOffset, 16); // central dir offset
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localHeader, fileData, centralHeader, endRecord]);
}
