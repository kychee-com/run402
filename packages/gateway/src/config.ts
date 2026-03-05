export const PORT = parseInt(process.env.PORT || "4022", 10);
export const JWT_SECRET = process.env.JWT_SECRET || "super-secret-jwt-key-for-agentdb-test-only-32chars!!";
export const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}`;
export const TESTNET_FACILITATOR_URL = process.env.TESTNET_FACILITATOR_URL || "https://x402.org/facilitator";
export const MAINNET_NETWORK = process.env.MAINNET_NETWORK || "eip155:8453"; // Base mainnet
export const TESTNET_NETWORK = process.env.TESTNET_NETWORK || "eip155:84532"; // Base Sepolia
export const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || "";
export const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || "";
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
export const FACILITATOR_PROVIDER = process.env.FACILITATOR_PROVIDER || "cdp"; // "cdp" | "stripe"
export const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://www.x402.org/facilitator";
export const POSTGREST_URL = process.env.POSTGREST_URL || "http://localhost:3000";
export const MAX_SCHEMA_SLOTS = parseInt(process.env.MAX_SCHEMA_SLOTS || "2000", 10);

// S3 config
export const S3_BUCKET = process.env.S3_BUCKET || "";
export const S3_REGION = process.env.S3_REGION || "us-east-1";

// Rate limiting
export const RATE_LIMIT_PER_SEC = parseInt(process.env.RATE_LIMIT_PER_SEC || "100", 10);

// Lease grace periods (ms)
export const LEASE_GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days read-only after expiry
export const LEASE_DELETE_PERIOD = 37 * 24 * 60 * 60 * 1000; // 37 days after expiry (7d grace + 30d archive)

// Metering flush interval (ms)
export const METERING_FLUSH_INTERVAL = 60_000; // 60s

// Faucet config
export const FAUCET_TREASURY_KEY = process.env.FAUCET_TREASURY_KEY || "";
export const FAUCET_DRIP_AMOUNT = process.env.FAUCET_DRIP_AMOUNT || "0.25";
export const FAUCET_DRIP_COOLDOWN = parseInt(process.env.FAUCET_DRIP_COOLDOWN || "86400000", 10); // 24h
export const FAUCET_REFILL_INTERVAL = parseInt(process.env.FAUCET_REFILL_INTERVAL || "8640000", 10); // ~2.4h

// Telegram notifications
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Lambda / Functions config
export const LAMBDA_ROLE_ARN = process.env.LAMBDA_ROLE_ARN || "";
export const LAMBDA_LAYER_ARN = process.env.LAMBDA_LAYER_ARN || "";
export const LAMBDA_SUBNET_IDS = process.env.LAMBDA_SUBNET_IDS || "";
export const LAMBDA_SG_ID = process.env.LAMBDA_SG_ID || "";
export const FUNCTIONS_LOG_GROUP = process.env.FUNCTIONS_LOG_GROUP || "/agentdb/functions";
