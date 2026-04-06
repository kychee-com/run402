/**
 * Tiny shim around `email-send.sendEmail` for sending platform-originated
 * notification emails (low-balance alerts, suspension warnings, etc.) from
 * the bootstrapped `billing@mail.run402.com` mailbox.
 *
 * Existing as its own module so notification services can be unit-tested
 * by mocking just this seam (the real `sendEmail` API is template/mailbox
 * heavy and unfriendly to mock).
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { sendEmail } from "./email-send.js";

let cachedBillingMailboxId: string | null = null;

async function getBillingMailboxId(): Promise<string | null> {
  if (cachedBillingMailboxId) return cachedBillingMailboxId;
  const result = await pool.query(
    sql(`SELECT id FROM internal.mailboxes WHERE slug = 'billing' AND project_id = 'platform' LIMIT 1`),
  );
  if (result.rows.length === 0) return null;
  cachedBillingMailboxId = result.rows[0].id;
  return cachedBillingMailboxId;
}

export interface SendPlatformEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendPlatformEmail(input: SendPlatformEmailInput): Promise<void> {
  const mailboxId = await getBillingMailboxId();
  if (!mailboxId) {
    console.warn("[platform-mail] no billing mailbox bootstrapped — skipping send");
    return;
  }
  await sendEmail({
    mailboxId,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
}
