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
export const BILLING_MAILBOX_ID = process.env.BILLING_MAILBOX_ID || "";
// Stripe price IDs for tier + email pack products
export const STRIPE_PRICE_PROTOTYPE = process.env.STRIPE_PRICE_PROTOTYPE || "";
export const STRIPE_PRICE_HOBBY = process.env.STRIPE_PRICE_HOBBY || "";
export const STRIPE_PRICE_TEAM = process.env.STRIPE_PRICE_TEAM || "";
export const STRIPE_PRICE_EMAIL_PACK = process.env.STRIPE_PRICE_EMAIL_PACK || "";
export const FACILITATOR_PROVIDER = process.env.FACILITATOR_PROVIDER || "cdp"; // "cdp" | "stripe"
export const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://www.x402.org/facilitator";
export const POSTGREST_URL = process.env.POSTGREST_URL || "http://localhost:3000";
export const MAX_SCHEMA_SLOTS = parseInt(process.env.MAX_SCHEMA_SLOTS || "2000", 10);

// S3 config
export const S3_BUCKET = process.env.S3_BUCKET || "";
export const S3_REGION = process.env.S3_REGION || "us-east-1";

// Inbound email S3 bucket (raw RFC-822 bytes written by the inbound Lambda)
export const INBOUND_EMAIL_BUCKET = process.env.INBOUND_EMAIL_BUCKET || "";

// Rate limiting
export const RATE_LIMIT_PER_SEC = parseInt(process.env.RATE_LIMIT_PER_SEC || "100", 10);

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

// Admin key (for privileged operations like pin/unpin)
export const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Lifecycle state machine (past_due → frozen → dormant → purged).
// Default on; flip to "false" for incident-response rollback.
export const LIFECYCLE_ENABLED = process.env.LIFECYCLE_ENABLED !== "false";

// Lambda / Functions config
export const LAMBDA_ROLE_ARN = process.env.LAMBDA_ROLE_ARN || "";
export const LAMBDA_LAYER_ARN = process.env.LAMBDA_LAYER_ARN || "";
export const LAMBDA_SUBNET_IDS = process.env.LAMBDA_SUBNET_IDS || "";
export const LAMBDA_SG_ID = process.env.LAMBDA_SG_ID || "";
export const FUNCTIONS_LOG_GROUP = process.env.FUNCTIONS_LOG_GROUP || "/agentdb/functions";

// OpenRouter (image generation + AI translation)
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

// OpenAI (moderation API — free)
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Stripe webhook (support both test + live secrets in parallel)
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const STRIPE_WEBHOOK_SECRET_LIVE = process.env.STRIPE_WEBHOOK_SECRET_LIVE || "";

// Bugsnag
export const BUGSNAG_API_KEY = process.env.BUGSNAG_API_KEY || "";
export const RELEASE_STAGE = process.env.RELEASE_STAGE || (process.env.LAMBDA_ROLE_ARN ? "production" : "development");

// Google OAuth (admin dashboard)
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "run402-admin-session-secret-change-me";

// MPP (Machine Payments Protocol)
export const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "";

// Google OAuth (end-user app auth — separate from admin dashboard client)
export const GOOGLE_APP_CLIENT_ID = process.env.GOOGLE_APP_CLIENT_ID || "";
export const GOOGLE_APP_CLIENT_SECRET = process.env.GOOGLE_APP_CLIENT_SECRET || "";
export const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://api.run402.com";

// CloudFront KeyValueStore (subdomain → deployment_id edge cache)
export const CLOUDFRONT_KVS_ARN = process.env.CLOUDFRONT_KVS_ARN || "";

// Cloudflare (custom domains — Custom Hostnames + Workers KV)
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
export const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "";
export const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
export const CLOUDFLARE_KV_ACCOUNT_ID = process.env.CLOUDFLARE_KV_ACCOUNT_ID || "";
