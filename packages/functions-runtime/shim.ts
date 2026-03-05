/**
 * Lambda handler shim — wraps user code in a Lambda-compatible handler.
 *
 * This file is bundled into the Lambda layer. It:
 * 1. Imports user code (the user's index.mjs in the function zip)
 * 2. Converts Lambda event → Web Request object
 * 3. Calls user's default export
 * 4. Converts Web Response → Lambda response
 * 5. On error: logs full stack to CloudWatch, returns sanitized error to caller
 *
 * Note: In the current implementation, the shim code is inlined into the
 * function zip (see buildShimCode in functions.ts). This file serves as
 * the reference implementation and is used when building the Lambda layer.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LambdaEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LambdaContext = any;

interface LambdaResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: LambdaEvent, _context: LambdaContext): Promise<LambdaResult> {
  // Dynamic import of user code (deployed alongside this shim)
  let userModule: { default?: (req: Request) => Promise<Response>; handler?: (req: Request) => Promise<Response> };
  try {
    userModule = await import("./user-code.js");
  } catch (importErr) {
    console.error("Failed to import user code:", importErr);
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
  const fullUrl = `https://localhost${path}${queryString ? "?" + queryString : ""}`;
  const headers = event.headers || {};
  const bodyStr = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf-8")
    : (event.body || "");

  const reqInit: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && bodyStr) {
    reqInit.body = bodyStr;
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

    // Handle plain object return
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    };
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Function error:", error.stack || error.message || err);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal function error" }),
    };
  }
}
