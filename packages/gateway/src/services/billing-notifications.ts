/**
 * Platform billing notifications service.
 *
 * Sends emails from the platform billing mailbox (`billing@mail.run402.com`)
 * for account lifecycle events: email verification, auto-recharge failures,
 * low balance warnings, etc.
 *
 * Rate-limited aggressively to protect mail.run402.com shared SES reputation:
 * - 60s per-email cooldown (prevents double-click spam)
 * - 10 per-IP per hour (per-attacker cap)
 * - 500 per-hour + 2000 per-day globally (DoS ceiling)
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { BILLING_MAILBOX_ID, PUBLIC_API_URL } from "../config.js";
import { sendEmail } from "./email-send.js";
import { HttpError } from "../utils/async-handler.js";

// Cached platform billing mailbox ID (resolved once at first send)
let cachedBillingMailboxId: string | null = null;

async function resolveBillingMailboxId(): Promise<string> {
  if (BILLING_MAILBOX_ID) return BILLING_MAILBOX_ID;
  if (cachedBillingMailboxId) return cachedBillingMailboxId;
  const result = await pool.query(
    sql(`SELECT id FROM internal.mailboxes WHERE slug = 'billing' AND project_id = 'platform' LIMIT 1`),
  );
  if (result.rows.length === 0) {
    throw new HttpError(503, "Platform billing mailbox not found — startup bootstrap may have failed");
  }
  cachedBillingMailboxId = result.rows[0].id;
  return cachedBillingMailboxId!;
}

// --- Rate limiting (in-memory) ---

const PER_EMAIL_COOLDOWN_MS = 60 * 1000; // 60 seconds
const PER_IP_LIMIT = 10;
const PER_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const GLOBAL_HOUR_LIMIT = 500;
const GLOBAL_DAY_LIMIT = 2000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface WindowEntry {
  count: number;
  resetAt: number;
}

interface Timestamp {
  at: number;
}

// Per-email: last send timestamp
const perEmailLastSend = new Map<string, Timestamp>();
// Per-IP: count + window reset
const perIpWindow = new Map<string, WindowEntry>();
// Global: count + window reset (separate hour and day windows)
const globalHourWindow: WindowEntry = { count: 0, resetAt: 0 };
const globalDayWindow: WindowEntry = { count: 0, resetAt: 0 };

export function _resetRateLimitForTests(): void {
  perEmailLastSend.clear();
  perIpWindow.clear();
  globalHourWindow.count = 0;
  globalHourWindow.resetAt = 0;
  globalDayWindow.count = 0;
  globalDayWindow.resetAt = 0;
}

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "per_email_cooldown" | "per_ip" | "global" };

/**
 * Check if a billing notification can be sent under current rate limits.
 * If allowed, increments the counters (reserves the slot).
 */
export function checkBillingNotificationRateLimit(email: string, ip: string): RateLimitResult {
  const now = Date.now();
  const normalizedEmail = email.toLowerCase().trim();

  // Per-email cooldown
  const lastSend = perEmailLastSend.get(normalizedEmail);
  if (lastSend && now - lastSend.at < PER_EMAIL_COOLDOWN_MS) {
    return { allowed: false, reason: "per_email_cooldown" };
  }

  // Per-IP rate limit
  let ipEntry = perIpWindow.get(ip);
  if (!ipEntry || now >= ipEntry.resetAt) {
    ipEntry = { count: 0, resetAt: now + PER_IP_WINDOW_MS };
    perIpWindow.set(ip, ipEntry);
  }
  if (ipEntry.count >= PER_IP_LIMIT) {
    return { allowed: false, reason: "per_ip" };
  }

  // Global hourly limit
  if (now >= globalHourWindow.resetAt) {
    globalHourWindow.count = 0;
    globalHourWindow.resetAt = now + HOUR_MS;
  }
  if (globalHourWindow.count >= GLOBAL_HOUR_LIMIT) {
    return { allowed: false, reason: "global" };
  }

  // Global daily limit
  if (now >= globalDayWindow.resetAt) {
    globalDayWindow.count = 0;
    globalDayWindow.resetAt = now + DAY_MS;
  }
  if (globalDayWindow.count >= GLOBAL_DAY_LIMIT) {
    return { allowed: false, reason: "global" };
  }

  // Allowed — reserve the slot
  perEmailLastSend.set(normalizedEmail, { at: now });
  ipEntry.count++;
  globalHourWindow.count++;
  globalDayWindow.count++;

  return { allowed: true };
}

// --- Send verification email ---

/**
 * Send an email verification link via the platform billing mailbox.
 * Rate-limited. Throws HttpError(429) if blocked.
 * Also increments `verification_send_count` and `last_verification_sent_at`
 * on the `billing_account_emails` row for audit.
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string,
  ip: string,
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit check
  const rateCheck = checkBillingNotificationRateLimit(normalizedEmail, ip);
  if (!rateCheck.allowed) {
    throw new HttpError(429, `Verification email rate-limited: ${rateCheck.reason}`);
  }

  // Resolve platform billing mailbox (cached after first lookup)
  const billingMailboxId = await resolveBillingMailboxId();

  // Build verification URL
  const verificationUrl = `${PUBLIC_API_URL}/billing/v1/accounts/verify?token=${encodeURIComponent(verificationToken)}`;

  // Send via email-send service using platform billing mailbox
  await sendEmail({
    mailboxId: billingMailboxId,
    template: "magic_link",
    to: normalizedEmail,
    variables: {
      project_name: "Run402 Billing",
      link_url: verificationUrl,
      expires_in: "24 hours",
    },
  });

  // Update audit counters on billing_account_emails
  await pool.query(
    sql(`UPDATE internal.billing_account_emails
     SET verification_send_count = verification_send_count + 1,
         last_verification_sent_at = NOW()
     WHERE email = $1`),
    [normalizedEmail],
  );
}
