/**
 * `grants` namespace — per-project capability grants and the grant keys minted
 * against them.
 *
 * A grant is the permission row (this principal may do this capability on this
 * project until this date). A grant key is a credential minted against exactly
 * one grant: narrower than it, spend-capped, expiring, revocable on its own,
 * never an owner. An agent with its own wallet needs only the grant (it signs
 * via SIWX); an agent without one gets a grant key.
 *
 * The practical reason keys exist on the client: project API keys are
 * stateless JWTs handed out once at create and never re-issued, so an agent
 * that loses local state has no way back into its own project. The owner still
 * holds a wallet, and SIWX is enough to mint a fresh grant key.
 *
 * Every call requires the caller to be an active owner of the project's org.
 * Exposed both unscoped (`r.grants.create(projectId, …)`) and project-scoped
 * (`r.project(id).grants.create(…)`), mirroring `r.functions` / `r.jobs`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  CreateGrantInput,
  GrantCreateResult,
  GrantKeyCreateResult,
  GrantKeyInput,
  GrantKeyRevokeResult,
  GrantKeyRotateResult,
  GrantListResult,
  GrantRevokeResult,
} from "./grants.types.js";

function grantKeyBody(input: GrantKeyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.spendCap !== undefined) body.spend_cap = input.spendCap;
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
  if (input.publicSubject !== undefined) body.public_subject = input.publicSubject;
  return body;
}

function projectPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}`;
}

export class Grants {
  constructor(private readonly client: Client) {}

  /**
   * Issue a capability grant to a wallet for a project
   * (`POST /projects/v1/:project_id/grants`). With `key`, also mints the
   * grant's first grant key in the same transaction; its `key.token` is
   * returned **once** — persist it immediately, or rotate for a new one.
   */
  async create(projectId: string, input: CreateGrantInput): Promise<GrantCreateResult> {
    if (!projectId) {
      throw new LocalError("grants.create requires a projectId", "creating project grant");
    }
    if (!input?.wallet) {
      throw new LocalError("grants.create requires { wallet }", "creating project grant");
    }
    if (!input?.capability) {
      throw new LocalError("grants.create requires { capability }", "creating project grant");
    }
    const body: Record<string, unknown> = {
      wallet: input.wallet,
      capability: input.capability,
    };
    if (input.policy !== undefined) body.policy = input.policy;
    if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
    if (input.key !== undefined) body.key = grantKeyBody(input.key);
    return this.client.request<GrantCreateResult>(`${projectPath(projectId)}/grants`, {
      method: "POST",
      body,
      context: "creating project grant",
    });
  }

  /**
   * List a project's grants with their grant keys nested
   * (`GET /projects/v1/:project_id/grants`). Never returns a token or any
   * secret material.
   */
  async list(projectId: string): Promise<GrantListResult> {
    if (!projectId) {
      throw new LocalError("grants.list requires a projectId", "listing project grants");
    }
    return this.client.request<GrantListResult>(`${projectPath(projectId)}/grants`, {
      method: "GET",
      context: "listing project grants",
    });
  }

  /**
   * Revoke a capability grant and every grant key minted against it
   * (`DELETE /projects/v1/:project_id/grants/:grant_id`).
   */
  async revoke(projectId: string, grantId: string): Promise<GrantRevokeResult> {
    if (!projectId) {
      throw new LocalError("grants.revoke requires a projectId", "revoking project grant");
    }
    if (!grantId) {
      throw new LocalError("grants.revoke requires a grantId", "revoking project grant");
    }
    return this.client.request<GrantRevokeResult>(
      `${projectPath(projectId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE", context: "revoking project grant" },
    );
  }

  /**
   * Mint another grant key against an existing grant
   * (`POST /projects/v1/:project_id/grants/:grant_id/keys`). `key.token` is
   * returned **once**.
   */
  async createKey(projectId: string, grantId: string, input: GrantKeyInput = {}): Promise<GrantKeyCreateResult> {
    if (!projectId) {
      throw new LocalError("grants.createKey requires a projectId", "minting grant key");
    }
    if (!grantId) {
      throw new LocalError("grants.createKey requires a grantId", "minting grant key");
    }
    return this.client.request<GrantKeyCreateResult>(
      `${projectPath(projectId)}/grants/${encodeURIComponent(grantId)}/keys`,
      { method: "POST", body: grantKeyBody(input), context: "minting grant key" },
    );
  }

  /**
   * Revoke one grant key (`DELETE /projects/v1/:project_id/grant-keys/:key_id`).
   * The grant and its other keys stay.
   */
  async revokeKey(projectId: string, keyId: string): Promise<GrantKeyRevokeResult> {
    if (!projectId) {
      throw new LocalError("grants.revokeKey requires a projectId", "revoking grant key");
    }
    if (!keyId) {
      throw new LocalError("grants.revokeKey requires a keyId", "revoking grant key");
    }
    return this.client.request<GrantKeyRevokeResult>(
      `${projectPath(projectId)}/grant-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE", context: "revoking grant key" },
    );
  }

  /**
   * Replace a grant key (`POST /projects/v1/:project_id/grant-keys/:key_id/rotate`):
   * revokes it and mints a fresh one against the same grant with the same
   * kind, scope, cap and expiry. The new `key.token` is returned **once**.
   */
  async rotateKey(projectId: string, keyId: string): Promise<GrantKeyRotateResult> {
    if (!projectId) {
      throw new LocalError("grants.rotateKey requires a projectId", "rotating grant key");
    }
    if (!keyId) {
      throw new LocalError("grants.rotateKey requires a keyId", "rotating grant key");
    }
    return this.client.request<GrantKeyRotateResult>(
      `${projectPath(projectId)}/grant-keys/${encodeURIComponent(keyId)}/rotate`,
      { method: "POST", context: "rotating grant key" },
    );
  }
}
