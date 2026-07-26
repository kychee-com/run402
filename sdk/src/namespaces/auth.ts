/**
 * `auth` namespace — project-scoped user authentication: magic links, password
 * set/change, auth settings, and admin role promotion/demotion.
 *
 * Magic link + password ops use the project's anon key (they represent
 * end-user flows). Settings + promote/demote use the service key.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";
import {
  assertEmailAddress,
  assertHttpUrl,
  assertNonEmptyString,
  assertStringInSet,
} from "../validation.js";

export type EmailAuthDelivery = "link" | "code" | "both";

interface MagicLinkOptionsBase {
  email: string;
  intent?: "signin" | "invite" | "claim" | "recovery";
  clientState?: unknown;
}

export type MagicLinkOptions =
  | (MagicLinkOptionsBase & { delivery?: "link"; redirectUrl: string })
  | (MagicLinkOptionsBase & { delivery: "both"; redirectUrl: string })
  | (MagicLinkOptionsBase & { delivery: "code"; redirectUrl?: string });

export interface MagicLinkRequestWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface MagicLinkRequestResult {
  message: string;
  warnings?: MagicLinkRequestWarning[];
  challengeId?: string;
}

export interface EmailCodeVerifyOptions {
  challengeId: string;
  code: string;
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
    delivery?: EmailAuthDelivery;
    verified_with?: "link" | "email_code";
  };
}

export interface AuthProvidersResult {
  magic_link: {
    enabled: boolean;
    /** Capability-gated email modes. Absent means link-only compatibility. */
    deliveryModes: EmailAuthDelivery[];
  };
  [key: string]: unknown;
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
  /**
   * Restrict hosted Google sign-in to these email domains, enforced at token
   * issuance. `[]` or omitted = unrestricted. Entries are normalized
   * (lowercased, leading `@` stripped, trimmed, deduped) and domain-validated
   * server-side; pass an explicit `[]` to clear an existing restriction.
   */
  allowed_email_domains?: string[];
}

export interface AuthSettingsResult {
  allow_password_set: boolean;
  preferred_sign_in_method: "password" | "magic_link" | "oauth_google" | "passkey" | null;
  public_signup: "open" | "known_email" | "invite_only";
  require_passkey_for_project_admin: boolean;
  /** Normalized email-domain allowlist for hosted Google sign-in; `[]` = unrestricted. */
  allowed_email_domains: string[];
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
  "allowed_email_domains",
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
  if (raw.allowed_email_domains !== undefined) {
    if (
      !Array.isArray(raw.allowed_email_domains) ||
      !raw.allowed_email_domains.every((d) => typeof d === "string")
    ) {
      throw new LocalError(
        'allowed_email_domains must be an array of strings (e.g., ["example.com"]); pass [] to clear.',
        "updating auth settings",
      );
    }
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
  readonly magicLink: (projectId: string, opts: MagicLinkOptions) => Promise<MagicLinkRequestResult>;
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

  /** Request a passwordless email credential. Link remains the wire default. */
  async requestMagicLink(projectId: string, opts: MagicLinkOptions): Promise<MagicLinkRequestResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.auth.requestMagicLink(projectId, opts) requires an opts object as the 2nd argument (e.g., { email, redirectUrl })",
        "requesting magic link",
      );
    }
    assertEmailAddress(opts.email, "email", "requesting magic link");
    const delivery = opts.delivery ?? "link";
    assertStringInSet(delivery, ["link", "code", "both"] as const, "delivery", "requesting magic link");
    if (delivery !== "code" || opts.redirectUrl !== undefined) {
      assertHttpUrl(opts.redirectUrl, "redirectUrl", "requesting magic link");
    }
    if (opts.intent !== undefined) {
      assertStringInSet(opts.intent, MAGIC_LINK_INTENTS, "intent", "requesting magic link");
    }
    const project = await requireProjectCredentials(this.client, projectId, "requesting magic link");

    const body: Record<string, unknown> = {
      email: opts.email,
    };
    if (opts.redirectUrl !== undefined) body.redirect_url = opts.redirectUrl;
    if (opts.delivery !== undefined) body.delivery = opts.delivery;
    if (opts.intent) body.intent = opts.intent;
    if (opts.clientState !== undefined) body.client_state = opts.clientState;

    const result = await this.client.request<{
      message: string;
      warnings?: MagicLinkRequestWarning[];
      challenge_id?: string;
    }>("/auth/v1/magic-link", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${opts.intent === "invite" ? project.service_key : project.anon_key}`,
      },
      body,
      context: "requesting magic link",
    });
    return {
      message: result.message,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.challenge_id ? { challengeId: result.challenge_id } : {}),
    };
  }

  /** Exchange a magic-link token for access + refresh tokens. */
  async verifyMagicLink(projectId: string, token: string): Promise<MagicLinkVerifyResult> {
    assertNonEmptyString(token, "token", "verifying magic link");
    const project = await requireProjectCredentials(this.client, projectId, "verifying magic link");

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

  /** Exchange an opaque challenge handle plus a six-digit code. Never auto-retried. */
  async verifyEmailCode(projectId: string, opts: EmailCodeVerifyOptions): Promise<MagicLinkVerifyResult> {
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      throw new LocalError(
        "r.auth.verifyEmailCode(projectId, opts) requires { challengeId, code }",
        "verifying email code",
      );
    }
    if (typeof opts.challengeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opts.challengeId)) {
      throw new LocalError("challengeId must be a UUID.", "verifying email code");
    }
    if (typeof opts.code !== "string" || !/^\d{6}$/.test(opts.code)) {
      throw new LocalError("code must be exactly six digits.", "verifying email code");
    }
    const project = await requireProjectCredentials(this.client, projectId, "verifying email code");
    return this.client.request<MagicLinkVerifyResult>("/auth/v1/token?grant_type=email_code", {
      method: "POST",
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      body: { challenge_id: opts.challengeId, code: opts.code },
      context: "verifying email code",
    });
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
    const project = await requireProjectCredentials(this.client, projectId, "setting user password");

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
    const project = await requireProjectCredentials(this.client, projectId, "updating auth settings");

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
    const project = await requireProjectCredentials(this.client, projectId, "creating auth user");

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
    const project = await requireProjectCredentials(this.client, projectId, "creating passkey registration options");

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
    const project = await requireProjectCredentials(this.client, projectId, "verifying passkey registration");

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
    const project = await requireProjectCredentials(this.client, projectId, "creating passkey login options");

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
    const project = await requireProjectCredentials(this.client, projectId, "verifying passkey login");

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
    const project = await requireProjectCredentials(this.client, projectId, "listing passkeys");

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
    const project = await requireProjectCredentials(this.client, projectId, "deleting passkey");

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
  async providers(projectId: string): Promise<AuthProvidersResult> {
    const project = await requireProjectCredentials(this.client, projectId, "listing auth providers");

    const result = await this.client.request<Omit<AuthProvidersResult, "magic_link"> & {
      magic_link: { enabled: boolean; delivery_modes?: EmailAuthDelivery[] };
    }>("/auth/v1/providers", {
      headers: {
        apikey: project.anon_key,
        Authorization: `Bearer ${project.anon_key}`,
      },
      context: "listing auth providers",
      withAuth: false,
    });
    return {
      ...result,
      magic_link: {
        enabled: result.magic_link.enabled,
        deliveryModes: result.magic_link.delivery_modes ?? ["link"],
      },
    };
  }

  /** Promote a user (by email) to `project_admin`. Requires service key. */
  async promote(projectId: string, email: string): Promise<void> {
    const project = await requireProjectCredentials(this.client, projectId, "promoting user");

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
    const project = await requireProjectCredentials(this.client, projectId, "demoting user");

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
