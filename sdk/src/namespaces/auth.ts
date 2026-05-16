/**
 * `auth` namespace — project-scoped user authentication: magic links, password
 * set/change, auth settings, and admin role promotion/demotion.
 *
 * Magic link + password ops use the project's anon key (they represent
 * end-user flows). Settings + promote/demote use the service key.
 */

import type { Client } from "../kernel.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import {
  assertEmailAddress,
  assertHttpUrl,
  assertNonEmptyString,
  assertStringInSet,
} from "../validation.js";

export interface MagicLinkOptions {
  email: string;
  redirectUrl: string;
  intent?: "signin" | "invite" | "claim" | "recovery";
  clientState?: unknown;
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
  magic_link?: {
    intent: "signin" | "invite" | "claim" | "recovery";
    client_state: string | null;
    state_source: "anonymous" | "service_key";
    state_trusted: boolean;
  };
}

export interface SetPasswordOptions {
  accessToken: string;
  newPassword: string;
  /** Required for password change; omit for reset (via magic link) or initial set. */
  currentPassword?: string;
}

export interface AuthSettings {
  allow_password_set?: boolean;
  preferred_sign_in_method?: "password" | "magic_link" | "oauth_google" | "passkey" | null;
  public_signup?: "open" | "known_email" | "invite_only";
  require_passkey_for_project_admin?: boolean;
}

export interface AuthSettingsResult {
  allow_password_set: boolean;
  preferred_sign_in_method: "password" | "magic_link" | "oauth_google" | "passkey" | null;
  public_signup: "open" | "known_email" | "invite_only";
  require_passkey_for_project_admin: boolean;
}

export interface CreateAuthUserOptions {
  email: string;
  isAdmin?: boolean;
  sendInvite?: boolean;
  redirectUrl?: string;
  clientState?: unknown;
}

export interface AuthUserAdminResult {
  id: string;
  email: string;
  is_admin: boolean;
  email_verified_at: string | null;
  created: boolean;
  invite_sent: boolean;
}

export interface AuthSessionResult extends MagicLinkVerifyResult {
  elevation_required?: boolean;
  required_method?: "passkey";
  effective_role?: "authenticated";
  intended_role?: "project_admin";
}

const MAGIC_LINK_INTENTS = ["signin", "invite", "claim", "recovery"] as const;
const AUTH_SETTINGS_FIELDS = [
  "allow_password_set",
  "preferred_sign_in_method",
  "public_signup",
  "require_passkey_for_project_admin",
] as const;
const SIGN_IN_METHODS = ["password", "magic_link", "oauth_google", "passkey"] as const;
const PUBLIC_SIGNUP_POLICIES = ["open", "known_email", "invite_only"] as const;

function validateAuthSettings(settings: AuthSettings): void {
  const raw = settings as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(AUTH_SETTINGS_FIELDS as readonly string[]).includes(key)) {
      throw new LocalError(`Unknown auth settings field: ${key}`, "updating auth settings");
    }
  }
  if (
    raw.allow_password_set !== undefined &&
    typeof raw.allow_password_set !== "boolean"
  ) {
    throw new LocalError("allow_password_set must be a boolean.", "updating auth settings");
  }
  if (
    raw.require_passkey_for_project_admin !== undefined &&
    typeof raw.require_passkey_for_project_admin !== "boolean"
  ) {
    throw new LocalError(
      "require_passkey_for_project_admin must be a boolean.",
      "updating auth settings",
    );
  }
  if (raw.preferred_sign_in_method !== undefined && raw.preferred_sign_in_method !== null) {
    assertStringInSet(
      raw.preferred_sign_in_method,
      SIGN_IN_METHODS,
      "preferred_sign_in_method",
      "updating auth settings",
    );
  }
  if (raw.public_signup !== undefined) {
    assertStringInSet(
      raw.public_signup,
      PUBLIC_SIGNUP_POLICIES,
      "public_signup",
      "updating auth settings",
    );
  }
}

export interface PasskeyOptionsResult {
  challenge_id: string;
  options: unknown;
}

export interface PasskeyRecord {
  id: string;
  rp_id: string;
  created_origin: string;
  last_used_origin?: string | null;
  transports: string[];
  label: string | null;
  credential_device_type: string | null;
  credential_backed_up: boolean | null;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeyRegistrationOptions {
  accessToken: string;
  appOrigin: string;
}

export interface PasskeyRegistrationVerifyOptions {
  accessToken: string;
  challengeId: string;
  response: unknown;
  label?: string;
}

export interface PasskeyLoginOptions {
  appOrigin: string;
  email?: string;
}

export interface PasskeyLoginVerifyOptions {
  challengeId: string;
  response: unknown;
}

export interface PasskeyListOptions {
  accessToken: string;
}

export interface PasskeyDeleteOptions {
  accessToken: string;
  passkeyId: string;
}

export class Auth {
  readonly magicLink: (projectId: string, opts: MagicLinkOptions) => Promise<void>;
  readonly verify: (projectId: string, token: string) => Promise<MagicLinkVerifyResult>;
  readonly setPassword: (projectId: string, opts: SetPasswordOptions) => Promise<void>;
  readonly promoteUser: (projectId: string, email: string) => Promise<void>;
  readonly demoteUser: (projectId: string, email: string) => Promise<void>;

  constructor(private readonly client: Client) {
    this.magicLink = this.requestMagicLink.bind(this);
    this.verify = this.verifyMagicLink.bind(this);
    this.setPassword = this.setUserPassword.bind(this);
    this.promoteUser = this.promote.bind(this);
    this.demoteUser = this.demote.bind(this);
  }

  /** Send a passwordless login email (magic link). 15-minute token. */
  async requestMagicLink(projectId: string, opts: MagicLinkOptions): Promise<void> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.auth.requestMagicLink(projectId, opts) requires an opts object as the 2nd argument (e.g., { email, redirectUrl })",
        "requesting magic link",
      );
    }
    assertEmailAddress(opts.email, "email", "requesting magic link");
    assertHttpUrl(opts.redirectUrl, "redirectUrl", "requesting magic link");
    if (opts.intent !== undefined) {
      assertStringInSet(opts.intent, MAGIC_LINK_INTENTS, "intent", "requesting magic link");
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "requesting magic link");

    const body: Record<string, unknown> = {
      email: opts.email,
      redirect_url: opts.redirectUrl,
    };
    if (opts.intent) body.intent = opts.intent;
    if (opts.clientState !== undefined) body.client_state = opts.clientState;

    await this.client.request<unknown>("/auth/v1/magic-link", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.intent === "invite" ? project.service_key : project.anon_key}`,
      },
      body,
      context: "requesting magic link",
    });
  }

  /** Exchange a magic-link token for access + refresh tokens. */
  async verifyMagicLink(projectId: string, token: string): Promise<MagicLinkVerifyResult> {
    assertNonEmptyString(token, "token", "verifying magic link");
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
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.auth.setUserPassword(projectId, opts) requires an opts object as the 2nd argument (e.g., { accessToken, newPassword })",
        "setting user password",
      );
    }
    assertNonEmptyString(opts.accessToken, "accessToken", "setting user password");
    assertNonEmptyString(opts.newPassword, "newPassword", "setting user password");
    if (opts.currentPassword !== undefined) {
      assertNonEmptyString(opts.currentPassword, "currentPassword", "setting user password");
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting user password");

    const body: Record<string, string> = { new_password: opts.newPassword };
    if (opts.currentPassword !== undefined) body.current_password = opts.currentPassword;

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
  async settings(projectId: string, settings: AuthSettings): Promise<AuthSettingsResult> {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new LocalError(
        "r.auth.settings(projectId, settings) requires a settings object as the 2nd argument (e.g., { allow_password_set: true })",
        "updating auth settings",
      );
    }
    validateAuthSettings(settings);
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "updating auth settings");

    return this.client.request<AuthSettingsResult>("/auth/v1/settings", {
      method: "PATCH",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      body: settings,
      context: "updating auth settings",
    });
  }

  /** Create or update an auth user. Requires service key. */
  async createUser(projectId: string, opts: CreateAuthUserOptions): Promise<AuthUserAdminResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.auth.createUser(projectId, opts) requires an opts object as the 2nd argument (e.g., { email, isAdmin })",
        "creating auth user",
      );
    }
    assertEmailAddress(opts.email, "email", "creating auth user");
    if (opts.redirectUrl !== undefined) {
      assertHttpUrl(opts.redirectUrl, "redirectUrl", "creating auth user");
    }
    if (opts.isAdmin !== undefined && typeof opts.isAdmin !== "boolean") {
      throw new LocalError("isAdmin must be a boolean when provided.", "creating auth user");
    }
    if (opts.sendInvite !== undefined && typeof opts.sendInvite !== "boolean") {
      throw new LocalError("sendInvite must be a boolean when provided.", "creating auth user");
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "creating auth user");

    const body: Record<string, unknown> = { email: opts.email };
    if (typeof opts.isAdmin === "boolean") body.is_admin = opts.isAdmin;
    if (typeof opts.sendInvite === "boolean") body.send_invite = opts.sendInvite;
    if (opts.redirectUrl !== undefined) body.redirect_url = opts.redirectUrl;
    if (opts.clientState !== undefined) body.client_state = opts.clientState;

    return this.client.request<AuthUserAdminResult>("/auth/v1/admin/users", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      body,
      context: "creating auth user",
    });
  }

  /** Create/update an auth user and send a trusted invite. Requires service key. */
  async inviteUser(projectId: string, opts: Omit<CreateAuthUserOptions, "sendInvite">): Promise<AuthUserAdminResult> {
    return this.createUser(projectId, { ...opts, sendInvite: true });
  }

  /** Create WebAuthn registration options for the authenticated user. */
  async createPasskeyRegistrationOptions(
    projectId: string,
    opts: PasskeyRegistrationOptions,
  ): Promise<PasskeyOptionsResult> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.createPasskeyRegistrationOptions(projectId, opts) requires { accessToken, appOrigin }",
        "creating passkey registration options",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "creating passkey registration options");

    return this.client.request<PasskeyOptionsResult>("/auth/v1/passkeys/register/options", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body: { app_origin: opts.appOrigin },
      context: "creating passkey registration options",
    });
  }

  /** Verify and store a WebAuthn passkey registration. */
  async verifyPasskeyRegistration(
    projectId: string,
    opts: PasskeyRegistrationVerifyOptions,
  ): Promise<PasskeyRecord> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.verifyPasskeyRegistration(projectId, opts) requires { accessToken, challengeId, response }",
        "verifying passkey registration",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "verifying passkey registration");

    const body: Record<string, unknown> = {
      challenge_id: opts.challengeId,
      response: opts.response,
    };
    if (opts.label) body.label = opts.label;

    return this.client.request<PasskeyRecord>("/auth/v1/passkeys/register/verify", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body,
      context: "verifying passkey registration",
    });
  }

  /** Create WebAuthn login options. */
  async createPasskeyLoginOptions(projectId: string, opts: PasskeyLoginOptions): Promise<PasskeyOptionsResult> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.createPasskeyLoginOptions(projectId, opts) requires { appOrigin }",
        "creating passkey login options",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "creating passkey login options");

    const body: Record<string, unknown> = { app_origin: opts.appOrigin };
    if (opts.email) body.email = opts.email;

    return this.client.request<PasskeyOptionsResult>("/auth/v1/passkeys/login/options", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      body,
      context: "creating passkey login options",
    });
  }

  /** Verify a WebAuthn login assertion and return a normal auth session. */
  async verifyPasskeyLogin(projectId: string, opts: PasskeyLoginVerifyOptions): Promise<AuthSessionResult> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.verifyPasskeyLogin(projectId, opts) requires { challengeId, response }",
        "verifying passkey login",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "verifying passkey login");

    return this.client.request<AuthSessionResult>("/auth/v1/passkeys/login/verify", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      body: {
        challenge_id: opts.challengeId,
        response: opts.response,
      },
      context: "verifying passkey login",
    });
  }

  /** List the authenticated user's active passkeys. */
  async listPasskeys(projectId: string, opts: PasskeyListOptions): Promise<{ passkeys: PasskeyRecord[] }> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.listPasskeys(projectId, opts) requires { accessToken }",
        "listing passkeys",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing passkeys");

    return this.client.request<{ passkeys: PasskeyRecord[] }>("/auth/v1/passkeys", {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.accessToken}`,
      },
      context: "listing passkeys",
      withAuth: false,
    });
  }

  /** Delete one authenticated-user passkey by id. */
  async deletePasskey(projectId: string, opts: PasskeyDeleteOptions): Promise<void> {
    if (!opts || typeof opts !== "object") {
      throw new LocalError(
        "r.auth.deletePasskey(projectId, opts) requires { accessToken, passkeyId }",
        "deleting passkey",
      );
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting passkey");

    await this.client.request<unknown>(`/auth/v1/passkeys/${encodeURIComponent(opts.passkeyId)}`, {
      method: "DELETE",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.accessToken}`,
      },
      context: "deleting passkey",
    });
  }

  /** List configured auth providers for a project. Uses the project's anon key. */
  async providers(projectId: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing auth providers");

    return this.client.request<unknown>("/auth/v1/providers", {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      context: "listing auth providers",
      withAuth: false,
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
