/**
 * The secret gate (code-mode MCP, design D5/D6).
 *
 * Every method in `SECRET_RETURNING_METHODS` must refuse on a `sandbox`
 * client with `SECRET_REQUIRES_CLI` BEFORE any request: the fetch below fails
 * the test if it is ever reached. The command in the refusal is the one the
 * registry builds from the call's own arguments, and it never carries a
 * secret the call was handed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { run402 } from "./index.js";
import type { CredentialsProvider } from "../credentials.js";
import { SECRET_RETURNING_METHODS, type SecretReturningMethod } from "../secret-gate.js";
import { isSecretRequiresCli, type SecretRequiresCliError } from "../errors.js";

const PROJECT = "prj_1";
const ORG = "11111111-2222-4333-8444-555555555555";
const WALLET = "0x90F3eB2c9D2b4f3dA6c7a1B2e3F4a5b6C7d8E9F0";
const SESSION = { token: "cp_session_token_secret" };
const PROOFS = { siwx: "siwx-proof", token: "cp_session_token_secret" };

/**
 * Arguments for each registered method that DO carry the secret, so a
 * conditional (`when`) entry is exercised on its gated branch. One row per
 * registry entry; the coverage test below keeps the two in step.
 */
const SAMPLE_ARGS: Record<SecretReturningMethod, unknown[]> = {
  "grants.create": [PROJECT, { wallet: WALLET, capability: "deploy", key: {} }],
  "grants.createKey": [PROJECT, "grant_1", {}],
  "grants.rotateKey": [PROJECT, "key_1"],
  "repos.handoff": [{ project_id: PROJECT, note: { summary: "x" } }],
  "repos.invite": [{ project_id: PROJECT, roomKey: "dev", note: { summary: "x" } }],
  "repos.resume": [{ key: "kgh1_secretsecretsecret" }],
  "repos.join": [{ key: "kgi1_secretsecretsecret" }],
  "rooms.invite": [ORG, "dev", {}],
  "rooms.join": ["kri1_secretsecretsecret"],
  "projects.provision": [{ tier: "prototype", name: "my-app" }],
  "projects.list": [{ all: true, token: "cp_session_token_secret" }],
  "projects.info": [PROJECT],
  "projects.keys": [PROJECT],
  "credentials.projectKeys.import": [PROJECT, { serviceKey: "service_key_secret" }],
  "credentials.projectKeys.export": [PROJECT, { reveal: true }],
  "credentials.issue": [PROJECT, { kind: "service", name: "ci" }],
  "credentials.rotate": [PROJECT, "pcr_1"],
  "credentials.mintToken": [PROJECT, { kind: "service" }],
  "apps.fork": [{ versionId: "ver_1", name: "my-todo" }],
  "branches.create": [PROJECT, {}],
  "admin.transfers.initiate": [{ projectId: PROJECT, toOrgId: ORG }],
  "admin.transfers.accept": ["trn_1"],
  "admin.rotateWebhookSecret": [],
  "wallets.create": [],
  "agent.lightningWallet.mint": [{}],
  "agent.lightningWallet.get": [],
  "agent.lightningWallet.waitForActive": [{}],
  "actions.run": [{ type: "up" }],
  "actions.up": [{}],
  "session.exchangeCliToken": [{ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:1/cb" }],
  "session.devicePoll": ["device_code_1"],
  "session.verifyEmail": [{ token: "magic_link_token_secret" }],
  "session.passkeyVerify": [{ email: "a@example.com", response: {} }],
  "session.consumeRecoveryCode": [{ code: "recovery-code" }],
  "session.whoami": [SESSION],
  "session.refresh": [SESSION],
  "session.revoke": [SESSION],
  "session.enrollPasskeyOptions": [SESSION],
  "session.enrollPasskeyVerify": [{ ...SESSION, response: {} }],
  "session.stepUpOptions": [SESSION],
  "session.stepUpVerify": [{ ...SESSION, response: {} }],
  "session.issueRecoveryCodes": [SESSION],
  "session.listAuthenticators": [SESSION],
  "session.revokeAuthenticator": [{ ...SESSION, id: "auth_1" }],
  "session.sourceAccessWrappers": [SESSION],
  "session.sourceAccessRecoveryBundle": [SESSION],
  "writeApproval.requestChallenge": [{ ...SESSION, action: "project.deploy", project_id: PROJECT }],
  "writeApproval.exchangeClaimCode": [{ claim_code: "c", code_verifier: "v" }],
  "me.overview": [SESSION],
  "me.status": [SESSION],
  "orgs.adopt.challenge": [{ wallet: WALLET, token: "cp_session_token_secret" }],
  "orgs.adopt.submit": [{ siwx: "siwx", token: "cp_session_token_secret" }],
  "admin.channels.connectTelegram": [{}, PROOFS],
  "admin.channels.revokeTelegram": ["tgb_1", PROOFS],
  "admin.rules.create": [{ telegramBindingId: "tgb_1" }, PROOFS],
  "admin.rules.update": ["rule_1", { enabled: false }, PROOFS],
  "admin.rules.delete": ["rule_1", PROOFS],
  "admin.setNotificationPreferences": [{}, PROOFS],
  "auth.verifyMagicLink": [PROJECT, "magic_link_token_secret"],
  "auth.verify": [PROJECT, "magic_link_token_secret"],
  "auth.verifyEmailCode": [PROJECT, { challengeId: "ch_1", code: "042731" }],
  "auth.setUserPassword": [PROJECT, { accessToken: "user_access_token_secret", newPassword: "p" }],
  "auth.setPassword": [PROJECT, { accessToken: "user_access_token_secret", newPassword: "p" }],
  "auth.createPasskeyRegistrationOptions": [PROJECT, { accessToken: "user_access_token_secret", appOrigin: "https://a.test" }],
  "auth.verifyPasskeyRegistration": [PROJECT, { accessToken: "user_access_token_secret", challengeId: "c", response: {} }],
  "auth.verifyPasskeyLogin": [PROJECT, { challengeId: "c", response: {} }],
  "auth.listPasskeys": [PROJECT, { accessToken: "user_access_token_secret" }],
  "auth.deletePasskey": [PROJECT, { accessToken: "user_access_token_secret", passkeyId: "pk_1" }],
  "live.changes": [PROJECT, { tables: ["todos"], as: "user", accessToken: "user_access_token_secret" }],
  "live.subscribe": [PROJECT, { tables: ["todos"], as: "user", accessToken: "user_access_token_secret" }, () => {}],
  "escalations.ackWithToken": ["ack_token_secret"],
  "ci.exchangeToken": [{ project_id: PROJECT, subject_token: "github_oidc_token_secret" }],
};

const noCreds: CredentialsProvider = {
  async getAuth() { return null; },
  async getProject() { return null; },
};

function refusingFetch(reached: string[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    reached.push(String(input));
    throw new Error(`a gated method reached the network: ${String(input)}`);
  }) as typeof globalThis.fetch;
}

function resolveMethod(root: unknown, path: string): { fn: (...args: unknown[]) => unknown; self: unknown } {
  const parts = path.split(".");
  let self: unknown = root;
  for (const part of parts.slice(0, -1)) {
    self = (self as Record<string, unknown>)[part];
    assert.ok(self, `${path}: ${part} is not on the client`);
  }
  const fn = (self as Record<string, unknown>)[parts[parts.length - 1]!];
  assert.equal(typeof fn, "function", `${path} is not a method on the client`);
  return { fn: fn as (...args: unknown[]) => unknown, self };
}

async function callGated(root: unknown, path: string, args: unknown[]): Promise<unknown> {
  const { fn, self } = resolveMethod(root, path);
  // A sync method throws synchronously; an async one rejects. Either is a refusal.
  return await Promise.resolve().then(() => fn.apply(self, args));
}

describe("secret gate: every registered method refuses on a sandbox client before any request", () => {
  it("the sample arguments cover exactly the registry", () => {
    assert.deepEqual(Object.keys(SAMPLE_ARGS).sort(), Object.keys(SECRET_RETURNING_METHODS).sort());
  });

  for (const path of Object.keys(SECRET_RETURNING_METHODS) as SecretReturningMethod[]) {
    it(`${path} throws SECRET_REQUIRES_CLI with the CLI command and never fetches`, async () => {
      const reached: string[] = [];
      const r = run402({ surface: "sandbox", credentials: noCreds, fetch: refusingFetch(reached), apiBase: "https://api.run402.test" });
      const args = SAMPLE_ARGS[path];
      const expected = (SECRET_RETURNING_METHODS[path].command as (...a: unknown[]) => string)(...args);
      await assert.rejects(callGated(r, path, args), (err: unknown) => {
        assert.ok(isSecretRequiresCli(err), `${path}: expected SECRET_REQUIRES_CLI, got ${String((err as Error)?.message ?? err)}`);
        const refusal = err as SecretRequiresCliError;
        assert.equal(refusal.command, expected);
        assert.equal(refusal.nextActions?.length, 1);
        assert.equal(refusal.nextActions?.[0]?.type, "run_cli_command");
        assert.equal(refusal.nextActions?.[0]?.command, expected);
        assert.ok(expected.startsWith("run402 "), `${path}: the command is a run402 CLI line`);
        return true;
      });
      assert.deepEqual(reached, [], `${path} reached the network before refusing`);
    });
  }

  it("no refusal command echoes a secret the call was handed", () => {
    // Every secret in SAMPLE_ARGS ends in `_secret` or repeats `secretsecret`.
    const secretish = /_secret\b|secretsecret/;
    for (const path of Object.keys(SECRET_RETURNING_METHODS) as SecretReturningMethod[]) {
      const command = (SECRET_RETURNING_METHODS[path].command as (...a: unknown[]) => string)(...SAMPLE_ARGS[path]);
      assert.doesNotMatch(command, secretish, `${path}: ${command}`);
    }
  });
});

describe("secret gate: the same calls pass the gate everywhere else", () => {
  it("a cli client sends grants.create with a key to the gateway", async () => {
    const reached: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      reached.push(String(input));
      return new Response(JSON.stringify({ grant: { grant_id: "g" }, key: { key_id: "k", token: "r402gk_x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    for (const surface of ["cli", "mcp", "sdk"] as const) {
      const r = run402({ surface, credentials: noCreds, fetch: fetchImpl, apiBase: "https://api.run402.test" });
      await r.grants.create(PROJECT, { wallet: WALLET, capability: "deploy", key: {} });
    }
    assert.equal(reached.length, 3);
  });

  it("a conditional entry passes on a sandbox client when the secret-bearing option is absent", async () => {
    const reached: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      reached.push(String(input));
      return new Response(JSON.stringify({ grant: { grant_id: "g" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const r = run402({ surface: "sandbox", credentials: noCreds, fetch: fetchImpl, apiBase: "https://api.run402.test" });
    await r.grants.create(PROJECT, { wallet: WALLET, capability: "deploy" });
    assert.equal(reached.length, 1, "a grant without a key carries no secret and is not gated");
  });
});
