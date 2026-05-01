/**
 * `service` namespace — public `GET /status` and `GET /health` endpoints.
 * No auth, no allowance, no project scope. Safe to call from anywhere.
 */

import type { Client } from "../kernel.js";

export interface ServiceStatusPayload {
  status: string;
  uptime_seconds: number;
  deployment: { version: string };
  capabilities: string[];
  operator: { name: string; contact: string };
}

export interface ServiceHealthPayload {
  status: string;
  checks: Record<string, string>;
  version: string;
}

export class Service {
  constructor(private readonly client: Client) {}

  /** Reports availability, uptime, operator metadata, capability states. */
  async status(): Promise<ServiceStatusPayload> {
    return this.client.request<ServiceStatusPayload>("/status", {
      context: "fetching service status",
      withAuth: false,
    });
  }

  /** Liveness check with per-dependency results. */
  async health(): Promise<ServiceHealthPayload> {
    return this.client.request<ServiceHealthPayload>("/health", {
      context: "fetching service health",
      withAuth: false,
    });
  }
}
