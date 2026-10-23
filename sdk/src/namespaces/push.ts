/**
 * `push` namespace — the agent-side check on a project's web push
 * notifications. A deployed function sends with `push.send(...)` from
 * `@run402/functions`; these two reads show who is signed up, how much of
 * the organization's daily delivery cap is used, and what happened to each
 * message.
 *
 * Exposed both unscoped (`r.push.status(projectId)`) and project-scoped
 * (`r.project(id).push.status()`), mirroring `r.events`. Accepted
 * credentials: the project's own service_key, a SIWX/control-plane principal
 * with `project.read`, or a grant key. A principal (grant key, wallet, or
 * sign-in session) is sent when the credential provider has one; otherwise
 * the project's locally cached service key. An unknown message id, or another
 * project's, is a 404 `ApiError` carrying the gateway's `code`.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type { PushMessage, PushStatus } from "./push.types.js";

function pushPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/push`;
}

export class Push {
  constructor(private readonly client: Client) {}

  /**
   * Subscriptions by user, today's deliveries against the organization's
   * daily cap, and the latest 10 messages with their outcome counts
   * (`GET /projects/v1/:project_id/push`).
   */
  async status(projectId: string): Promise<PushStatus> {
    if (!projectId) {
      throw new LocalError("push.status requires a projectId", "reading push status");
    }
    return this.client.request<PushStatus>(pushPath(projectId), {
      method: "GET",
      projectKeyFallback: projectId,
      context: "reading push status",
    });
  }

  /**
   * One message: what was sent, to whom, and each delivery's state
   * (`GET /projects/v1/:project_id/push/messages/:message_id`).
   */
  async getMessage(projectId: string, messageId: string): Promise<PushMessage> {
    if (!projectId) {
      throw new LocalError("push.getMessage requires a projectId", "reading push message");
    }
    if (!messageId) {
      throw new LocalError("push.getMessage requires a messageId", "reading push message");
    }
    return this.client.request<PushMessage>(`${pushPath(projectId)}/messages/${encodeURIComponent(messageId)}`, {
      method: "GET",
      projectKeyFallback: projectId,
      context: "reading push message",
    });
  }
}
