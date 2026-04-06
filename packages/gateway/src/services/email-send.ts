/**
 * Email send service — outbound email via SES.
 *
 * Supports two modes:
 *   1. Template mode: predefined templates (project_invite, magic_link, notification)
 *   2. Raw mode: arbitrary subject + HTML body (with auto-generated plaintext fallback)
 *
 * Sends from <slug>@mail.run402.com (optionally with display name).
 * Enforces daily send limits, unique recipient caps, and suppression lists.
 */

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import {
  getMailbox,
  checkAndIncrementDailyLimit,
  checkAndIncrementRecipientLimit,
  isAddressSuppressed,
  formatAddress,
  MailboxError,
} from "./mailbox.js";
import { getProjectById } from "./projects.js";
import { getVerifiedSenderDomain } from "./email-domains.js";
import { tryConsumePackCredit } from "./billing-email-overage.js";
import { TIERS } from "@run402/shared";
import type { TierName, TierConfig } from "@run402/shared";

const ses = new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" });

const MAIL_DOMAIN = "mail.run402.com";

// ---------- Templates ----------

interface TemplateConfig {
  requiredVars: string[];
  subject: (vars: Record<string, string>) => string;
  textBody: (vars: Record<string, string>) => string;
  htmlBody: (vars: Record<string, string>) => string;
}

const FOOTER_TEXT = "\n\n--\nSent by an AI agent via run402.com\nhttps://run402.com";
const FOOTER_HTML = `<br><br><hr style="border:none;border-top:1px solid #333;margin:20px 0"><p style="font-size:12px;color:#888">Sent by an AI agent via <a href="https://run402.com" style="color:#00FF9F">run402.com</a></p>`;

const TEMPLATES: Record<string, TemplateConfig> = {
  project_invite: {
    requiredVars: ["project_name", "invite_url"],
    subject: (v) => `You're invited to ${v.project_name}`,
    textBody: (v) =>
      `You've been invited to join ${v.project_name}.\n\nClick here to accept: ${v.invite_url}${FOOTER_TEXT}`,
    htmlBody: (v) =>
      `<h2>You're invited to ${escapeHtml(v.project_name)}</h2><p>Click the link below to accept the invitation:</p><p><a href="${escapeHtml(v.invite_url)}" style="color:#00FF9F">${escapeHtml(v.invite_url)}</a></p>${FOOTER_HTML}`,
  },
  magic_link: {
    requiredVars: ["project_name", "link_url", "expires_in"],
    subject: (v) => `Sign in to ${v.project_name}`,
    textBody: (v) =>
      `Sign in to ${v.project_name} using this link:\n\n${v.link_url}\n\nThis link expires in ${v.expires_in}.${FOOTER_TEXT}`,
    htmlBody: (v) =>
      `<h2>Sign in to ${escapeHtml(v.project_name)}</h2><p>Click the link below to sign in:</p><p><a href="${escapeHtml(v.link_url)}" style="color:#00FF9F">Sign In</a></p><p style="color:#888;font-size:13px">This link expires in ${escapeHtml(v.expires_in)}.</p>${FOOTER_HTML}`,
  },
  notification: {
    requiredVars: ["project_name", "message"],
    subject: (v) => `Update from ${v.project_name}`,
    textBody: (v) =>
      `${v.message}${FOOTER_TEXT}`,
    htmlBody: (v) =>
      `<h2>Update from ${escapeHtml(v.project_name)}</h2><p>${escapeHtml(v.message)}</p>${FOOTER_HTML}`,
  },
};

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Strip HTML tags to generate a plaintext fallback. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Raw mode limits ----------

const MAX_HTML_BYTES = 1_048_576; // 1MB
const MAX_SUBJECT_CHARS = 998; // RFC 5322
const MAX_FROM_NAME_CHARS = 78; // RFC 5322 display name

// ---------- Send ----------

export interface SendEmailResult {
  message_id: string;
  to: string;
  template: string | null;
  subject?: string;
  status: string;
  sent_at: string;
}

export interface SendEmailOptions {
  mailboxId: string;
  to: string;
  // Template mode
  template?: string;
  variables?: Record<string, string>;
  // Raw mode
  subject?: string;
  html?: string;
  text?: string;
  // Shared
  from_name?: string;
}

/**
 * Validate the from_name field if provided.
 */
function validateFromName(name: string | undefined): void {
  if (!name) return;
  if (name.length > MAX_FROM_NAME_CHARS) {
    throw new MailboxError(`Display name exceeds ${MAX_FROM_NAME_CHARS} character limit`, 400);
  }
  if (/[<>"\n\r]/.test(name)) {
    throw new MailboxError("Display name contains invalid characters", 400);
  }
}

/**
 * Build the From address, optionally with a display name.
 */
function buildFromAddress(slug: string, fromName?: string, customDomain?: string | null): string {
  const address = customDomain ? `${slug}@${customDomain}` : formatAddress(slug);
  if (fromName) {
    return `"${fromName}" <${address}>`;
  }
  return address;
}

/**
 * Send an email — supports template mode and raw HTML mode.
 *
 * Template mode: provide `template` + `variables`
 * Raw mode: provide `subject` + `html` (+ optional `text`)
 * If `template` is present, template mode is used (takes precedence).
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult>;
export async function sendEmail(mailboxId: string, template: string, to: string, variables: Record<string, string>): Promise<SendEmailResult>;
export async function sendEmail(
  mailboxIdOrOpts: string | SendEmailOptions,
  templateArg?: string,
  toArg?: string,
  variablesArg?: Record<string, string>,
): Promise<SendEmailResult> {
  // Normalize to options object (backwards compat with old 4-arg signature)
  const opts: SendEmailOptions = typeof mailboxIdOrOpts === "string"
    ? { mailboxId: mailboxIdOrOpts, template: templateArg, to: toArg!, variables: variablesArg }
    : mailboxIdOrOpts;

  const { mailboxId, to } = opts;
  const isTemplateMode = !!opts.template;

  // --- Template mode validation ---
  let subject: string;
  let textBody: string;
  let htmlBody: string;
  let templateName: string | null;

  if (isTemplateMode) {
    const tmpl = TEMPLATES[opts.template!];
    if (!tmpl) {
      throw new MailboxError(
        `Unknown template. Valid templates: ${Object.keys(TEMPLATES).join(", ")}`,
        400,
      );
    }
    const variables = opts.variables || {};
    for (const v of tmpl.requiredVars) {
      if (!variables[v]) {
        throw new MailboxError(`Missing required variable: ${v}`, 400);
      }
    }
    if (opts.template === "notification" && variables.message && variables.message.length > 500) {
      throw new MailboxError("Message exceeds 500 character limit", 400);
    }
    subject = tmpl.subject(variables);
    textBody = tmpl.textBody(variables);
    htmlBody = tmpl.htmlBody(variables);
    templateName = opts.template!;
  } else {
    // --- Raw mode validation ---
    if (!opts.subject) {
      throw new MailboxError("Subject is required for raw email", 400);
    }
    if (!opts.html) {
      throw new MailboxError("HTML body is required for raw email", 400);
    }
    if (opts.subject.length > MAX_SUBJECT_CHARS) {
      throw new MailboxError(`Subject exceeds ${MAX_SUBJECT_CHARS} character limit`, 400);
    }
    if (Buffer.byteLength(opts.html, "utf-8") > MAX_HTML_BYTES) {
      throw new MailboxError("HTML body exceeds 1MB limit", 400);
    }
    subject = opts.subject;
    htmlBody = opts.html + FOOTER_HTML;
    textBody = (opts.text || stripHtml(opts.html)) + FOOTER_TEXT;
    templateName = null;
  }

  // Validate from_name (both modes)
  validateFromName(opts.from_name);

  // Get mailbox
  const mailbox = await getMailbox(mailboxId);
  if (!mailbox) throw new MailboxError("Mailbox not found", 404);
  if (mailbox.status === "suspended") {
    throw new MailboxError("Mailbox is suspended due to abuse", 403);
  }
  if (mailbox.status === "tombstoned") {
    throw new MailboxError("Mailbox has been deleted", 404);
  }

  // Platform mailboxes (project_id='platform') bypass project/tier/rate-limit checks.
  // They are used by run402 itself for billing notifications and other platform emails.
  // Upstream callers (billing-notifications.ts) enforce their own rate limits.
  const isPlatformMailbox = mailbox.project_id === "platform";

  let tierConfig: TierConfig | null = null;
  if (!isPlatformMailbox) {
    // Get project for tier info
    const project = await getProjectById(mailbox.project_id);
    if (!project) throw new MailboxError("Project not found", 404);
    tierConfig = TIERS[project.tier as TierName];
  }

  if (!isPlatformMailbox) {
    // Check suppression
    if (await isAddressSuppressed(to, mailbox.project_id)) {
      throw new MailboxError("Recipient address is suppressed", 400);
    }

    // Check daily limit
    const dailyCheck = await checkAndIncrementDailyLimit(mailboxId, tierConfig!.emailsPerDay);
    if (!dailyCheck.allowed) {
      // Tier daily limit exhausted. Try email pack overage (requires verified custom domain).
      const overage = await tryConsumePackCredit(mailbox.project_id);
      if (overage.allowed) {
        // Pack credit consumed — proceed with send. Rollback the tier counter increment
        // that checkAndIncrementDailyLimit did before rejecting.
        await pool.query(
          sql(`UPDATE internal.mailboxes SET sends_today = sends_today - 1 WHERE id = $1`),
          [mailboxId],
        );
      } else {
        // No pack available — roll back and return error
        await pool.query(
          sql(`UPDATE internal.mailboxes SET sends_today = sends_today - 1 WHERE id = $1`),
          [mailboxId],
        );

        // Error shape differs based on why the pack couldn't be used
        if (overage.reason === "no_custom_domain") {
          throw new MailboxError(
            JSON.stringify({
              error: "Daily send limit reached",
              limit: tierConfig!.emailsPerDay,
              resets_at: dailyCheck.resetsAt,
              hint: "Register a verified custom sender domain and buy an email pack to send more. See POST /email/v1/domains.",
            }),
            429,
          );
        }

        if (overage.reason === "no_credits") {
          throw new MailboxError(
            JSON.stringify({
              error: "Daily send limit reached and email pack empty",
              limit: tierConfig!.emailsPerDay,
              resets_at: dailyCheck.resetsAt,
              hint: "Buy an email pack to send more emails. See POST /billing/v1/email-packs/checkout.",
            }),
            402,
          );
        }

        // no_billing_account — treat like the old 402 tier upgrade hint
        const tierNames: TierName[] = ["prototype", "hobby", "team"];
        const project = await getProjectById(mailbox.project_id);
        const currentIdx = project ? tierNames.indexOf(project.tier as TierName) : -1;
        if (currentIdx >= 0 && currentIdx < tierNames.length - 1) {
          const nextTier = tierNames[currentIdx + 1];
          const nextConfig = TIERS[nextTier];
          throw new MailboxError(
            JSON.stringify({
              error: "Daily send limit reached",
              limit: tierConfig!.emailsPerDay,
              resets_at: dailyCheck.resetsAt,
              upgrade: { tier: nextTier, price: nextConfig.price, daily_limit: nextConfig.emailsPerDay },
            }),
            402,
          );
        }
        throw new MailboxError(
          `Daily send limit reached (${tierConfig!.emailsPerDay}). Resets at ${dailyCheck.resetsAt}`,
          429,
        );
      }
    }

    // Check unique recipient limit
    const recipientCheck = await checkAndIncrementRecipientLimit(
      mailboxId,
      to,
      tierConfig!.uniqueRecipientsPerLease,
    );
    if (!recipientCheck.allowed) {
      await pool.query(
        sql(`UPDATE internal.mailboxes SET sends_today = sends_today - 1 WHERE id = $1`),
        [mailboxId],
      );
      throw new MailboxError(
        `Unique recipient limit reached (${tierConfig!.uniqueRecipientsPerLease})`,
        429,
      );
    }
  }

  // Resolve custom sender domain (if verified, use it; otherwise fall back to mail.run402.com)
  const customDomain = await getVerifiedSenderDomain(mailbox.project_id);
  const fromAddress = buildFromAddress(mailbox.slug, opts.from_name, customDomain);

  // Send via SES
  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: textBody },
          Html: { Data: htmlBody },
        },
      },
    },
  });

  const sesResult = await ses.send(command);
  const sesMessageId = sesResult.MessageId || "";

  // Store message record
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await pool.query(
    sql(`INSERT INTO internal.email_messages (id, mailbox_id, direction, template, to_address, from_address, subject, body_text, ses_message_id, status, created_at)
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, 'sent', $9)`),
    [msgId, mailboxId, templateName, to, fromAddress, subject, textBody, sesMessageId, now],
  );

  const mode = templateName ? `template: ${templateName}` : "raw";
  console.log(`  Email sent: ${fromAddress} → ${to} (${mode}, ses: ${sesMessageId})`);

  return {
    message_id: msgId,
    to,
    template: templateName,
    ...(templateName ? {} : { subject }),
    status: "sent",
    sent_at: now,
  };
}

// ---------- Message queries ----------

export interface EmailMessage {
  message_id: string;
  mailbox_id: string;
  direction: string;
  template: string | null;
  to_address: string | null;
  from_address: string | null;
  subject: string | null;
  body_text: string | null;
  status: string;
  created_at: string;
  replies?: EmailMessage[];
}

export async function listMessages(
  mailboxId: string,
  limit = 50,
  cursor?: string,
): Promise<{ messages: EmailMessage[]; has_more: boolean; next_cursor: string | null }> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);

  let query: string;
  let params: unknown[];
  if (cursor) {
    query = `SELECT id, mailbox_id, direction, template, to_address, from_address, subject, body_text, status, created_at
             FROM internal.email_messages
             WHERE mailbox_id = $1 AND direction = 'outbound' AND created_at < (SELECT created_at FROM internal.email_messages WHERE id = $2)
             ORDER BY created_at DESC LIMIT $3`;
    params = [mailboxId, cursor, safeLimit + 1];
  } else {
    query = `SELECT id, mailbox_id, direction, template, to_address, from_address, subject, body_text, status, created_at
             FROM internal.email_messages
             WHERE mailbox_id = $1 AND direction = 'outbound'
             ORDER BY created_at DESC LIMIT $2`;
    params = [mailboxId, safeLimit + 1];
  }

  const result = await pool.query(sql(query), params);
  const hasMore = result.rows.length > safeLimit;
  const rows = hasMore ? result.rows.slice(0, safeLimit) : result.rows;

  return {
    messages: rows.map(formatMessage),
    has_more: hasMore,
    next_cursor: hasMore ? rows[rows.length - 1].id : null,
  };
}

export async function getMessage(mailboxId: string, messageId: string): Promise<EmailMessage | null> {
  const result = await pool.query(
    sql(`SELECT id, mailbox_id, direction, template, to_address, from_address, subject, body_text, status, created_at
     FROM internal.email_messages WHERE id = $1 AND mailbox_id = $2`),
    [messageId, mailboxId],
  );
  if (result.rows.length === 0) return null;

  const msg = formatMessage(result.rows[0]);

  // Fetch replies
  const repliesResult = await pool.query(
    sql(`SELECT id, mailbox_id, direction, template, to_address, from_address, subject, body_text, status, created_at
     FROM internal.email_messages WHERE in_reply_to_id = $1 ORDER BY created_at ASC`),
    [messageId],
  );
  msg.replies = repliesResult.rows.map(formatMessage);

  return msg;
}

function formatMessage(row: Record<string, unknown>): EmailMessage {
  return {
    message_id: row.id as string,
    mailbox_id: row.mailbox_id as string,
    direction: row.direction as string,
    template: row.template as string | null,
    to_address: row.to_address as string | null,
    from_address: row.from_address as string | null,
    subject: row.subject as string | null,
    body_text: row.body_text as string | null,
    status: row.status as string,
    created_at: row.created_at as string,
  };
}

export function getValidTemplates(): string[] {
  return Object.keys(TEMPLATES);
}
