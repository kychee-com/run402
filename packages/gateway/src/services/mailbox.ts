/**
 * Mailbox service — project-scoped email at <slug>@mail.run402.com
 *
 * One mailbox per project, tied to project lifecycle.
 * Follows the same pattern as subdomains: blocklist, validation, DB table init.
 */

import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

export interface MailboxRecord {
  id: string;
  slug: string;
  project_id: string;
  status: "active" | "suspended" | "tombstoned";
  tombstoned_at: string | null;
  sends_today: number;
  sends_today_reset_at: string;
  unique_recipients: number;
  created_at: string;
  updated_at: string;
}

/** Reserved email slugs that cannot be claimed. */
const BLOCKLIST = new Set([
  // RFC / abuse / infra
  "abuse", "postmaster", "hostmaster", "webmaster", "mailer-daemon",
  "bounce", "bounces", "smtp", "imap", "pop", "mx", "dkim", "dmarc",
  "noreply", "no-reply",
  // Platform / company
  "admin", "info", "support", "help", "hello", "contact", "sales",
  "billing", "accounts", "legal", "privacy", "security", "press",
  "media", "jobs", "careers", "team", "ops", "status", "api", "docs",
  "dashboard", "run402", "agentdb",
  // People / impersonation
  "tal", "barry", "ceo", "founder", "owner", "finance", "payroll", "hr",
]);

/** Slug validation regex: 3-63 chars, lowercase alphanumeric + hyphens. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const TOMBSTONE_DAYS = 90;
const MAIL_DOMAIN = "mail.run402.com";

// ---------- Table init ----------

export async function initMailboxTables(): Promise<void> {
  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.mailboxes (
      id               TEXT PRIMARY KEY,
      slug             TEXT NOT NULL UNIQUE,
      project_id       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      tombstoned_at    TIMESTAMPTZ,
      sends_today      INT NOT NULL DEFAULT 0,
      sends_today_reset_at TIMESTAMPTZ NOT NULL DEFAULT (DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'),
      unique_recipients INT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_mailboxes_project ON internal.mailboxes(project_id)`));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_mailboxes_slug ON internal.mailboxes(slug)`));

  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.email_messages (
      id               TEXT PRIMARY KEY,
      mailbox_id       TEXT NOT NULL REFERENCES internal.mailboxes(id),
      direction        TEXT NOT NULL,
      template         TEXT,
      to_address       TEXT,
      from_address     TEXT,
      subject          TEXT,
      body_text        TEXT,
      ses_message_id   TEXT,
      status           TEXT NOT NULL DEFAULT 'sent',
      in_reply_to_id   TEXT,
      s3_key           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_email_messages_mailbox ON internal.email_messages(mailbox_id, created_at DESC)`));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_email_messages_to ON internal.email_messages(to_address, mailbox_id)`));

  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.email_suppressions (
      email_address    TEXT NOT NULL,
      scope            TEXT NOT NULL,
      project_id       TEXT NOT NULL DEFAULT '',
      reason           TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (email_address, scope, project_id)
    )
  `));
  await pool.query(sql(`CREATE INDEX IF NOT EXISTS idx_email_suppressions_addr ON internal.email_suppressions(email_address)`));

  await pool.query(sql(`
    CREATE TABLE IF NOT EXISTS internal.email_webhooks (
      id               TEXT PRIMARY KEY,
      mailbox_id       TEXT NOT NULL REFERENCES internal.mailboxes(id),
      url              TEXT NOT NULL,
      events           JSONB NOT NULL DEFAULT '[]',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
}

// ---------- Validation ----------

export function validateSlug(slug: string): string | null {
  if (typeof slug !== "string") return "Slug must be a string";
  if (slug !== slug.toLowerCase()) return "Slug must be lowercase";
  if (slug.length < 3) return "Slug must be 3-63 characters";
  if (slug.length > 63) return "Slug must be 3-63 characters";
  if (!SLUG_RE.test(slug)) return "Slug must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number";
  if (slug.includes("--")) return "Slug must not contain consecutive hyphens";
  if (BLOCKLIST.has(slug)) return `Slug "${slug}" is reserved`;
  return null;
}

export function formatAddress(slug: string): string {
  return `${slug}@${MAIL_DOMAIN}`;
}

// ---------- CRUD ----------

export async function createMailbox(slug: string, projectId: string): Promise<MailboxRecord> {
  // Check if project already has a mailbox
  const existing = await pool.query(
    sql(`SELECT id FROM internal.mailboxes WHERE project_id = $1 AND status = 'active'`),
    [projectId],
  );
  if (existing.rows.length > 0) {
    throw new MailboxError("Project already has a mailbox", 409);
  }

  // Check if slug is taken (active or tombstoned within cooldown)
  const slugCheck = await pool.query(
    sql(`SELECT id, status, tombstoned_at FROM internal.mailboxes WHERE slug = $1`),
    [slug],
  );
  if (slugCheck.rows.length > 0) {
    const row = slugCheck.rows[0];
    if (row.status === "active" || row.status === "suspended") {
      throw new MailboxError("Slug already in use", 409);
    }
    if (row.status === "tombstoned" && row.tombstoned_at) {
      const tombstonedAt = new Date(row.tombstoned_at);
      const cooldownEnd = new Date(tombstonedAt.getTime() + TOMBSTONE_DAYS * 24 * 60 * 60 * 1000);
      if (new Date() < cooldownEnd) {
        throw new MailboxError("Address is in cooldown period", 409);
      }
      // Cooldown expired — delete the old tombstone and allow reuse
      await pool.query(sql(`DELETE FROM internal.mailboxes WHERE id = $1`), [row.id]);
    }
  }

  const id = `mbx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await pool.query(
    sql(`INSERT INTO internal.mailboxes (id, slug, project_id)
     VALUES ($1, $2, $3)
     RETURNING *`),
    [id, slug, projectId],
  );

  console.log(`  Mailbox created: ${slug}@${MAIL_DOMAIN} (project: ${projectId})`);
  return result.rows[0] as MailboxRecord;
}

export async function getMailbox(id: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    sql(`SELECT * FROM internal.mailboxes WHERE id = $1`),
    [id],
  );
  return result.rows.length > 0 ? (result.rows[0] as MailboxRecord) : null;
}

export async function getMailboxBySlug(slug: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    sql(`SELECT * FROM internal.mailboxes WHERE slug = $1 AND status != 'tombstoned'`),
    [slug],
  );
  return result.rows.length > 0 ? (result.rows[0] as MailboxRecord) : null;
}

export async function listMailboxes(projectId: string): Promise<MailboxRecord[]> {
  const result = await pool.query(
    sql(`SELECT * FROM internal.mailboxes WHERE project_id = $1 AND status != 'tombstoned' ORDER BY created_at DESC`),
    [projectId],
  );
  return result.rows as MailboxRecord[];
}

export async function deleteMailbox(id: string, projectId: string): Promise<boolean> {
  const mailbox = await getMailbox(id);
  if (!mailbox) return false;
  if (mailbox.project_id !== projectId) {
    throw new MailboxError("Mailbox owned by different project", 403);
  }

  await pool.query(
    sql(`UPDATE internal.mailboxes SET status = 'tombstoned', tombstoned_at = NOW(), updated_at = NOW() WHERE id = $1`),
    [id],
  );

  console.log(`  Mailbox tombstoned: ${mailbox.slug}@${MAIL_DOMAIN}`);
  return true;
}

export async function tombstoneProjectMailbox(projectId: string): Promise<void> {
  const result = await pool.query(
    sql(`UPDATE internal.mailboxes SET status = 'tombstoned', tombstoned_at = NOW(), updated_at = NOW()
     WHERE project_id = $1 AND status IN ('active', 'suspended')
     RETURNING slug`),
    [projectId],
  );
  for (const row of result.rows) {
    console.log(`  Mailbox tombstoned (cascade): ${row.slug}@${MAIL_DOMAIN}`);
  }
}

export async function suspendMailbox(id: string, reason: string): Promise<void> {
  await pool.query(
    sql(`UPDATE internal.mailboxes SET status = 'suspended', updated_at = NOW() WHERE id = $1`),
    [id],
  );
  console.log(`  Mailbox suspended: ${id} (reason: ${reason})`);
}

export async function reactivateMailbox(id: string): Promise<boolean> {
  const result = await pool.query(
    sql(`UPDATE internal.mailboxes SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'suspended' RETURNING id`),
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------- Rate limiting helpers ----------

/**
 * Check and increment daily send counter. Returns true if under limit.
 * Resets counter if past the reset time.
 */
export async function checkAndIncrementDailyLimit(mailboxId: string, dailyLimit: number): Promise<{ allowed: boolean; current: number; resetsAt: string }> {
  // Reset if past reset time, then increment
  const result = await pool.query(
    sql(`UPDATE internal.mailboxes
     SET sends_today = CASE
       WHEN NOW() >= sends_today_reset_at THEN 1
       ELSE sends_today + 1
     END,
     sends_today_reset_at = CASE
       WHEN NOW() >= sends_today_reset_at THEN DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
       ELSE sends_today_reset_at
     END,
     updated_at = NOW()
     WHERE id = $1
     RETURNING sends_today, sends_today_reset_at`),
    [mailboxId],
  );
  const row = result.rows[0];
  const current = row.sends_today;
  return {
    allowed: current <= dailyLimit,
    current,
    resetsAt: row.sends_today_reset_at,
  };
}

/**
 * Check and increment unique recipient counter. Returns true if allowed.
 */
export async function checkAndIncrementRecipientLimit(
  mailboxId: string,
  toAddress: string,
  recipientLimit: number,
): Promise<{ allowed: boolean; current: number }> {
  // Check if we've already sent to this address
  const existingResult = await pool.query(
    sql(`SELECT 1 FROM internal.email_messages WHERE mailbox_id = $1 AND to_address = $2 AND direction = 'outbound' LIMIT 1`),
    [mailboxId, toAddress],
  );
  if (existingResult.rows.length > 0) {
    // Already sent to this address — not a new unique recipient
    return { allowed: true, current: -1 };
  }

  // New unique recipient — check limit
  const mailbox = await getMailbox(mailboxId);
  if (!mailbox) return { allowed: false, current: 0 };

  if (mailbox.unique_recipients >= recipientLimit) {
    return { allowed: false, current: mailbox.unique_recipients };
  }

  await pool.query(
    sql(`UPDATE internal.mailboxes SET unique_recipients = unique_recipients + 1, updated_at = NOW() WHERE id = $1`),
    [mailboxId],
  );

  return { allowed: true, current: mailbox.unique_recipients + 1 };
}

// ---------- Suppression ----------

export async function isAddressSuppressed(emailAddress: string, projectId: string): Promise<boolean> {
  const result = await pool.query(
    sql(`SELECT 1 FROM internal.email_suppressions
     WHERE email_address = $1 AND (scope = 'global' OR (scope = 'project' AND project_id = $2))
     LIMIT 1`),
    [emailAddress, projectId],
  );
  return result.rows.length > 0;
}

export async function addSuppression(emailAddress: string, scope: "global" | "project", projectId: string | null, reason: string): Promise<void> {
  await pool.query(
    sql(`INSERT INTO internal.email_suppressions (email_address, scope, project_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`),
    [emailAddress, scope, projectId || "", reason],
  );
}

// ---------- Error ----------

export class MailboxError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
