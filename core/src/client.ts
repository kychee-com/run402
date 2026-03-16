import { getApiBase } from "./config.js";

export interface ApiResponse {
  ok: boolean;
  is402?: boolean;
  status: number;
  body: unknown;
}

export interface ApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send body as raw string (e.g. for text/plain SQL) */
  rawBody?: string;
}

export async function apiRequest(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<ApiResponse> {
  const { method = "GET", headers = {}, body, rawBody } = opts;
  const url = `${getApiBase()}${path}`;

  const fetchHeaders: Record<string, string> = { ...headers };
  let fetchBody: string | undefined;

  if (rawBody !== undefined) {
    fetchBody = rawBody;
  } else if (body !== undefined) {
    fetchHeaders["Content-Type"] = fetchHeaders["Content-Type"] || "application/json";
    fetchBody = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: fetchBody,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: `Network error: ${(err as Error).message}` },
    };
  }

  let resBody: unknown;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    resBody = await res.json();
  } else {
    resBody = await res.text();
  }

  if (res.status === 402) {
    return { ok: false, is402: true, status: 402, body: resBody };
  }

  return { ok: res.ok, status: res.status, body: resBody };
}
