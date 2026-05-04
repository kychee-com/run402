/** CI/OIDC federation namespace and canonical delegation helpers. */

import type { Client } from "../kernel.js";
import { LocalError, Run402DeployError } from "../errors.js";
import type { PlanRequest, ReleaseSpec } from "./deploy.types.js";
import type {
  CiBindingRow,
  CiCreateBindingInput,
  CiDelegationValues,
  CiListBindingsInput,
  CiListBindingsResult,
  CiTokenExchangeInput,
  CiTokenExchangeRequestBody,
  CiTokenExchangeResponse,
  NormalizedCiDelegationValues,
} from "./ci.types.js";
import {
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
} from "./ci.types.js";

export {
  CI_AUDIENCE,
  CI_GITHUB_ACTIONS_ISSUER,
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
} from "./ci.types.js";

const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
const TOKEN_EXCHANGE_SUBJECT_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:jwt" as const;
const MAX_SUBJECT_MATCH_CHARS = 256;
const MAX_RESOURCE_URI_BYTES = 4096;
const MAX_STATEMENT_BYTES = 8192;
const NONCE_RE = /^[0-9a-f]{16,64}$/;
const CI_DEPLOY_SPEC_ALLOWED_KEYS = new Set([
  "project",
  "database",
  "functions",
  "site",
  "base",
]);

export class Ci {
  constructor(private readonly client: Client) {}

  async createBinding(input: CiCreateBindingInput): Promise<CiBindingRow> {
    if (input?.provider !== CI_GITHUB_ACTIONS_PROVIDER) {
      throw new LocalError(
        'ci.createBinding provider must be "github-actions" in v1',
        "creating CI binding",
      );
    }
    if (!input.signed_delegation) {
      throw new LocalError(
        "ci.createBinding requires signed_delegation",
        "creating CI binding",
      );
    }
    const values = normalizeCiDelegationValues(input);
    return this.client.request<CiBindingRow>("/ci/v1/bindings", {
      method: "POST",
      body: {
        project_id: values.project_id,
        provider: input.provider,
        subject_match: values.subject_match,
        allowed_actions: values.allowed_actions,
        allowed_events: values.allowed_events,
        github_repository_id: values.github_repository_id,
        expires_at: values.expires_at,
        nonce: values.nonce,
        signed_delegation: input.signed_delegation,
      },
      context: "creating CI binding",
    });
  }

  async listBindings(input: CiListBindingsInput): Promise<CiListBindingsResult> {
    if (!input?.project) {
      throw new LocalError(
        "ci.listBindings requires { project }",
        "listing CI bindings",
      );
    }
    const qs = new URLSearchParams({ project: input.project });
    return this.client.request<CiListBindingsResult>(
      `/ci/v1/bindings?${qs.toString()}`,
      { context: "listing CI bindings" },
    );
  }

  async getBinding(bindingId: string): Promise<CiBindingRow> {
    if (!bindingId) {
      throw new LocalError("ci.getBinding requires a binding id", "getting CI binding");
    }
    return this.client.request<CiBindingRow>(
      `/ci/v1/bindings/${encodeURIComponent(bindingId)}`,
      { context: "getting CI binding" },
    );
  }

  async revokeBinding(bindingId: string): Promise<CiBindingRow> {
    if (!bindingId) {
      throw new LocalError("ci.revokeBinding requires a binding id", "revoking CI binding");
    }
    return this.client.request<CiBindingRow>(
      `/ci/v1/bindings/${encodeURIComponent(bindingId)}/revoke`,
      { method: "POST", context: "revoking CI binding" },
    );
  }

  async exchangeToken(input: CiTokenExchangeInput): Promise<CiTokenExchangeResponse> {
    if (!input?.project_id || !input.subject_token) {
      throw new LocalError(
        "ci.exchangeToken requires { project_id, subject_token }",
        "exchanging CI OIDC token",
      );
    }
    const body: CiTokenExchangeRequestBody = {
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: input.subject_token,
      subject_token_type: TOKEN_EXCHANGE_SUBJECT_TOKEN_TYPE,
      project_id: input.project_id,
    };
    return this.client.request<CiTokenExchangeResponse>("/ci/v1/token-exchange", {
      method: "POST",
      body,
      withAuth: false,
      context: "exchanging CI OIDC token",
    });
  }
}

export function normalizeCiDelegationValues(
  values: CiDelegationValues,
): NormalizedCiDelegationValues {
  if (!values || typeof values !== "object") {
    throw new LocalError("CI delegation values must be an object", "validating CI delegation");
  }
  if (!values.project_id) {
    throw new LocalError("CI delegation project_id is required", "validating CI delegation");
  }
  const subject_match = validateCiSubjectMatch(values.subject_match);
  const nonce = validateCiNonce(values.nonce);
  const allowed_actions = normalizeAllowedActions(values.allowed_actions);
  const allowed_events = normalizeAllowedList(values.allowed_events, "allowed_events");
  if (allowed_events.length === 0) {
    throw new LocalError(
      "CI delegation allowed_events must contain at least one event",
      "validating CI delegation",
    );
  }
  return {
    project_id: values.project_id,
    issuer: values.issuer ?? CI_GITHUB_ACTIONS_ISSUER,
    audience: values.audience ?? CI_AUDIENCE,
    subject_match,
    allowed_actions,
    allowed_events,
    expires_at: values.expires_at ?? null,
    github_repository_id: values.github_repository_id ?? null,
    nonce,
  };
}

export function buildCiDelegationStatement(values: CiDelegationValues): string {
  const v = normalizeCiDelegationValues(values);
  const statement = [
    `Authorize GitHub Actions workflows whose OIDC subject matches ${v.subject_match} to deploy to run402 project ${v.project_id}.`,
    "",
    "The workflows can:",
    "  - deploy function code that runs with this project's runtime authority, including the project's service-role key, the adminDb() bypass-RLS surface, and configured runtime secrets read via process.env;",
    "  - deploy database migrations, RLS/expose changes, and schema-altering SQL via spec.database.",
    "",
    "The workflows cannot directly call secrets, domain, subdomain, lifecycle, billing, contracts, or faucet endpoints. They cannot ship spec.secrets, spec.subdomains, spec.routes, spec.checks, or non-current spec.base.",
    "",
    `Audience: ${v.audience}`,
    `Allowed events: ${v.allowed_events.join(",")}`,
    `Repository ID: ${v.github_repository_id ?? "none-soft-bound"}`,
    `Expires: ${v.expires_at ?? "never"}`,
    `Nonce: ${v.nonce}`,
    "",
    "Revoke at any time via the run402 CLI or POST /ci/v1/bindings/:id/revoke. Revocation stops future CI gateway requests but does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions. Recovery from a compromise: revoke the binding, then SIWE-deploy a known-good release that overwrites the malicious code, and rotate any service-role key the deployed code may have read.",
  ].join("\n");

  if (new TextEncoder().encode(statement).byteLength > MAX_STATEMENT_BYTES) {
    throw new LocalError(
      `CI delegation Statement exceeds ${MAX_STATEMENT_BYTES} bytes`,
      "building CI delegation statement",
    );
  }
  return statement;
}

export function buildCiDelegationResourceUri(values: CiDelegationValues): string {
  const v = normalizeCiDelegationValues(values);
  const parts = [
    `project_id=${encodeRfc3986(v.project_id)}`,
    `issuer=${encodeRfc3986(v.issuer)}`,
    `audience=${encodeRfc3986(v.audience)}`,
    `subject_match=${encodeRfc3986(v.subject_match)}`,
    `allowed_actions=${v.allowed_actions.map(encodeRfc3986).join(",")}`,
    `allowed_events=${v.allowed_events.map(encodeRfc3986).join(",")}`,
  ];
  if (v.expires_at !== null) parts.push(`expires_at=${encodeRfc3986(v.expires_at)}`);
  if (v.github_repository_id !== null) {
    parts.push(`github_repository_id=${encodeRfc3986(v.github_repository_id)}`);
  }
  parts.push(`nonce=${encodeRfc3986(v.nonce)}`);
  const uri = `run402-ci-delegation:v1?${parts.join("&")}`;
  if (new TextEncoder().encode(uri).byteLength > MAX_RESOURCE_URI_BYTES) {
    throw new LocalError(
      `CI delegation Resource URI exceeds ${MAX_RESOURCE_URI_BYTES} bytes`,
      "building CI delegation resource URI",
    );
  }
  return uri;
}

export function validateCiSubjectMatch(subject: string): string {
  if (typeof subject !== "string" || subject.length === 0) {
    throw new LocalError("CI subject_match must be a non-empty string", "validating CI subject");
  }
  if (subject.length > MAX_SUBJECT_MATCH_CHARS) {
    throw new LocalError(
      `CI subject_match must be ${MAX_SUBJECT_MATCH_CHARS} characters or fewer`,
      "validating CI subject",
    );
  }
  if (/[\x00-\x1f\x7f]/.test(subject)) {
    throw new LocalError("CI subject_match must not contain control characters", "validating CI subject");
  }
  const firstWildcard = subject.indexOf("*");
  if (firstWildcard >= 0) {
    if (subject === "*") {
      throw new LocalError("CI subject_match cannot be a bare wildcard", "validating CI subject");
    }
    if (firstWildcard !== subject.length - 1) {
      throw new LocalError(
        "CI subject_match wildcard is only allowed as the final character",
        "validating CI subject",
      );
    }
    if (subject.indexOf("*", firstWildcard + 1) >= 0) {
      throw new LocalError("CI subject_match can contain at most one wildcard", "validating CI subject");
    }
  }
  return subject;
}

export function validateCiNonce(nonce: string): string {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    throw new LocalError(
      "CI delegation nonce must be lowercase hex between 16 and 64 characters",
      "validating CI nonce",
    );
  }
  return nonce;
}

export function assertCiDeployableSpec(specOrPlanBody: ReleaseSpec | PlanRequest | unknown): void {
  const { spec, manifestRef } = unwrapSpecOrPlanBody(specOrPlanBody);
  if (manifestRef !== undefined && manifestRef !== null) {
    throwCiDeploySpecError(
      "manifest_ref",
      "CI deploys must use inline specs under the gateway body cap; manifest_ref is not allowed.",
    );
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throwCiDeploySpecError("spec", "CI deploy requires a ReleaseSpec object.");
  }

  const obj = spec as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CI_DEPLOY_SPEC_ALLOWED_KEYS.has(key)) {
      throwCiDeploySpecError(
        key,
        `CI deploy cannot ship spec.${key}; only project, database, functions, site, and base:{release:"current"} are allowed.`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(obj, "base") && !isCurrentBase(obj.base)) {
    throwCiDeploySpecError(
      "base",
      'CI deploy base must be absent or exactly { release: "current" }.',
    );
  }
}

function normalizeAllowedActions(values: readonly string[] | undefined): ["deploy"] {
  const actions = normalizeAllowedList(values, "allowed_actions");
  if (actions.length !== 1 || actions[0] !== "deploy") {
    throw new LocalError(
      'CI delegation allowed_actions must be exactly ["deploy"] in v1',
      "validating CI delegation",
    );
  }
  return ["deploy"];
}

function normalizeAllowedList(values: readonly string[] | undefined, field: string): string[] {
  if (!Array.isArray(values)) {
    throw new LocalError(`CI delegation ${field} must be an array`, "validating CI delegation");
  }
  const cleaned = values.map((value) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new LocalError(
        `CI delegation ${field} must contain only non-empty strings`,
        "validating CI delegation",
      );
    }
    return value;
  });
  return Array.from(new Set(cleaned)).sort();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function unwrapSpecOrPlanBody(
  value: ReleaseSpec | PlanRequest | unknown,
): { spec: unknown; manifestRef?: unknown } {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "spec" in value &&
    !("project" in value)
  ) {
    const body = value as { spec?: unknown; manifest_ref?: unknown };
    return { spec: body.spec, manifestRef: body.manifest_ref };
  }
  return { spec: value };
}

function isCurrentBase(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  return keys.length === 1 && obj.release === "current";
}

function throwCiDeploySpecError(resource: string, message: string): never {
  throw new Run402DeployError(message, {
    code: "forbidden_spec_field",
    phase: "validate",
    resource,
    retryable: false,
    context: "validating CI deploy spec",
  });
}
