/**
 * Cloudflare API client — Custom Hostnames + Workers KV.
 *
 * Used by the domains service to manage custom domain SSL/verification
 * (Custom Hostnames) and edge routing (KV).
 *
 * Fire-and-forget pattern: KV mutations log errors but don't throw,
 * matching the existing kvs.ts pattern for CloudFront KVS.
 */

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "";
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const CLOUDFLARE_KV_ACCOUNT_ID = process.env.CLOUDFLARE_KV_ACCOUNT_ID || "";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function isConfigured(): boolean {
  return !!(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ZONE_ID);
}

function isKvConfigured(): boolean {
  return !!(CLOUDFLARE_API_TOKEN && CLOUDFLARE_KV_NAMESPACE_ID && CLOUDFLARE_KV_ACCOUNT_ID);
}

// ---------- Custom Hostnames ----------

export interface CfCustomHostnameResult {
  id: string;
  dns_instructions: {
    cname_target: string;
    txt_name?: string;
    txt_value?: string;
  };
}

export interface CfCustomHostnameStatus {
  id: string;
  status: string; // "pending" | "active" | "moved" | "deleted"
}

/**
 * Register a custom hostname with Cloudflare for SaaS.
 * Returns the hostname ID and DNS instructions.
 */
export async function cfCustomHostnameCreate(
  hostname: string,
): Promise<CfCustomHostnameResult | null> {
  if (!isConfigured()) return null;

  const res = await fetch(`${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/custom_hostnames`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      hostname,
      ssl: {
        method: "http",
        type: "dv",
        settings: {
          min_tls_version: "1.2",
        },
      },
    }),
  });

  const body = (await res.json()) as CfResponse<{
    id: string;
    ownership_verification?: { name: string; value: string };
    ssl?: { cname_target?: string; txt_name?: string; txt_value?: string };
  }>;

  if (!body.success) {
    throw new Error(`Cloudflare custom hostname create failed: ${body.errors.map((e) => e.message).join(", ")}`);
  }

  const result = body.result;

  return {
    id: result.id,
    dns_instructions: {
      cname_target: "domains.run402.com",
      txt_name: result.ownership_verification?.name,
      txt_value: result.ownership_verification?.value,
    },
  };
}

/**
 * Get the current status of a custom hostname.
 */
export async function cfCustomHostnameGet(
  hostnameId: string,
): Promise<CfCustomHostnameStatus | null> {
  if (!isConfigured()) return null;

  const res = await fetch(`${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/custom_hostnames/${hostnameId}`, {
    headers: headers(),
  });

  const body = (await res.json()) as CfResponse<{ id: string; status: string }>;

  if (!body.success) {
    throw new Error(`Cloudflare custom hostname get failed: ${body.errors.map((e) => e.message).join(", ")}`);
  }

  return {
    id: body.result.id,
    status: body.result.status,
  };
}

/**
 * Delete a custom hostname from Cloudflare.
 */
export async function cfCustomHostnameDelete(hostnameId: string): Promise<void> {
  if (!isConfigured()) return;

  const res = await fetch(`${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/custom_hostnames/${hostnameId}`, {
    method: "DELETE",
    headers: headers(),
  });

  const body = (await res.json()) as CfResponse<unknown>;

  if (!body.success) {
    throw new Error(`Cloudflare custom hostname delete failed: ${body.errors.map((e) => e.message).join(", ")}`);
  }
}

// ---------- Workers KV ----------

/**
 * Put a domain → deployment_id mapping in Cloudflare KV.
 * Fire-and-forget: logs errors but does not throw.
 */
export function cfKvPut(key: string, value: string): void {
  if (!isKvConfigured()) return;

  fetch(
    `${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      body: value,
    },
  ).then((res) => {
    if (!res.ok) {
      console.error(`CF KV put failed (${key} → ${value}): HTTP ${res.status}`);
    } else {
      console.log(`  CF KV put: ${key} → ${value}`);
    }
  }).catch((err) => {
    console.error(`CF KV put failed (${key} → ${value}):`, err instanceof Error ? err.message : err);
  });
}

/**
 * Delete a key from Cloudflare KV.
 * Fire-and-forget: logs errors but does not throw.
 */
export function cfKvDelete(key: string): void {
  if (!isKvConfigured()) return;

  fetch(
    `${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
    {
      method: "DELETE",
      headers: headers(),
    },
  ).then((res) => {
    if (!res.ok) {
      console.error(`CF KV delete failed (${key}): HTTP ${res.status}`);
    }
  }).catch((err) => {
    console.error(`CF KV delete failed (${key}):`, err instanceof Error ? err.message : err);
  });
}

/**
 * List all keys in the Cloudflare KV namespace.
 * Used for reconciliation.
 */
export async function cfKvList(): Promise<Array<{ key: string; value: string }>> {
  if (!isKvConfigured()) return [];

  const entries: Array<{ key: string; value: string }> = [];
  let cursor: string | undefined;

  do {
    const url = new URL(
      `${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys`,
    );
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), { headers: headers() });
    const body = (await res.json()) as CfResponse<Array<{ name: string }>> & {
      result_info?: { cursor?: string };
    };

    if (!body.success) {
      throw new Error(`CF KV list failed: ${body.errors.map((e) => e.message).join(", ")}`);
    }

    // Fetch each value individually (KV list only returns keys)
    for (const item of body.result) {
      const valRes = await fetch(
        `${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(item.name)}`,
        { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } },
      );
      if (valRes.ok) {
        entries.push({ key: item.name, value: await valRes.text() });
      }
    }

    cursor = body.result_info?.cursor;
  } while (cursor);

  return entries;
}
