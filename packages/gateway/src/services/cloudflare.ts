/**
 * Cloudflare API client — Custom Hostnames + Workers KV + Worker Custom Domains.
 *
 * Used by the domains service to manage custom domain SSL/verification
 * (Custom Hostnames), edge routing (KV), and Worker bindings (Custom Domains).
 *
 * Fire-and-forget pattern: KV and Worker Custom Domain mutations log errors
 * but don't throw, matching the existing kvs.ts pattern for CloudFront KVS.
 */

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "";
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const CLOUDFLARE_KV_ACCOUNT_ID = process.env.CLOUDFLARE_KV_ACCOUNT_ID || "";
const CLOUDFLARE_WORKER_NAME = process.env.CLOUDFLARE_WORKER_NAME || "run402-custom-domains";

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

// ---------- Worker Custom Domains ----------

/**
 * Extract the base domain (last two labels) from a hostname.
 * e.g., "barrio.wildlychee.com" → "wildlychee.com"
 */
function baseDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.slice(-2).join(".");
}

/**
 * Resolve the Cloudflare zone_id for a hostname's base domain.
 * Returns null if the zone is not on this Cloudflare account.
 */
export async function cfZoneResolve(hostname: string): Promise<string | null> {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_KV_ACCOUNT_ID) return null;

  const base = baseDomain(hostname);
  try {
    const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(base)}`, {
      headers: headers(),
    });
    const body = (await res.json()) as CfResponse<Array<{ id: string }>>;
    if (!body.success || body.result.length === 0) return null;
    return body.result[0].id;
  } catch (err) {
    console.error(
      `CF zone resolve failed (${hostname} → ${base}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Create a Worker Custom Domain binding for a hostname.
 * Worker Custom Domains manage their own DNS, so any existing DNS record
 * (e.g., a user-created CNAME) must be deleted first.
 * Fire-and-forget: logs errors but does not throw.
 */
export function cfWorkerCustomDomainCreate(hostname: string, zoneId: string): void {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_KV_ACCOUNT_ID) return;

  // Delete any conflicting DNS record first, then create the binding
  deleteConflictingDnsRecord(hostname, zoneId).then(() => {
    return fetch(`${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/workers/domains`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        hostname,
        service: CLOUDFLARE_WORKER_NAME,
        zone_id: zoneId,
        environment: "production",
      }),
    });
  }).then((res) => {
    if (!res.ok) {
      res.text().then((t) => {
        console.error(`CF Worker Custom Domain create failed (${hostname}): HTTP ${res.status} — ${t}`);
      });
    } else {
      console.log(`  CF Worker Custom Domain created: ${hostname} → ${CLOUDFLARE_WORKER_NAME}`);
    }
  }).catch((err) => {
    console.error(
      `CF Worker Custom Domain create failed (${hostname}):`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Delete an existing DNS record (CNAME/A) for a hostname on a zone.
 * Worker Custom Domains manage their own DNS, so user-created records conflict.
 */
async function deleteConflictingDnsRecord(hostname: string, zoneId: string): Promise<void> {
  try {
    const res = await fetch(
      `${CF_API}/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME,A,AAAA`,
      { headers: headers() },
    );
    const body = (await res.json()) as CfResponse<Array<{ id: string; type: string }>>;
    if (!body.success || body.result.length === 0) return;

    for (const record of body.result) {
      const delRes = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${record.id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (delRes.ok) {
        console.log(`  CF DNS record deleted (${hostname}, ${record.type}) — replaced by Worker Custom Domain`);
      }
    }
  } catch (err) {
    console.error(
      `CF DNS record cleanup failed (${hostname}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Delete a Worker Custom Domain binding for a hostname.
 * Fire-and-forget: logs errors but does not throw.
 */
export function cfWorkerCustomDomainDelete(hostname: string): void {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_KV_ACCOUNT_ID) return;

  fetch(
    `${CF_API}/accounts/${CLOUDFLARE_KV_ACCOUNT_ID}/workers/domains/records/${encodeURIComponent(hostname)}`,
    {
      method: "DELETE",
      headers: headers(),
    },
  ).then((res) => {
    if (!res.ok) {
      console.error(`CF Worker Custom Domain delete failed (${hostname}): HTTP ${res.status}`);
    } else {
      console.log(`  CF Worker Custom Domain deleted: ${hostname}`);
    }
  }).catch((err) => {
    console.error(
      `CF Worker Custom Domain delete failed (${hostname}):`,
      err instanceof Error ? err.message : err,
    );
  });
}
