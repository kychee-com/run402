/**
 * `grants` namespace — per-project capability grants for non-member
 * (agent / CI) principals (gateway `org-member-management`). Issue or revoke a
 * grant against `/projects/v1/:project_id/grants`. Mutations require the caller
 * to be an active owner of the project's owning org.
 *
 * Exposed both unscoped (`r.grants.create(projectId, …)`) and project-scoped
 * (`r.project(id).grants.create(…)`), mirroring `r.functions` / `r.jobs`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  CreateGrantInput,
  GrantCreateResult,
  GrantRevokeResult,
} from "./grants.types.js";

export class Grants {
  constructor(private readonly client: Client) {}

  /**
   * Issue a capability grant to a wallet for a project
   * (`POST /projects/v1/:project_id/grants`). Requires owner of the project's org.
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
    return this.client.request<GrantCreateResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/grants`,
      { method: "POST", body, context: "creating project grant" },
    );
  }

  /**
   * Revoke a capability grant
   * (`DELETE /projects/v1/:project_id/grants/:grant_id`). Requires owner of the
   * project's org.
   */
  async revoke(projectId: string, grantId: string): Promise<GrantRevokeResult> {
    if (!projectId) {
      throw new LocalError("grants.revoke requires a projectId", "revoking project grant");
    }
    if (!grantId) {
      throw new LocalError("grants.revoke requires a grantId", "revoking project grant");
    }
    return this.client.request<GrantRevokeResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE", context: "revoking project grant" },
    );
  }
}
