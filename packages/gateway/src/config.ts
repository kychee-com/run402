export const PORT = parseInt(process.env.PORT || "4022", 10);
export const JWT_SECRET = process.env.JWT_SECRET || "super-secret-jwt-key-for-agentdb-test-only-32chars!!";
export const SELLER_ADDRESS = process.env.SELLER_ADDRESS as `0x${string}`;
export const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
export const NETWORK = process.env.NETWORK || "eip155:84532"; // Base Sepolia default
export const POSTGREST_URL = process.env.POSTGREST_URL || "http://localhost:3000";
export const MAX_SCHEMA_SLOTS = parseInt(process.env.MAX_SCHEMA_SLOTS || "2000", 10);

// S3 config
export const S3_BUCKET = process.env.S3_BUCKET || "";
export const S3_REGION = process.env.S3_REGION || "us-east-1";

// Rate limiting
export const RATE_LIMIT_PER_SEC = parseInt(process.env.RATE_LIMIT_PER_SEC || "100", 10);

// Lease grace periods (ms)
export const LEASE_GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days
export const LEASE_DELETE_PERIOD = 30 * 24 * 60 * 60 * 1000; // 30 days

// Metering flush interval (ms)
export const METERING_FLUSH_INTERVAL = 60_000; // 60s
