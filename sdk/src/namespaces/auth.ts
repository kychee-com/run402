/**
 * `auth` namespace — project-scoped user authentication: magic links, password
 * set/change, auth settings, and admin role promotion/demotion.
 *
 * Magic link + password ops use the project's anon key (they represent
 * end-user flows). Settings + promote/demote use the service key.
 */

import type { Client } from "../kernel.js";
import { LocalError, ProjectNotFound } from "../errors.js";

export interface MagicLinkOptions {
  email: string;
  redirectUrl: string;
}

export interface MagicLinkUser {
  id: string;
  email: string;
}

export interface MagicLinkVerifyResult {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: MagicLinkUser;
}

export interface SetPasswordOptions {
  accessToken: string;
  newPassword: string;
  /** Required for password change; omit for reset (via magic link) or initial set. */
  currentPassword?: string;
}

export interface AuthSettings {
  allow_password_set: boolean;
}

export class Auth {
  constructor(private readonly client: Client) {}

  /** Send a passwordless login email (magic link). 15-minute token. */
  async requestMagicLink(projectId: string, opts: MagicLinkOptions): Promise<void> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.requestMagicLink(projectId, opts) requires an opts object as the 2nd argument (e.g., { email, redirectUrl })",
        "requesting magic link",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "requesting magic link");

    await this.client.request<unknown>("/auth/v1/magic-link", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      body: { email: opts.email, redirect_url: opts.redirectUrl },
      context: "requesting magic link",
    });
  }

  /** Exchange a magic-link token for access + refresh tokens. */
  async verifyMagicLink(projectId: string, token: string): Promise<MagicLinkVerifyResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "verifying magic link");

    return this.client.request<MagicLinkVerifyResult>(
      "/auth/v1/token?grant_type=magic_link",
      {
        method: "POST",
        headers: {
          apikey: project.anon_key,
          Authorization: `Bearer ${project.anon_key}`,
        },
        body: { token },
        context: "verifying magic link",
      },
    );
  }

  /**
   * Set / change / reset the authenticated user's password. The caller's
   * `accessToken` (from `verifyMagicLink` or a prior login) is used as the
   * Bearer credential.
   */
  async setUserPassword(projectId: string, opts: SetPasswordOptions): Promise<void> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.setUserPassword(projectId, opts) requires an opts object as the 2nd argument (e.g., { accessToken, newPassword })",
        "setting user password",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting user password");

    const body: Record<string, string> = { new_password: opts.newPassword };
    if (opts.currentPassword) body.current_password = opts.currentPassword;

    await this.client.request<unknown>("/auth/v1/user/password", {
      method: "PUT",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body,
      context: "setting user password",
    });
  }

  /** Update project-level auth settings. Requires service key. */
  async settings(projectId: string, settings: AuthSettings): Promise<void> {
    if (!settings || typeof settings !== "object") {
      throw new LocalError(
        "r.auth.settings(projectId, settings) requires a settings object as the 2nd argument (e.g., { allow_password_set: true })",
        "updating auth settings",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "updating auth settings");

    await this.client.request<unknown>("/auth/v1/settings", {
      method: "PATCH",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      body: { allow_password_set: settings.allow_password_set },
      context: "updating auth settings",
    });
  }

  /** Promote a user (by email) to `project_admin`. Requires service key. */
  async promote(projectId: string, email: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "promoting user");

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/promote-user`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { email },
        context: "promoting user",
      },
    );
  }

  /** Demote a user (by email) from `project_admin` back to the default role. */
  async demote(projectId: string, email: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "demoting user");

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/demote-user`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { email },
        context: "demoting user",
      },
    );
  }
}
