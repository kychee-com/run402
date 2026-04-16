import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSecretValue, loadDevSecretsFromAws, resolveDevSecretSources } from "./dev-secrets.js";

describe("resolveDevSecretSources", () => {
  it("applies explicit *_SECRET_ID overrides and additions", () => {
    const env = {
      BASE_MAINNET_RPC_URL_SECRET_ID: "custom/mainnet-rpc",
      BUGSNAG_API_KEY_SECRET_ID: "run402/bugsnag-api-key",
      BUGSNAG_API_KEY_SECRET_KEY: "api_key",
    } as NodeJS.ProcessEnv;

    const sources = resolveDevSecretSources(env);
    const byEnvVar = new Map(sources.map((source) => [source.envVar, source]));

    assert.equal(byEnvVar.get("BASE_MAINNET_RPC_URL")?.secretId, "custom/mainnet-rpc");
    assert.equal(byEnvVar.get("BUGSNAG_API_KEY")?.secretId, "run402/bugsnag-api-key");
    assert.equal(byEnvVar.get("BUGSNAG_API_KEY")?.jsonKey, "api_key");
  });
});

describe("extractSecretValue", () => {
  it("returns a raw string secret as-is", () => {
    assert.equal(extractSecretValue("BASE_MAINNET_RPC_URL", "https://rpc.example"), "https://rpc.example");
  });

  it("extracts a named JSON field", () => {
    assert.equal(
      extractSecretValue("SELLER_ADDRESS", JSON.stringify({ address: "0x1234" }), "address"),
      "0x1234",
    );
  });

  it("uses the only string field when no JSON key is configured", () => {
    assert.equal(
      extractSecretValue("BUGSNAG_API_KEY", JSON.stringify({ api_key: "abcd1234" })),
      "abcd1234",
    );
  });
});

describe("loadDevSecretsFromAws", () => {
  it("loads missing default secrets and skips env vars already set", async () => {
    const env = {
      AWS_REGION: "us-east-1",
      BASE_SEPOLIA_RPC_URL: "https://already-set.example",
    } as NodeJS.ProcessEnv;
    const seenSecretIds: string[] = [];
    const logs: string[] = [];
    const client = {
      send: async (command: { input: { SecretId?: string } }) => {
        const secretId = command.input.SecretId || "";
        seenSecretIds.push(secretId);
        if (secretId === "agentdb/seller-wallet") return { SecretString: JSON.stringify({ address: "0xabc" }) };
        if (secretId === "run402/base-mainnet-rpc-url") return { SecretString: "https://mainnet.example" };
        if (secretId === "run402/base-sepolia-rpc-url") return { SecretString: "https://sepolia.example" };
        if (secretId === "agentdb/cdp-api-key") return { SecretString: JSON.stringify({ key_id: "kid", key_secret: "ksec" }) };
        if (secretId === "agentdb/faucet-treasury-key") return { SecretString: "0xdeadbeef" };
        if (secretId === "eleanor/stripe/prod/secret-key") return { SecretString: "sk_live_123" };
        if (secretId === "agentdb/stripe-price-ids") {
          return { SecretString: JSON.stringify({ prototype: "price_proto", hobby: "price_hobby", team: "price_team", email_pack: "price_email" }) };
        }
        if (secretId === "agentdb/telegram-bot") return { SecretString: JSON.stringify({ bot_token: "bot", chat_id: "chat" }) };
        if (secretId === "agentdb/admin-key") return { SecretString: "admin" };
        if (secretId === "agentdb/openrouter-api-key") return { SecretString: "or-key" };
        if (secretId === "agentdb/mpp-secret-key") return { SecretString: "mpp" };
        if (secretId === "agentdb/google-app-oauth") return { SecretString: JSON.stringify({ client_id: "g-app-id", client_secret: "g-app-secret" }) };
        if (secretId === "run402/cloudflare-api-token") return { SecretString: "cf-token" };
        if (secretId === "run402/openai-api-key") return { SecretString: "openai" };
        if (secretId.includes("google-oauth-client-id")) return { SecretString: "google-admin-id" };
        if (secretId.includes("google-oauth-client-secret")) return { SecretString: "google-admin-secret" };
        if (secretId.includes("admin-session-secret")) return { SecretString: "session-secret" };
        throw new Error(`Unexpected secret lookup: ${secretId}`);
      },
    };

    const loaded = await loadDevSecretsFromAws({
      env,
      client,
      log: (message) => logs.push(message),
    });

    assert.equal(env.SELLER_ADDRESS, "0xabc");
    assert.equal(env.CDP_API_KEY_ID, "kid");
    assert.equal(env.CDP_API_KEY_SECRET, "ksec");
    assert.equal(env.BASE_MAINNET_RPC_URL, "https://mainnet.example");
    assert.equal(env.BASE_SEPOLIA_RPC_URL, "https://already-set.example");
    assert.ok(!seenSecretIds.includes("run402/base-sepolia-rpc-url"));
    assert.ok(loaded.some((source) => source.envVar === "BASE_MAINNET_RPC_URL"));
    assert.equal(logs.length, 1);
  });

  it("supports ad hoc env vars like BUGSNAG_API_KEY via *_SECRET_ID", async () => {
    const env = {
      BUGSNAG_API_KEY_SECRET_ID: "run402/bugsnag-api-key",
      BUGSNAG_API_KEY_SECRET_KEY: "api_key",
    } as NodeJS.ProcessEnv;
    for (const source of resolveDevSecretSources(env)) {
      if (source.envVar !== "BUGSNAG_API_KEY") env[source.envVar] = "already-set";
    }
    const client = {
      send: async () => ({ SecretString: JSON.stringify({ api_key: "bugsnag-dev-key" }) }),
    };

    await loadDevSecretsFromAws({ env, client, log: () => {} });

    assert.equal(env.BUGSNAG_API_KEY, "bugsnag-dev-key");
  });
});
