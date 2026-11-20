/*
 * Shared deploy engine for on-platform internal apps
 * (internal-apps-cicd → internal-apps-deploy).
 *
 * Drives the CAS upload (`/content/v1`) + unified apply (`/apply/v1`) flow for a
 * DEPLOY-ONLY ReleaseSpec (site / functions / database / routes — never
 * `subdomains` or `secrets`, which are provisioning-time only and forbidden to
 * CI sessions). Auth-agnostic: works under a wallet SIWX identity (local /
 * provisioning) OR an exchanged Run402 CI-session bearer (CI), so the SAME code
 * path runs in both. No dependency on the gateway source tree (apps/ boundary).
 *
 *   auth = { mode: "ci",     token }                         // CI-session bearer
 *        | { mode: "wallet", serviceKey, siwxHeaders }       // local / provision
 *
 * `siwxHeaders(path)` is an async fn returning the SIGN-IN-WITH-X header for the
 * given request path (wallet mode only). `serviceKey` authorizes the content
 * upload in wallet mode (apikey). In CI mode the bearer authorizes BOTH content
 * (`apikeyOrCiSession`) and apply (`walletAuthOrCiSession`).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read an app's STATIC site files for a generic static deploy. Prefers a
 * `public/` subdir (the console convention — clean, deploy-only) and reads ALL
 * its files; otherwise reads the app dir's top level minus dotfiles, deploy/
 * provision scripts (`*.ts`), config (`*.json`), DB schema (`*.sql`), and
 * function source (`function.*`). Lets a pure-static app deploy with only an
 * app.json — no bespoke deploy.ts.
 */
export function readStaticDir(dir) {
  const publicDir = join(dir, "public");
  if (existsSync(publicDir) && statSync(publicDir).isDirectory()) {
    return readdirSync(publicDir)
      .filter((n) => !n.startsWith("."))
      .map((n) => ({ file: n, data: readFileSync(join(publicDir, n), "utf-8") }));
  }
  return readdirSync(dir)
    .filter(
      (n) =>
        !n.startsWith(".") &&
        !n.endsWith(".ts") &&
        !n.endsWith(".json") &&
        !n.endsWith(".sql") &&
        !n.startsWith("function."),
    )
    .map((n) => ({ file: n, data: readFileSync(join(dir, n), "utf-8") }));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(s) {
  const bytes = new TextEncoder().encode(s);
  return { bytes, size: bytes.byteLength, sha256: sha256Hex(bytes) };
}

function contentTypeFor(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Headers for the content (CAS) endpoints, per auth mode. */
function contentHeaders(auth) {
  return auth.mode === "ci"
    ? { Authorization: `Bearer ${auth.token}` }
    : { apikey: auth.serviceKey };
}

/** Headers for the apply endpoints, per auth mode. */
async function applyHeaders(auth, path) {
  return auth.mode === "ci"
    ? { Authorization: `Bearer ${auth.token}` }
    : await auth.siwxHeaders(path);
}

/** Upload any missing CAS objects for the given content refs. */
async function uploadCas(baseUrl, auth, pending) {
  if (pending.length === 0) return;
  const byHash = new Map();
  for (const p of pending) byHash.set(p.sha256, p);
  const refs = [...byHash.values()].map((p) => ({ sha256: p.sha256, size: p.size, content_type: p.contentType }));

  const planRes = await fetch(`${baseUrl}/content/v1/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...contentHeaders(auth) },
    body: JSON.stringify({ content: refs }),
  });
  if (!planRes.ok) {
    throw new Error(`POST /content/v1/plans failed: ${planRes.status} ${(await planRes.text()).slice(0, 500)}`);
  }
  const plan = await planRes.json();

  for (const m of plan.missing ?? []) {
    const src = byHash.get(m.sha256);
    if (!src) throw new Error(`/content/v1/plans returned an undeclared missing sha ${m.sha256}`);
    if (m.mode !== "single" || m.parts.length !== 1) {
      throw new Error(`multipart upload unsupported here (sha ${m.sha256.slice(0, 12)}); internal app files should be < 5 MiB`);
    }
    const putRes = await fetch(m.parts[0].url, {
      method: "PUT",
      headers: { "Content-Type": src.contentType ?? "application/octet-stream", "Content-Length": String(src.size) },
      body: Buffer.from(src.bytes),
    });
    if (!putRes.ok) {
      throw new Error(`PUT presigned (${m.sha256.slice(0, 12)}) failed: ${putRes.status} ${(await putRes.text()).slice(0, 300)}`);
    }
  }

  const commitRes = await fetch(`${baseUrl}/content/v1/plans/${plan.plan_id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...contentHeaders(auth) },
    body: JSON.stringify({}),
  });
  if (!commitRes.ok) {
    throw new Error(`POST /content/v1/plans/${plan.plan_id}/commit failed: ${commitRes.status} ${(await commitRes.text()).slice(0, 500)}`);
  }
}

/**
 * Build a deploy-only ReleaseSpec + collect the bytes that need CAS upload.
 * @param {{project_id: string, files?: Array<{file,data}>, functions?: Array<{name,code,entrypoint?}>, migrations?: string, expose?: unknown, routes?: Array<{pattern,functionName}>}} body
 */
export function buildDeploySpec(body) {
  const pending = [];
  const spec = { project: body.project_id };

  if (body.files?.length) {
    const fileRefs = {};
    for (const f of body.files) {
      const u = utf8(f.data);
      const ct = contentTypeFor(f.file);
      fileRefs[f.file] = { sha256: u.sha256, size: u.size, contentType: ct };
      pending.push({ sha256: u.sha256, size: u.size, contentType: ct, bytes: u.bytes });
    }
    spec.site = { replace: fileRefs };
  }

  if (body.functions?.length) {
    const fnSpecs = {};
    for (const fn of body.functions) {
      const u = utf8(fn.code);
      const ct = "text/javascript; charset=utf-8";
      fnSpecs[fn.name] = { runtime: "node22", entrypoint: fn.entrypoint, source: { sha256: u.sha256, size: u.size, contentType: ct } };
      pending.push({ sha256: u.sha256, size: u.size, contentType: ct, bytes: u.bytes });
    }
    spec.functions = { replace: fnSpecs };
  }

  if (typeof body.migrations === "string" && body.migrations.length > 0) {
    const u = utf8(body.migrations);
    spec.database = {
      migrations: [{ id: `app_${u.sha256.slice(0, 16)}`, checksum: u.sha256, sql: body.migrations }],
      ...(body.expose !== undefined ? { expose: body.expose } : {}),
    };
  } else if (body.expose !== undefined) {
    spec.database = { expose: body.expose };
  }

  if (body.routes?.length) {
    spec.routes = { replace: body.routes.map((r) => ({ pattern: r.pattern, target: { type: "function", name: r.functionName } })) };
  }

  return { spec, pending };
}

/**
 * Drive the full deploy: CAS upload → /apply/v1 plan → commit → poll until
 * terminal. Returns `{ operation_id, release_id, status, urls }`.
 */
export async function applyRelease({ baseUrl, auth, body, operationTimeoutMs = 90_000 }) {
  const { spec, pending } = buildDeploySpec(body);

  await uploadCas(baseUrl, auth, pending);

  const planRes = await fetch(`${baseUrl}/apply/v1/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await applyHeaders(auth, "/apply/v1/plans")) },
    body: JSON.stringify({ spec }),
  });
  if (!planRes.ok) {
    throw new Error(`POST /apply/v1/plans failed: ${planRes.status} ${(await planRes.text()).slice(0, 800)}`);
  }
  const planBody = await planRes.json();
  const stillMissing = (planBody.missing_content ?? []).filter((m) => !m.present);
  if (stillMissing.length > 0) {
    throw new Error(`/apply/v1/plans reports missing content after upload: ${stillMissing.map((m) => m.sha256.slice(0, 12)).join(", ")}`);
  }

  const commitPath = `/apply/v1/plans/${planBody.plan_id}/commit`;
  const commitRes = await fetch(`${baseUrl}${commitPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await applyHeaders(auth, commitPath)) },
    body: JSON.stringify({}),
  });
  if (!commitRes.ok && commitRes.status !== 422) {
    throw new Error(`POST ${commitPath} failed: ${commitRes.status} ${(await commitRes.text()).slice(0, 800)}`);
  }
  const commitBody = await commitRes.json();

  const TERMINAL = new Set(["ready", "failed", "rolled_back"]);
  let status = commitBody.status;
  let snapshot = { status, error: commitBody.error ?? null, target_release_id: commitBody.release_id ?? null };
  const startedAt = nowMs();
  while (!TERMINAL.has(status)) {
    if (nowMs() - startedAt > operationTimeoutMs) {
      throw new Error(`operation ${commitBody.operation_id} did not reach a terminal state in ${operationTimeoutMs}ms (last: ${status})`);
    }
    await sleep(750);
    const opRes = await fetch(`${baseUrl}/apply/v1/operations/${commitBody.operation_id}`, {
      headers: { ...(await applyHeaders(auth, `/apply/v1/operations/${commitBody.operation_id}`)) },
    });
    if (!opRes.ok) {
      throw new Error(`GET /apply/v1/operations/${commitBody.operation_id} failed: ${opRes.status} ${(await opRes.text()).slice(0, 400)}`);
    }
    snapshot = await opRes.json();
    status = snapshot.status;
  }
  if (status !== "ready") {
    throw new Error(`deploy operation ${commitBody.operation_id} ended status=${status}: ${JSON.stringify(snapshot.error)}`);
  }

  return {
    operation_id: commitBody.operation_id,
    release_id: snapshot.target_release_id ?? commitBody.release_id ?? null,
    status,
    urls: commitBody.urls ?? {},
  };
}

/**
 * Smoke-test a freshly-deployed URL: GET it and assert HTTP 200 (plus an
 * optional content marker, so "deployed" means "the new bytes are serving").
 * Retries a few times for CDN/edge propagation. Returns `{ ok, status, reason? }`.
 */
export async function smokeTest({ url, marker, timeoutMs = 20_000, attempts = 5 }) {
  let last = { ok: false, status: 0, reason: "no-attempt" };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      if (res.status === 200 && (!marker || body.includes(marker))) {
        return { ok: true, status: 200, reason: "ok" };
      }
      last = { ok: false, status: res.status, reason: marker && !body.includes(marker) ? "marker-missing" : `status-${res.status}` };
    } catch (err) {
      last = { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    if (i < attempts - 1) await sleep(2000);
  }
  return last;
}

// Small awaitable sleep + monotonic clock (kept local so apply.mjs stays
// dependency-free).
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
