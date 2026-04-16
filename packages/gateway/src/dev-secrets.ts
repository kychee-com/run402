import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

type Env = NodeJS.ProcessEnv;

export type DevSecretSource = {
  envVar: string;
  secretId: string;
  jsonKey?: string;
};

export type DevSecretClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
};

const SECRET_ID_SUFFIX = "_SECRET_ID";
const SECRET_KEY_SUFFIX = "_SECRET_KEY";

const DEFAULT_SECRET_SOURCES: DevSecretSource[] = [
  { envVar: "SELLER_ADDRESS", secretId: "agentdb/seller-wallet", jsonKey: "address" },
  { envVar: "CDP_API_KEY_ID", secretId: "agentdb/cdp-api-key", jsonKey: "key_id" },
  { envVar: "CDP_API_KEY_SECRET", secretId: "agentdb/cdp-api-key", jsonKey: "key_secret" },
  { envVar: "FAUCET_TREASURY_KEY", secretId: "agentdb/faucet-treasury-key" },
  { envVar: "STRIPE_SECRET_KEY", secretId: "eleanor/stripe/prod/secret-key" },
  { envVar: "STRIPE_PRICE_PROTOTYPE", secretId: "agentdb/stripe-price-ids", jsonKey: "prototype" },
  { envVar: "STRIPE_PRICE_HOBBY", secretId: "agentdb/stripe-price-ids", jsonKey: "hobby" },
  { envVar: "STRIPE_PRICE_TEAM", secretId: "agentdb/stripe-price-ids", jsonKey: "team" },
  { envVar: "STRIPE_PRICE_EMAIL_PACK", secretId: "agentdb/stripe-price-ids", jsonKey: "email_pack" },
  { envVar: "TELEGRAM_BOT_TOKEN", secretId: "agentdb/telegram-bot", jsonKey: "bot_token" },
  { envVar: "TELEGRAM_CHAT_ID", secretId: "agentdb/telegram-bot", jsonKey: "chat_id" },
  { envVar: "ADMIN_KEY", secretId: "agentdb/admin-key" },
  { envVar: "OPENROUTER_API_KEY", secretId: "agentdb/openrouter-api-key" },
  { envVar: "MPP_SECRET_KEY", secretId: "agentdb/mpp-secret-key" },
  { envVar: "GOOGLE_APP_CLIENT_ID", secretId: "agentdb/google-app-oauth", jsonKey: "client_id" },
  { envVar: "GOOGLE_APP_CLIENT_SECRET", secretId: "agentdb/google-app-oauth", jsonKey: "client_secret" },
  { envVar: "CLOUDFLARE_API_TOKEN", secretId: "run402/cloudflare-api-token" },
  { envVar: "OPENAI_API_KEY", secretId: "run402/openai-api-key" },
  {
    envVar: "GOOGLE_CLIENT_ID",
    secretId: "arn:aws:secretsmanager:us-east-1:472210437512:secret:agentdb/google-oauth-client-id-LKOTip",
  },
  {
    envVar: "GOOGLE_CLIENT_SECRET",
    secretId: "arn:aws:secretsmanager:us-east-1:472210437512:secret:agentdb/google-oauth-client-secret-ch5Nbj",
  },
  {
    envVar: "ADMIN_SESSION_SECRET",
    secretId: "arn:aws:secretsmanager:us-east-1:472210437512:secret:agentdb/admin-session-secret-TY63qS",
  },
  { envVar: "BASE_MAINNET_RPC_URL", secretId: "run402/base-mainnet-rpc-url" },
  { envVar: "BASE_SEPOLIA_RPC_URL", secretId: "run402/base-sepolia-rpc-url" },
];

function parseJson(secretString: string): unknown {
  try {
    return JSON.parse(secretString);
  } catch {
    return undefined;
  }
}

export function resolveDevSecretSources(env: Env = process.env): DevSecretSource[] {
  const sources = new Map(DEFAULT_SECRET_SOURCES.map((source) => [source.envVar, { ...source }]));

  for (const [key, secretId] of Object.entries(env)) {
    if (!key.endsWith(SECRET_ID_SUFFIX) || !secretId) continue;
    const envVar = key.slice(0, -SECRET_ID_SUFFIX.length);
    const existing = sources.get(envVar);
    const secretKey = env[`${envVar}${SECRET_KEY_SUFFIX}`];
    sources.set(envVar, {
      envVar,
      secretId,
      jsonKey: secretKey || existing?.jsonKey,
    });
  }

  return Array.from(sources.values());
}

export function extractSecretValue(envVar: string, secretString: string, jsonKey?: string): string {
  const trimmed = secretString.trim();
  if (!trimmed) throw new Error(`Secret for ${envVar} is empty`);

  const parsed = parseJson(trimmed);

  if (jsonKey) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Secret for ${envVar} must be a JSON object with key "${jsonKey}"`);
    }
    const value = (parsed as Record<string, unknown>)[jsonKey];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Secret for ${envVar} is missing string key "${jsonKey}"`);
    }
    return value;
  }

  if (typeof parsed === "string") return parsed;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const directValue = record[envVar];
    if (typeof directValue === "string" && directValue.trim()) return directValue;

    const lowercaseValue = record[envVar.toLowerCase()];
    if (typeof lowercaseValue === "string" && lowercaseValue.trim()) return lowercaseValue;

    const stringEntries = Object.entries(record).filter(([, value]) => typeof value === "string" && value.trim());
    if (stringEntries.length === 1) return stringEntries[0][1] as string;

    throw new Error(`Secret for ${envVar} is JSON with multiple fields; set ${envVar}${SECRET_KEY_SUFFIX}`);
  }

  return trimmed;
}

export async function loadDevSecretsFromAws(options: {
  env?: Env;
  client?: DevSecretClient;
  log?: (message: string) => void;
} = {}): Promise<DevSecretSource[]> {
  const env = options.env || process.env;
  const log = options.log || console.log;
  const pendingSources = resolveDevSecretSources(env).filter((source) => !env[source.envVar]);

  if (!pendingSources.length) return [];

  const client = options.client || new SecretsManagerClient({
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  });

  const loaded: DevSecretSource[] = [];
  for (const source of pendingSources) {
    const response = await client.send(new GetSecretValueCommand({ SecretId: source.secretId }));
    if (!response.SecretString) {
      throw new Error(`Secret ${source.secretId} has no SecretString value`);
    }
    env[source.envVar] = extractSecretValue(source.envVar, response.SecretString, source.jsonKey);
    loaded.push(source);
  }

  if (loaded.length) {
    log(`Loaded ${loaded.length} env var(s) from AWS Secrets Manager: ${loaded.map((source) => source.envVar).join(", ")}`);
  }

  return loaded;
}
