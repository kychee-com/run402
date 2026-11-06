/**
 * `push` namespace — the agent-side check on a project's push notifications,
 * and the Firebase key its phone app's devices are reached with. A deployed
 * function sends with `push.send(...)` from `@run402/functions`; the two
 * reads show who is signed up (browsers and phone-app devices), how much of
 * the organization's daily delivery cap is used, and what happened to each
 * message. `setFcmCredential` takes a service-account key, so on the MCP
 * sandbox it refuses with `SECRET_REQUIRES_CLI` (the CLI reads the key file
 * from disk instead).
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
import { gateSecret } from "../secret-gate.js";
import type { PushFcmCredential, PushFcmRemoval, PushMessage, PushStatus } from "./push.types.js";

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

  /**
   * Give Run402 the project's Firebase service-account key, so `push.send`
   * reaches the devices its phone app registers
   * (`POST /projects/v1/:project_id/push/providers/fcm`). `serviceAccount` is
   * the JSON object Firebase downloads (Project settings, Service accounts,
   * Generate new private key). Run402 checks it with Google before storing it
   * (422 when Google refuses it), keeps it encrypted, and answers only its
   * public fields. A key for another Firebase project removes the devices
   * registered under the old one (`devices_removed`).
   */
  async setFcmCredential(projectId: string, serviceAccount: Record<string, unknown>): Promise<PushFcmCredential> {
    gateSecret(this.client, "push.setFcmCredential", projectId);
    if (!projectId) {
      throw new LocalError("push.setFcmCredential requires a projectId", "setting the Firebase key");
    }
    if (!serviceAccount || typeof serviceAccount !== "object" || Array.isArray(serviceAccount)) {
      throw new LocalError("push.setFcmCredential requires the service-account JSON object", "setting the Firebase key");
    }
    return this.client.request<PushFcmCredential>(`${pushPath(projectId)}/providers/fcm`, {
      method: "POST",
      body: { service_account: serviceAccount },
      projectKeyFallback: projectId,
      context: "setting the Firebase key",
    });
  }

  /**
   * Remove the project's Firebase key and every device registered under it
   * (`DELETE /projects/v1/:project_id/push/providers/fcm`). A 404 when none is set.
   */
  async removeFcmCredential(projectId: string): Promise<PushFcmRemoval> {
    if (!projectId) {
      throw new LocalError("push.removeFcmCredential requires a projectId", "removing the Firebase key");
    }
    return this.client.request<PushFcmRemoval>(`${pushPath(projectId)}/providers/fcm`, {
      method: "DELETE",
      projectKeyFallback: projectId,
      context: "removing the Firebase key",
    });
  }
}
