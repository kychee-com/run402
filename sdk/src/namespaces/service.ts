/**
 * `service` namespace — public `GET /status` and `GET /health` endpoints.
 * No auth, no allowance, no project scope. Safe to call from anywhere.
 */

import type { Client } from "../kernel.js";

export interface ServiceStatusPayload {
  schema_version?: string;
  service?: string;
  current_status?: string;
  operator?: { legal_name?: string; terms_url?: string; contact?: string };
  availability?: {
    last_30d?: { uptime_pct?: number; total_probes?: number; healthy_probes?: number };
    last_7d?: { uptime_pct?: number };
    last_24h?: { uptime_pct?: number };
  };
  capabilities?: Record<string, string>;
  deployment?: { cloud?: string; region?: string; topology?: string };
  links?: { health?: string };
}

export interface ServiceHealthPayload {
  status?: string;
  checks?: Record<string, string>;
  version?: string;
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
