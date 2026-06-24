#!/usr/bin/env node
/*
 * Exchange the GitHub Actions OIDC token for a Run402 CI session
 * (internal-apps-cicd → internal-apps-deploy).
 *
 *   node apps/_deploy/exchange-oidc.mjs <app-name>
 *
 * Reads the app's `project_id` from apps/<name>/app.json, requests a GitHub OIDC
 * token with audience = the Run402 CI audience, POSTs it to
 * `/ci/v1/token-exchange`, and writes the resulting short-lived CI-session
 * bearer to $GITHUB_ENV as RUN402_CI_SESSION (masked). The wallet that signed
 * the binding never touches CI — this is the entire credential.
 *
 * Requires `permissions: id-token: write` on the job.
 */

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.mjs";

const RUN402_CI_AUDIENCE = "https://api.run402.com"; // == gateway CI_AUDIENCE

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const name = process.argv[2];
if (!name) die("usage: node apps/_deploy/exchange-oidc.mjs <app-name>");

const baseUrl = process.env.BASE_URL || "https://api.run402.com";
const appsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = loadRegistry(appsDir).find((e) => e.name === name);
if (!entry || !entry.valid) die(`no valid registered app '${name}' (apps/**/app.json)`);
const config = entry.config;
if (!config.project_id || String(config.project_id).startsWith("<")) {
  die(`${name} is not provisioned (no project_id) — cannot exchange a CI session.`);
}

// 1. GitHub OIDC token for the Run402 audience.
const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!reqUrl || !reqToken) {
  die("No OIDC request env (ACTIONS_ID_TOKEN_REQUEST_*) — is `permissions: id-token: write` set on the job?");
}
const oidcRes = await fetch(`${reqUrl}&audience=${encodeURIComponent(RUN402_CI_AUDIENCE)}`, {
  headers: { Authorization: `Bearer ${reqToken}` },
});
if (!oidcRes.ok) die(`GitHub OIDC token request failed: ${oidcRes.status} ${(await oidcRes.text()).slice(0, 300)}`);
const oidcToken = (await oidcRes.json()).value;
if (!oidcToken) die("GitHub OIDC response had no token value.");

// 2. Exchange it for a Run402 CI session (RFC 8693-shaped; no auth header — the
//    OIDC JWT is the sole authentication).
const xchgRes = await fetch(`${baseUrl}/ci/v1/token-exchange`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: oidcToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    project_id: config.project_id,
  }),
});
if (!xchgRes.ok) {
  die(`/ci/v1/token-exchange failed: ${xchgRes.status} ${(await xchgRes.text()).slice(0, 400)}\n` +
    `(Is the CI binding for ${config.project_id} active, and does this run's OIDC subject match it?)`);
}
const { access_token, expires_in } = await xchgRes.json();
if (!access_token) die("token-exchange returned no access_token.");

// 3. Mask + export for subsequent steps.
console.log(`::add-mask::${access_token}`);
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `RUN402_CI_SESSION=${access_token}\n`);
}
console.error(`exchanged Run402 CI session for ${name} (project ${config.project_id}, expires_in ${expires_in}s).`);
