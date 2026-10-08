/*
 * Demos deploy registry (kychee-com/run402 → demos keyless CI/CD).
 *
 * The durable, CHECKED-IN, NON-SECRET map of `demo → run402 deploy target`. One
 * `demos/<name>/app.json` per example app. `project_id` is public; `binding_id`
 * is a revocable handle (useless without the GitHub OIDC token); `oidc_subject`
 * / `github_repository_id` are public. The only secret — the deploy wallet key —
 * never lives here and is never used by CI (CI is keyless: it exchanges the
 * GitHub OIDC token for a short-lived run402 CI session).
 *
 * FLAT: scans `demos/<name>/` (one level). Pure, dependency-free, unit-tested.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/** Tiers a demo can hold. */
export const APP_TIERS = ["system", "demo"];

/** Keys that must NEVER appear in a checked-in app.json (no-secret invariant). */
const FORBIDDEN_SECRET_KEY_PATTERNS = ["service_key", "private_key", "secret", "token", "apikey", "password"];

function isUnset(v) {
  return v === null || v === undefined || v === "" || (typeof v === "string" && v.startsWith("<"));
}

/**
 * Validate one demo config. Returns `{ ok, errors }`. Structural only —
 * operator fields (project_id / binding_id / …) MAY be unset (a demo can be
 * registered before provisioning); use `isProvisioned()` to gate a deploy.
 */
export function validateAppConfig(config, expectedName) {
  const errors = [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { ok: false, errors: ["app.json must be a JSON object"] };
  }
  for (const key of Object.keys(config)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_SECRET_KEY_PATTERNS.some((p) => lower.includes(p))) {
      errors.push(`forbidden secret-bearing key '${key}' — secrets never live in app.json`);
    }
  }
  if (config.name !== expectedName) {
    errors.push(`name '${String(config.name)}' must equal the directory name '${expectedName}'`);
  }
  if (typeof config.subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.subdomain)) {
    errors.push(`subdomain must be a valid DNS label (got ${JSON.stringify(config.subdomain)})`);
  }
  if (!APP_TIERS.includes(config.tier)) {
    errors.push(`tier must be one of ${APP_TIERS.join(" | ")} (got ${JSON.stringify(config.tier)})`);
  }
  if (typeof config.is_system !== "boolean") {
    errors.push("is_system must be a boolean");
  }
  if (config.tier === "system" && config.is_system !== true) {
    errors.push("tier 'system' requires is_system: true");
  }
  if (config.gate !== null && config.gate !== undefined && typeof config.gate !== "string") {
    errors.push("gate must be a shell-command string or null");
  }
  if (config.cd !== undefined && typeof config.cd !== "boolean") {
    errors.push("cd must be a boolean when present (default true)");
  }
  if (!isUnset(config.project_id) && (typeof config.project_id !== "string" || !config.project_id.startsWith("prj_"))) {
    errors.push(`project_id must be a 'prj_…' string when set (got ${JSON.stringify(config.project_id)})`);
  }
  if (!isUnset(config.binding_id) && (typeof config.binding_id !== "string" || !config.binding_id.startsWith("bnd_"))) {
    errors.push(`binding_id must be a 'bnd_…' string when set (got ${JSON.stringify(config.binding_id)})`);
  }
  if (!isUnset(config.owner_wallet) && (typeof config.owner_wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(config.owner_wallet))) {
    errors.push("owner_wallet must be a 0x EVM address when set");
  }
  if (!isUnset(config.oidc_subject) && (typeof config.oidc_subject !== "string" || !config.oidc_subject.startsWith("repo:"))) {
    errors.push("oidc_subject must be a 'repo:<owner>/<repo>:…' string when set");
  }
  return { ok: errors.length === 0, errors };
}

/** A demo is deployable only once provisioning has filled the project_id. */
export function isProvisioned(config) {
  return !isUnset(config.project_id);
}

/**
 * Load every `demos/<name>/app.json` under `demosDir`. Returns an array of
 * `{ name, dir, relDir, path, config, valid, errors }` (relDir is repo-relative,
 * e.g. "demos/test-video"). Dirs without an app.json, dotdirs, and `_`-prefixed
 * dirs (e.g. `_deploy`) are skipped.
 */
export function loadRegistry(demosDir) {
  const prefix = basename(demosDir);
  const out = [];
  for (const name of readdirSync(demosDir)) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const dir = join(demosDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const path = join(dir, "app.json");
    if (!existsSync(path)) continue;
    let config = null;
    let parseError = null;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    const { ok, errors } = config
      ? validateAppConfig(config, name)
      : { ok: false, errors: [`invalid JSON: ${parseError}`] };
    out.push({ name, dir, relDir: `${prefix}/${name}`, path, config, valid: ok, errors });
  }
  return out;
}
