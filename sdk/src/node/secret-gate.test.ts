/**
 * The secret gate (code-mode MCP, design D5/D6).
 *
 * Runtime half: every method in `SECRET_RETURNING_METHODS` must refuse on a
 * `sandbox` client with `SECRET_REQUIRES_CLI` BEFORE any request: the fetch
 * below fails the test if it is ever reached. The command in the refusal is
 * the one the registry builds from the call's own arguments, and it never
 * carries a secret the call was handed.
 *
 * Drift half: this file owns the inventory. It type-checks the Node SDK
 * entry, walks every namespace reachable from the `NodeRun402` client, and
 * reads each public method's parameter and result types (the `*.types.ts`
 * interfaces they are built from included). A method whose types carry a
 * field matching the secret-name list and that no registry entry names fails
 * the build, so a new secret-bearing field cannot ship ungated.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  "wallets.create": ["ci"],
  "wallets.import": ["ci", "0x_private_key_secret"],
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

// ── Drift half ──────────────────────────────────────────────────────────────

/**
 * The secret-name list (design D5), matched against every property name in a
 * method's parameter and result types and against its positional parameter
 * names, after camelCase is folded to snake_case: `service_key`,
 * `private_key`, `secret`, `token`, `pairing`, `preimage`, `handoff_key`,
 * `invite_key`, and any other `*_key` except `anon_key`; `*_secret` and
 * `*_token` are the same words in compound names (`webhook_signing_secret`,
 * `control_plane_session_token`). Boolean-typed fields (`has_anon_key`) name
 * a fact about a key, not the key, and are skipped.
 */
export function isSecretFieldName(raw: string): boolean {
  const name = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (NOT_SECRET_FIELD_NAMES.has(name)) return false;
  if (["service_key", "private_key", "secret", "token", "pairing", "preimage", "handoff_key", "invite_key"].includes(name)) return true;
  if (name === "anon_key") return false;
  return name.endsWith("_key") || name.endsWith("_secret") || name.endsWith("_token");
}

/**
 * Field names the pattern matches that are never a credential, wherever they
 * appear. Each is a label, a public value, or a request-dedup handle.
 */
const NOT_SECRET_FIELD_NAMES = new Set([
  "idempotency_key", // request dedup handle, chosen by the caller
  "client_idempotency_key", // the same, for a vault epoch rotation
  "reuse_idempotency_key", // a next action's hint to replay with the same dedup handle
  "room_key", // a room's label
  "app_key", // an app install-state label
  "by_key", // an asset manifest's map keyed by asset key
  "ensure_key", // an app-graph node's dedup label
  "session_key", // the opaque per-session presence identity, never an authority
  "public_key", // public by construction
  "service_public_key", // the vault service's public key
]);

/**
 * One field at one path in one method's types that the pattern matches and is
 * not a credential there. Keyed `<method> <in|out> <path>`, each with the
 * reason it is safe to hand a snippet.
 */
const NOT_SECRET_PATHS: Record<string, string> = {
  "wallets.faucet out =>.token": "the token SYMBOL (\"USDC\") the faucet sent",
  "domains.testReceive out =>.receive_test.token": "the nonce an inbound test email carries to be matched, not a credential",
  "credentials.status out =>.legacy_key": "the retiring key's label (\"k0\"), never its value",
  "snapshots.restorePlan out =>.restore_plan.confirm.token": "a single-use confirmation handle for this restore plan, not a credential",
  "repos.acquireMaintenanceLease out =>.holder_token": "the fencing handle of one maintenance lease on one vault, useless outside it",
  "repos.deploy out =>.activation_token": "a signed, public vault object recording the activation",
  "repos.recover out =>.member_recovery.bundle_key": "the storage key NAME of the bundle sidecar that opened, not key material",
  "session.sourceAccessWrappers out =>.encryption_key": "the member's public encryption-key record (its `public_key`, fingerprint, suite)",
};

const SKIPPED_PROPERTIES = new Set(["sdk", "client", "parent", "idempotency", "capabilities"]);
const OPAQUE_TYPES = new Set([
  "Promise", "Array", "ReadonlyArray", "Map", "Set", "Uint8Array", "Date", "Function", "AsyncIterable",
  "AsyncIterableIterator", "AsyncGenerator", "Response", "Headers", "Request", "AbortSignal", "ReadableStream", "Blob", "URL",
]);

interface SecretHit { method: string; where: string }

function scanNodeClientForSecretFields(exempt: (key: string) => boolean = (key) => NOT_SECRET_PATHS[key] !== undefined): SecretHit[] {
  const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const configPath = join(sdkRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, sdkRoot);
  const entry = join(sdkRoot, "src", "node", "index.ts");
  const program = ts.createProgram({ rootNames: [entry], options: parsed.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  assert.ok(source, "the Node SDK entry type-checks");
  const moduleSymbol = checker.getSymbolAtLocation(source!);
  const nodeRun402 = checker.getExportsOfModule(moduleSymbol!).find((sym) => sym.name === "NodeRun402");
  assert.ok(nodeRun402, "NodeRun402 is exported from the Node entry");

  const isClassInstance = (type: ts.Type): boolean => Boolean(type.getSymbol() && (type.getSymbol()!.flags & ts.SymbolFlags.Class));
  const declOf = (sym: ts.Symbol): ts.Declaration | undefined => sym.valueDeclaration ?? sym.declarations?.[0];
  const isPublic = (decl: ts.Declaration): boolean =>
    (ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0;

  /**
   * The first secret-named field reachable in `type`, as a dotted path, or
   * null. `exempt(path)` names a path that is not a credential; the search
   * continues past it, so an exemption never hides a sibling secret.
   */
  function findSecret(type: ts.Type, depth: number, seen: Set<ts.Type>, path: string[], exempt: (where: string) => boolean): string | null {
    if (depth > 6 || seen.has(type)) return null;
    seen.add(type);
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) {
        const hit = findSecret(member, depth, seen, path, exempt);
        if (hit) return hit;
      }
      return null;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return null;
    const symbol = type.getSymbol();
    const typeArgs = (type as ts.TypeReference).target ? checker.getTypeArguments(type as ts.TypeReference) : [];
    for (const arg of typeArgs) {
      const hit = findSecret(arg, depth + 1, seen, path, exempt);
      if (hit) return hit;
    }
    if (symbol && OPAQUE_TYPES.has(symbol.name)) return null;
    if (type.getCallSignatures().length > 0 || isClassInstance(type)) return null;
    for (const prop of type.getProperties()) {
      const decl = declOf(prop);
      if (!decl) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      if (propType.getCallSignatures().length > 0) continue;
      if (propType.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) continue;
      const here = [...path, prop.name];
      if (isSecretFieldName(prop.name) && !exempt(here.join("."))) return here.join(".");
      const hit = findSecret(propType, depth + 1, seen, here, exempt);
      if (hit) return hit;
    }
    return null;
  }

  const hits: SecretHit[] = [];
  const record = (method: string, where: string) => hits.push({ method, where });

  function walk(type: ts.Type, prefix: string, depth: number): void {
    for (const prop of type.getProperties()) {
      if (prop.name.startsWith("_") || prop.name.startsWith("#") || SKIPPED_PROPERTIES.has(prop.name)) continue;
      const decl = declOf(prop);
      if (!decl || !isPublic(decl)) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      const path = prefix ? `${prefix}.${prop.name}` : prop.name;
      const signatures = propType.getCallSignatures();
      if (signatures.length > 0) {
        for (const signature of signatures) {
          const exemptIn = (where: string) => exempt(`${path} in ${where}`);
          const exemptOut = (where: string) => exempt(`${path} out ${where}`);
          for (const param of signature.getParameters()) {
            if (isSecretFieldName(param.name) && !exempt(`${path} param ${param.name}`)) {
              record(path, `param ${param.name}`);
              continue;
            }
            const paramType = checker.getTypeOfSymbolAtLocation(param, declOf(param) ?? decl);
            const hit = findSecret(paramType, 0, new Set(), [`(${param.name})`], exemptIn);
            if (hit) record(path, `in ${hit}`);
          }
          const hit = findSecret(signature.getReturnType(), 0, new Set(), ["=>"], exemptOut);
          if (hit) record(path, `out ${hit}`);
        }
      } else if (depth < 3 && isClassInstance(propType)) {
        walk(propType, path, depth + 1);
      }
    }
  }

  walk(checker.getDeclaredTypeOfSymbol(nodeRun402!), "", 0);
  return hits;
}

describe("secret gate: the registry owns every secret-bearing method (drift)", () => {
  it("the secret-name list matches the design's names and a new compound field", () => {
    for (const name of ["service_key", "serviceKey", "private_key", "privateKey", "secret", "token", "pairing", "preimage", "handoff_key", "invite_key", "pairing_secret", "webhook_signing_secret", "control_plane_session_token", "write_approval_token", "access_token", "api_key"]) {
      assert.equal(isSecretFieldName(name), true, name);
    }
    for (const name of ["anon_key", "has_anon_key_label", "idempotencyKey", "room_key", "public_key", "token_type", "tokens_used", "key_id", "secrets"]) {
      assert.equal(isSecretFieldName(name), false, name);
    }
  });

  it("every method whose types carry a secret-named field is registered", () => {
    const hits = scanNodeClientForSecretFields();
    const seen = new Set(hits.map((hit) => hit.method));
    for (const known of ["grants.create", "repos.handoff", "projects.keys", "agent.lightningWallet.mint", "credentials.issue"]) {
      assert.ok(seen.has(known), `the scan sees ${known}'s secret field (a vacuous scan would pass everything)`);
    }
    const registered = new Set(Object.keys(SECRET_RETURNING_METHODS));
    const unregistered = hits
      .filter((hit) => !registered.has(hit.method))
      .map((hit) => `${hit.method} (${hit.where})`);
    assert.deepEqual(
      [...new Set(unregistered)],
      [],
      "These SDK methods return or take a secret-named field but are not in SECRET_RETURNING_METHODS " +
        "(sdk/src/secret-gate.ts). Gate each with gateSecret() and register its CLI command, " +
        "or, when the field is not a credential, add it to NOT_SECRET_FIELD_NAMES / NOT_SECRET_PATHS here with the reason.",
    );
  });

  it("every exemption still names a field the scan would otherwise flag", () => {
    // An exemption for a path that no longer exists is dead weight that could
    // hide a future field of the same name; keep the list honest.
    const hits = scanNodeClientForSecretFieldsUnfiltered();
    for (const key of Object.keys(NOT_SECRET_PATHS)) {
      assert.ok(hits.has(key), `NOT_SECRET_PATHS entry no longer matches anything: ${key}`);
    }
  });
});

function scanNodeClientForSecretFieldsUnfiltered(): Set<string> {
  return new Set(scanNodeClientForSecretFields(() => false).map((hit) => `${hit.method} ${hit.where}`));
}
