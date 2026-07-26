/**
 * `delegates` namespace — scoped, revocable, expiring credentials an OWNER
 * mints for an agent (gateway `cryptographic-delegates`, v1.79). Maps to
 * `/projects/v1/:project_id/delegates`. Every mutation requires the caller to
 * be an active owner of the project's owning org.
 *
 * A delegate always NARROWS an existing `project_grant` — mint the grant first
 * (`r.grants.create(...)`), then hang a delegate off its `grant_id`. A delegate
 * can never be an owner; that is enforced structurally by the gateway.
 *
 * The practical reason this exists on the client: project API keys are
 * stateless JWTs handed out once at create and never re-issued, so an agent
 * that loses local state has no way back into its own project. A delegate is
 * the supported recovery path — the owner still holds a wallet, and SIWX is
 * enough to mint a fresh deploy credential.
 *
 * Exposed both unscoped (`r.delegates.create(projectId, …)`) and
 * project-scoped (`r.project(id).delegates.create(…)`), mirroring `r.grants`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  CreateDelegateInput,
  DelegateCreateResult,
  DelegateListResult,
  DelegateRevokeResult,
  DelegateScope,
} from "./delegates.types.js";

export class Delegates {
  constructor(private readonly client: Client) {}

  /**
   * Issue a delegate against an existing grant
   * (`POST /projects/v1/:project_id/delegates`). Requires owner of the project's org.
   *
   * The returned `token` is shown **once**. Persist it immediately; there is no
   * way to read it back, only to rotate for a new one.
   */
  async create(projectId: string, input: CreateDelegateInput): Promise<DelegateCreateResult> {
    if (!projectId) {
      throw new LocalError("delegates.create requires a projectId", "issuing project delegate");
    }
    if (!input?.grantId) {
      throw new LocalError(
        "delegates.create requires { grantId } — mint a grant first with grants.create()",
        "issuing project delegate",
      );
    }
    // The gateway REQUIRES a scope object and 400s without one. Default to the
    // common case (this grant's capability on this project) so the caller does
    // not have to know the wire schema to do the obvious thing.
    const scope: DelegateScope = input.scope ?? {
      v: 1,
      capabilities: ["deploy"],
      projects: [projectId],
    };
    const body: Record<string, unknown> = {
      grant_id: input.grantId,
      kind: input.kind ?? "run402_agent_key",
      scope,
    };
    if (input.spendCap !== undefined) body.spend_cap = input.spendCap;
    if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
    if (input.publicSubject !== undefined) body.public_subject = input.publicSubject;
    return this.client.request<DelegateCreateResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/delegates`,
      { method: "POST", body, context: "issuing project delegate" },
    );
  }

  /**
   * List a project's delegates (`GET /projects/v1/:project_id/delegates`).
   * Never returns a token or any secret material — names, scope and caps only.
   */
  async list(projectId: string): Promise<DelegateListResult> {
    if (!projectId) {
      throw new LocalError("delegates.list requires a projectId", "listing project delegates");
    }
    return this.client.request<DelegateListResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/delegates`,
      { method: "GET", context: "listing project delegates" },
    );
  }

  /**
   * Revoke a delegate (`DELETE /projects/v1/:project_id/delegates/:delegate_id`).
   * Effective immediately for subsequent requests.
   */
  async revoke(projectId: string, delegateId: string): Promise<DelegateRevokeResult> {
    if (!projectId) {
      throw new LocalError("delegates.revoke requires a projectId", "revoking project delegate");
    }
    if (!delegateId) {
      throw new LocalError("delegates.revoke requires a delegateId", "revoking project delegate");
    }
    return this.client.request<DelegateRevokeResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/delegates/${encodeURIComponent(delegateId)}`,
      { method: "DELETE", context: "revoking project delegate" },
    );
  }

  /**
   * Rotate a delegate (`POST /projects/v1/:project_id/delegates/:delegate_id/rotate`)
   * — revokes the old credential and reissues the same principal/grant/scope/cap.
   * The new `token` is again shown once.
   */
  async rotate(projectId: string, delegateId: string): Promise<DelegateCreateResult> {
    if (!projectId) {
      throw new LocalError("delegates.rotate requires a projectId", "rotating project delegate");
    }
    if (!delegateId) {
      throw new LocalError("delegates.rotate requires a delegateId", "rotating project delegate");
    }
    return this.client.request<DelegateCreateResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/delegates/${encodeURIComponent(delegateId)}/rotate`,
      { method: "POST", context: "rotating project delegate" },
    );
  }
}
