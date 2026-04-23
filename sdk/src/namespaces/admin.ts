/**
 * `admin` namespace — account-level operations that don't belong to any
 * single resource: sending messages to the operators, registering agent
 * contact info.
 *
 * (The compound `init` and `status` flows live at the MCP/CLI edge because
 * they stitch together multiple SDK namespaces + local state.)
 */

import type { Client } from "../kernel.js";

export interface AgentContact {
  name: string;
  email?: string;
  webhook?: string;
}

export interface AgentContactResult {
  wallet: string;
  name: string;
  email?: string;
  webhook?: string;
  updated_at: string;
}

export class Admin {
  constructor(private readonly client: Client) {}

  /** Send a message to the Run402 developers. Requires an active tier. */
  async sendMessage(message: string): Promise<void> {
    await this.client.request<unknown>("/message/v1", {
      method: "POST",
      body: { message },
      context: "sending message",
    });
  }

  /** Register agent contact info (name, email, webhook). */
  async setAgentContact(contact: AgentContact): Promise<AgentContactResult> {
    const body: Record<string, string> = { name: contact.name };
    if (contact.email) body.email = contact.email;
    if (contact.webhook) body.webhook = contact.webhook;

    return this.client.request<AgentContactResult>("/agent/v1/contact", {
      method: "POST",
      body,
      context: "setting agent contact",
    });
  }
}
