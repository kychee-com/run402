/**
 * The secret gate: every SDK method whose result carries a one-time secret the
 * caller would otherwise receive (a grant key, a Handoff or Invite Key, a Room
 * Invite Key, project credentials, a private key, a Lightning pairing, a
 * sign-in session or write-approval token), or whose input IS such a bearer
 * secret, calls {@link gateSecret} as its first statement. On a client whose
 * `capabilities.returnSecrets` is false — the `sandbox` surface an MCP `run`
 * snippet executes on — that call throws `SECRET_REQUIRES_CLI` before any
 * request, naming the exact CLI command for the same operation. On every
 * other surface it is a no-op.
 *
 * The gate is the method itself, keyed on a client capability: there is no
 * tool-name denylist and no path filter anywhere else, so every future door
 * that builds a `sandbox` client inherits it for free.
 *
 * {@link SECRET_RETURNING_METHODS} is the registry: one entry per gated
 * method (by its dotted path from the client root), with the command builder
 * and, for a method that carries a secret only when a particular option is
 * supplied, the predicate that says so. `sdk/src/node/secret-gate.test.ts`
 * owns the inventory: it fails when a method's types carry a secret-named
 * field and no entry names it, and when a registered method reaches the
 * network on a `sandbox` client.
 *
 * A command never embeds a secret value: where the input is the secret, the
 * command carries its placeholder (`<kgh1_…>`), never the key.
 */

import type { Client } from "./kernel.js";
import { SecretRequiresCliError } from "./errors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = any[];

export interface SecretGateEntry {
  /** The exact CLI command line for the same operation, built from the call's own arguments. */
  command: (...args: Args) => string;
  /** When present, the call is gated only when this returns true (the secret-bearing option was supplied). */
  when?: (...args: Args) => boolean;
  /** Why the operation belongs to the CLI; defaults to the generic one-time-secret sentence. */
  why?: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
/** Quote a shell word only when it needs it. */
const word = (v: string): string => (/^[A-Za-z0-9_./:=@+,-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);
/** A caller-supplied value as a shell word, or the placeholder (never quoted) when absent. */
const arg = (v: unknown, placeholder: string): string => {
  const s = str(v);
  return s ? word(s) : placeholder;
};
const projectFlag = (projectId: unknown): string => {
  const id = str(projectId);
  return id ? ` --project ${word(id)}` : "";
};
const orgFlag = (orgId: unknown): string => {
  const id = str(orgId);
  return id ? ` --org ${word(id)}` : "";
};
const vaultFlags = (opts: unknown): string => {
  const o = obj(opts);
  const repo = str(o.repo_id);
  return `${projectFlag(o.project_id)}${repo ? ` --repo ${word(repo)}` : ""}`;
};
const hasToken = (opts: unknown): boolean => Boolean(str(obj(opts).token));
/** A wallet name only when it is plainly one; anything else (a pasted key) becomes the placeholder. */
const walletName = (v: unknown): string => {
  const s = str(v);
  return s && s.length <= 40 && /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s : "<name>";
};

const SIGN_IN_WHY = "A sign-in session token is a person's credential; the CLI holds it for them.";
const PROJECT_KEYS_WHY = "Project keys are credentials; the CLI stores them in the local key cache without handing them to a snippet.";

/**
 * Every gated method, by its dotted path from the client root. The command is
 * the CLI line for the same operation; the drift test calls each one on a
 * `sandbox` client and requires the refusal before any request.
 */
export const SECRET_RETURNING_METHODS = {
  // ── grants: a grant key's bearer prints once ────────────────────────────
  "grants.create": {
    when: (_projectId: unknown, input: unknown) => obj(input).key != null && obj(input).key !== false,
    command: (projectId: unknown, input: unknown) => {
      const i = obj(input);
      return `run402 grants create ${arg(i.wallet, "<wallet>")} --capability ${arg(i.capability, "<capability>")} --key${projectFlag(projectId)}`;
    },
    why: "A grant key's bearer is returned once; the CLI prints it to the person who will hand it on.",
  },
  "grants.createKey": {
    command: (projectId: unknown) => `run402 grants create <wallet> --capability <capability> --key${projectFlag(projectId)}`,
    why: "A grant key's bearer is returned once; the CLI mints keys by issuing the grant with --key.",
  },
  "grants.rotateKey": {
    command: (projectId: unknown, keyId: unknown) => `run402 grants rotate-key ${arg(keyId, "<key_id>")}${projectFlag(projectId)}`,
    why: "The rotated grant key's bearer is returned once; the CLI prints it to the person who will hand it on.",
  },

  // ── KyGit: Handoff and Invite Keys ───────────────────────────────────────
  "repos.handoff": { command: (opts: unknown) => `run402 repos handoff${vaultFlags(opts)}` },
  "repos.invite": {
    command: (opts: unknown) => {
      const room = str(obj(opts).roomKey);
      return `run402 repos invite${vaultFlags(opts)}${room ? ` --room ${word(room)}` : ""}`;
    },
  },
  "repos.resume": { command: () => "run402 repos resume <kgh1_…>", why: "A Handoff Key is a bearer secret; redeem it from the CLI so it never enters a snippet." },
  "repos.join": { command: () => "run402 repos join <kgi1_…>", why: "An Invite Key is a bearer secret; redeem it from the CLI so it never enters a snippet." },

  // ── rooms: Room Invite Keys ──────────────────────────────────────────────
  "rooms.invite": {
    command: (orgId: unknown, roomKey: unknown) => {
      const room = str(roomKey);
      return `run402 rooms invite${orgFlag(orgId)}${room ? ` --room ${word(room)}` : ""}`;
    },
  },
  "rooms.join": { command: () => "run402 rooms join <kri1_…>", why: "A Room Invite Key is a bearer secret; redeem it from the CLI so it never enters a snippet." },

  // ── projects and their credentials ───────────────────────────────────────
  "projects.provision": {
    command: (opts: unknown) => {
      const o = obj(opts);
      const name = str(o.name);
      const tier = str(o.tier);
      return `run402 projects provision${tier ? ` --tier ${word(tier)}` : ""}${name ? ` --name ${word(name)}` : ""}`;
    },
    why: PROJECT_KEYS_WHY,
  },
  "projects.list": {
    when: (opts: unknown) => hasToken(opts),
    command: () => "run402 projects list --all",
    why: SIGN_IN_WHY,
  },
  "projects.info": { command: (id: unknown) => `run402 credentials project-keys status${projectFlag(id)}`, why: PROJECT_KEYS_WHY },
  "projects.keys": { command: (id: unknown) => `run402 credentials project-keys export${projectFlag(id)} --reveal`, why: PROJECT_KEYS_WHY },
  "credentials.projectKeys.import": {
    command: (projectId: unknown) => `run402 credentials project-keys import${projectFlag(projectId)} --service-key-stdin`,
    why: PROJECT_KEYS_WHY,
  },
  "credentials.projectKeys.export": { command: (projectId: unknown) => `run402 credentials project-keys export${projectFlag(projectId)} --reveal`, why: PROJECT_KEYS_WHY },
  "credentials.issue": {
    command: (projectId: unknown, input: unknown) => {
      const i = obj(input);
      return `run402 credentials issue --kind ${arg(i.kind, "<anon|service>")} --name ${arg(i.name, "<name>")}${projectFlag(projectId)}`;
    },
    why: "A project credential's secret is returned once.",
  },
  "credentials.rotate": {
    command: (projectId: unknown, credentialId: unknown) => `run402 credentials rotate ${arg(credentialId, "<credential_id>")}${projectFlag(projectId)}`,
    why: "The rotated credential's secret is returned once.",
  },
  "credentials.mintToken": {
    command: (projectId: unknown, opts: unknown) => {
      const kind = str(obj(opts).kind);
      return `run402 credentials token${projectFlag(projectId)}${kind ? ` --kind ${word(kind)}` : ""}`;
    },
    why: "A project token is a bearer credential.",
  },
  "apps.fork": {
    command: (opts: unknown) => {
      const o = obj(opts);
      const sub = str(o.subdomain);
      return `run402 apps fork ${arg(o.versionId, "<version_id>")} ${arg(o.name, "<name>")}${sub ? ` --subdomain ${word(sub)}` : ""}`;
    },
    why: PROJECT_KEYS_WHY,
  },
  "branches.create": { command: (projectId: unknown) => `run402 branches create${projectFlag(projectId)}`, why: PROJECT_KEYS_WHY },
  "admin.transfers.initiate": {
    when: (input: unknown) => Boolean(str(obj(input).toOrgId)),
    command: (input: unknown) => {
      const i = obj(input);
      return `run402 transfer init --to-org ${arg(i.toOrgId, "<org_id>")}${projectFlag(i.projectId)}`;
    },
    why: PROJECT_KEYS_WHY,
  },
  "admin.transfers.accept": {
    command: (transferId: unknown) => `run402 transfer accept ${arg(transferId, "<transfer_id>")}`,
    why: PROJECT_KEYS_WHY,
  },
  "admin.rotateWebhookSecret": {
    command: () => "run402 webhook-secret rotate",
    why: "The new webhook signing secret is returned once.",
  },

  // ── the local wallet ─────────────────────────────────────────────────────
  "wallets.create": {
    command: (name: unknown) => (str(name) ? `run402 wallets new ${walletName(name)}` : "run402 init"),
    why: "Creating a wallet writes a private key; the CLI creates wallets for a person.",
  },
  "wallets.import": {
    command: (name: unknown) => `run402 wallets import ${walletName(name)} --key <path|->`,
    why: "Importing a wallet hands over a private key; read it from a file or stdin in the CLI, never from a snippet.",
  },
  "agent.lightningWallet.mint": { command: () => "run402 init lightning", why: "The Lightning wallet's pairing secret is returned once." },
  "agent.lightningWallet.get": { command: () => "run402 wallets lightning status", why: "The first read of an active Lightning wallet hands out its pairing secret." },
  "agent.lightningWallet.waitForActive": { command: () => "run402 init lightning", why: "The first read of an active Lightning wallet hands out its pairing secret." },

  "init": {
    when: (opts: unknown) => obj(opts).rail === "lightning",
    command: () => "run402 init lightning",
    why: "The Lightning wallet's pairing secret is returned once and stored beside the wallet key.",
  },

  // ── actions that provision and hand back project keys ────────────────────
  "actions.run": {
    when: (input: unknown) => obj(input).type !== "tier.set",
    command: (input: unknown) => (obj(input).type === "projects.provision" ? "run402 projects provision" : "run402 up"),
    why: "up and project provisioning hand back project keys; run them from the CLI or the MCP up tool.",
  },
  "actions.up": { command: () => "run402 up", why: "up provisions projects and handles their keys; run it from the CLI or the MCP up tool." },

  // ── a person's sign-in session and write approvals ───────────────────────
  "session.exchangeCliToken": { command: () => "run402 login", why: SIGN_IN_WHY },
  "session.devicePoll": { command: () => "run402 login --device", why: SIGN_IN_WHY },
  "session.verifyEmail": { command: () => "run402 login", why: SIGN_IN_WHY },
  "session.passkeyVerify": { command: () => "run402 login", why: SIGN_IN_WHY },
  "session.consumeRecoveryCode": { command: () => "run402 login", why: SIGN_IN_WHY },
  "session.whoami": { when: hasToken, command: () => "run402 whoami", why: SIGN_IN_WHY },
  "session.refresh": { command: () => "run402 login", why: SIGN_IN_WHY },
  "session.revoke": { when: hasToken, command: () => "run402 logout", why: SIGN_IN_WHY },
  "session.enrollPasskeyOptions": { when: hasToken, command: () => "run402 login", why: SIGN_IN_WHY },
  "session.enrollPasskeyVerify": { when: hasToken, command: () => "run402 login", why: SIGN_IN_WHY },
  "session.stepUpOptions": { when: hasToken, command: () => "run402 login", why: SIGN_IN_WHY },
  "session.stepUpVerify": { when: hasToken, command: () => "run402 login", why: SIGN_IN_WHY },
  "session.issueRecoveryCodes": { command: () => "run402 login", why: "Recovery codes are shown once." },
  "session.listAuthenticators": { when: hasToken, command: () => "run402 whoami", why: SIGN_IN_WHY },
  "session.revokeAuthenticator": { when: hasToken, command: () => "run402 login", why: SIGN_IN_WHY },
  "session.sourceAccessWrappers": { when: hasToken, command: () => "run402 repos recovery-bundle", why: SIGN_IN_WHY },
  "session.sourceAccessRecoveryBundle": { when: hasToken, command: () => "run402 repos recovery-bundle", why: SIGN_IN_WHY },
  "writeApproval.requestChallenge": { command: () => "run402 approve", why: "A write approval is a person's passkey-signed credential." },
  "writeApproval.exchangeClaimCode": { command: () => "run402 approve", why: "A write approval is a person's passkey-signed credential." },
  "me.overview": { when: hasToken, command: () => "run402 orgs list", why: SIGN_IN_WHY },
  "me.status": { when: hasToken, command: () => "run402 whoami", why: SIGN_IN_WHY },
  "orgs.adopt.challenge": { when: hasToken, command: () => "run402 orgs adopt", why: SIGN_IN_WHY },
  "orgs.adopt.submit": { when: hasToken, command: () => "run402 orgs adopt", why: SIGN_IN_WHY },
  "admin.channels.connectTelegram": { when: (_opts: unknown, proofs: unknown) => hasToken(proofs), command: () => "run402 contacts connect telegram", why: SIGN_IN_WHY },
  "admin.channels.revokeTelegram": { when: (_id: unknown, proofs: unknown) => hasToken(proofs), command: (id: unknown) => `run402 contacts rm ${arg(id, "<binding_id>")}`, why: SIGN_IN_WHY },
  "admin.rules.create": { when: (_i: unknown, proofs: unknown) => hasToken(proofs), command: () => "run402 subscriptions add", why: SIGN_IN_WHY },
  "admin.rules.update": { when: (_id: unknown, _p: unknown, proofs: unknown) => hasToken(proofs), command: () => "run402 subscriptions add", why: SIGN_IN_WHY },
  "admin.rules.delete": { when: (_id: unknown, proofs: unknown) => hasToken(proofs), command: (id: unknown) => `run402 subscriptions rm ${arg(id, "<rule_id>")}`, why: SIGN_IN_WHY },
  "admin.setNotificationPreferences": { when: (_p: unknown, proofs: unknown) => hasToken(proofs), command: () => "run402 contacts preferences", why: SIGN_IN_WHY },

  // ── project end users' session tokens (the project's own auth) ───────────
  "auth.verifyMagicLink": { command: (projectId: unknown) => `run402 auth verify --token <token>${projectFlag(projectId)}`, why: "The end user's access token is returned once." },
  "auth.verify": { command: (projectId: unknown) => `run402 auth verify --token <token>${projectFlag(projectId)}`, why: "The end user's access token is returned once." },
  "auth.verifyEmailCode": {
    command: (projectId: unknown, opts: unknown) => {
      const challenge = str(obj(opts).challengeId);
      return `run402 auth verify --challenge-id ${word(challenge ?? "<challenge_id>")} --code <code>${projectFlag(projectId)}`;
    },
    why: "The end user's access token is returned once.",
  },
  "auth.setUserPassword": { command: (projectId: unknown) => `run402 auth set-password --token <bearer> --new <password>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "auth.setPassword": { command: (projectId: unknown) => `run402 auth set-password --token <bearer> --new <password>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "auth.createPasskeyRegistrationOptions": { command: (projectId: unknown) => `run402 auth passkey-register-options --token <bearer> --app-origin <origin>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "auth.verifyPasskeyRegistration": { command: (projectId: unknown) => `run402 auth passkey-register-verify --token <bearer>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "auth.verifyPasskeyLogin": { command: (projectId: unknown) => `run402 auth passkey-login-verify${projectFlag(projectId)}`, why: "The end user's access token is returned once." },
  "auth.listPasskeys": { command: (projectId: unknown) => `run402 auth passkeys --token <bearer>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "auth.deletePasskey": { command: (projectId: unknown) => `run402 auth delete-passkey --token <bearer>${projectFlag(projectId)}`, why: "An end user's access token is a bearer credential." },
  "live.changes": {
    when: (_projectId: unknown, opts: unknown) => obj(opts).as === "user",
    command: (projectId: unknown, opts: unknown) => `run402 live --tables ${arg((obj(opts).tables ?? []).join(","), "<a,b>")}${projectFlag(projectId)}`,
    why: "An end user's access token is a bearer credential.",
  },
  "live.subscribe": {
    when: (_projectId: unknown, opts: unknown) => obj(opts).as === "user",
    command: (projectId: unknown, opts: unknown) => `run402 live --tables ${arg((obj(opts).tables ?? []).join(","), "<a,b>")}${projectFlag(projectId)}`,
    why: "An end user's access token is a bearer credential.",
  },

  // ── bearer inputs from outside ───────────────────────────────────────────
  "escalations.ackWithToken": {
    command: () => "run402 escalations ack <escalation_id>",
    why: "An acknowledgement token is a bearer secret from a notification; acknowledge by id instead.",
  },
  "ci.exchangeToken": {
    command: () => "run402 ci link github",
    why: "The GitHub OIDC exchange mints a Run402 CI session inside GitHub Actions; link the repository from the CLI.",
  },
} satisfies Record<string, SecretGateEntry>;

export type SecretReturningMethod = keyof typeof SECRET_RETURNING_METHODS;

/** Dotted path → entry, typed loosely for callers that look methods up by string. */
export const SECRET_GATE_REGISTRY: Readonly<Record<string, SecretGateEntry>> = SECRET_RETURNING_METHODS;

/**
 * Refuse this call before any request when the client may not return
 * secrets. The first statement of every registered method. The command is
 * built only on refusal, so the check costs nothing on the permissive path.
 */
export function gateSecret(
  client: { readonly capabilities?: Readonly<Client["capabilities"]>; assertSecretReturn?: Client["assertSecretReturn"] },
  method: SecretReturningMethod,
  ...args: Args
): void {
  if (client.capabilities?.returnSecrets !== false) return;
  const entry: SecretGateEntry = SECRET_GATE_REGISTRY[method]!;
  if (entry.when && !entry.when(...args)) return;
  const refusal = { command: entry.command(...args), ...(entry.why ? { why: entry.why } : {}) };
  if (client.assertSecretReturn) client.assertSecretReturn(refusal);
  throw new SecretRequiresCliError(refusal.command, refusal.why);
}
