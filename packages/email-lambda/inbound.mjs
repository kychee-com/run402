/**
 * Inbound email processing Lambda.
 *
 * Triggered by SES receipt rule → S3 → this Lambda.
 * Parses raw MIME from S3, validates reply-only policy, stores accepted replies.
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD — Aurora connection
 *   INBOUND_EMAIL_BUCKET — S3 bucket with raw MIME
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.INBOUND_EMAIL_BUCKET;

let pool;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432"),
      database: process.env.DB_NAME || "agentdb",
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 60000,
    });
  }
  return pool;
}

export async function handler(event) {
  for (const record of event.Records) {
    const sesEvent = record.ses;
    const messageId = sesEvent.mail.messageId;
    const s3Key = `inbound-email/${messageId}`;

    try {
      await processInboundEmail(sesEvent, s3Key);
    } catch (err) {
      console.error(`Failed to process inbound email ${messageId}:`, err.message);
      // Don't throw — SES will retry and we don't want bounce loops
    }
  }
}

async function processInboundEmail(sesEvent, s3Key) {
  const mail = sesEvent.mail;
  const recipients = sesEvent.receipt?.recipients || [];

  if (recipients.length === 0) {
    console.log("No recipients, dropping");
    return;
  }

  // Parse the recipient into slug and host
  const recipient = recipients[0].toLowerCase();
  const atIdx = recipient.indexOf("@");
  if (atIdx < 1) {
    console.log(`Invalid recipient format: ${recipient}, dropping`);
    return;
  }
  const slug = recipient.slice(0, atIdx);
  const host = recipient.slice(atIdx + 1);

  const db = getPool();

  // Resolve the mailbox based on the recipient host:
  // - mail.run402.com: existing behavior — look up mailbox by slug directly
  // - custom domain: look up the domain in email_domains, then find the mailbox by (slug, project_id)
  let mailbox;
  if (host === "mail.run402.com") {
    const mbxResult = await db.query(
      `SELECT id, project_id, status FROM internal.mailboxes WHERE slug = $1`,
      [slug],
    );
    if (mbxResult.rows.length === 0) {
      console.log(`No mailbox for slug "${slug}" on mail.run402.com, dropping`);
      return;
    }
    mailbox = mbxResult.rows[0];
  } else {
    // Custom domain: resolve via email_domains table
    const domainResult = await db.query(
      `SELECT project_id FROM internal.email_domains WHERE domain = $1 AND inbound_enabled = TRUE AND status = 'verified'`,
      [host],
    );
    if (domainResult.rows.length === 0) {
      console.log(`No inbound-enabled custom domain for host "${host}", dropping`);
      return;
    }
    const { project_id } = domainResult.rows[0];
    const mbxResult = await db.query(
      `SELECT id, project_id, status FROM internal.mailboxes WHERE slug = $1 AND project_id = $2`,
      [slug, project_id],
    );
    if (mbxResult.rows.length === 0) {
      console.log(`No mailbox for slug "${slug}" on custom domain "${host}" (project ${project_id}), dropping`);
      return;
    }
    mailbox = mbxResult.rows[0];
  }

  if (mailbox.status === "tombstoned") {
    console.log(`Mailbox "${slug}" is tombstoned, dropping`);
    return;
  }

  // Get sender
  const from = (mail.source || mail.commonHeaders?.from?.[0] || "").toLowerCase();
  if (!from) {
    console.log("No sender address, dropping");
    return;
  }
  // Extract just the email address from "Name <email>" format
  const fromEmail = from.includes("<") ? from.match(/<([^>]+)>/)?.[1] || from : from;

  // Reply-only check: has this mailbox sent to this sender before?
  const sentCheck = await db.query(
    `SELECT id FROM internal.email_messages
     WHERE mailbox_id = $1 AND to_address = $2 AND direction = 'outbound'
     LIMIT 1`,
    [mailbox.id, fromEmail],
  );
  if (sentCheck.rows.length === 0) {
    console.log(`Sender ${fromEmail} not in sent history for mailbox ${slug}, dropping`);
    return;
  }

  // Fetch raw MIME from S3 and parse
  let rawMime = "";
  try {
    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    rawMime = await s3Resp.Body.transformToString("utf-8");
  } catch (err) {
    console.error(`Failed to fetch raw email from S3 (${s3Key}):`, err.message);
    return;
  }

  // Simple MIME parsing — extract subject, plain text body, and threading headers
  const { subject, bodyText, inReplyTo, references } = parseMime(rawMime);

  // Try to link to original sent message
  let inReplyToId = null;
  if (inReplyTo || references) {
    const headerToMatch = inReplyTo || (references ? references.split(/\s+/)[0] : null);
    if (headerToMatch) {
      const origResult = await db.query(
        `SELECT id FROM internal.email_messages
         WHERE ses_message_id = $1 AND mailbox_id = $2 AND direction = 'outbound'
         LIMIT 1`,
        [headerToMatch.replace(/[<>]/g, ""), mailbox.id],
      );
      if (origResult.rows.length > 0) {
        inReplyToId = origResult.rows[0].id;
      }
    }
  }

  // If no threading match, try matching by sender against recent outbound
  if (!inReplyToId) {
    const recentResult = await db.query(
      `SELECT id FROM internal.email_messages
       WHERE mailbox_id = $1 AND to_address = $2 AND direction = 'outbound'
       ORDER BY created_at DESC LIMIT 1`,
      [mailbox.id, fromEmail],
    );
    if (recentResult.rows.length > 0) {
      inReplyToId = recentResult.rows[0].id;
    }
  }

  // Store the reply
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO internal.email_messages
     (id, mailbox_id, direction, to_address, from_address, subject, body_text, ses_message_id, status, in_reply_to_id, s3_key, created_at)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'received', $8, $9, NOW())`,
    [msgId, mailbox.id, recipient, fromEmail, subject, bodyText, mail.messageId, inReplyToId, s3Key],
  );

  console.log(`Inbound reply stored: ${fromEmail} → ${slug}@mail.run402.com (msg: ${msgId})`);

  // Fire webhook if registered
  await fireWebhook(db, mailbox.id, "reply_received", {
    mailbox_id: mailbox.id,
    message_id: msgId,
    from: fromEmail,
    body_text: bodyText,
    received_at: new Date().toISOString(),
  });
}

/**
 * Simple MIME parser — extracts subject, plain text body, In-Reply-To, References.
 * Not a full RFC 2822 parser; handles common email formats.
 */
function parseMime(raw) {
  const headerBodySplit = raw.indexOf("\r\n\r\n");
  const headersPart = headerBodySplit > 0 ? raw.slice(0, headerBodySplit) : raw;
  const bodyPart = headerBodySplit > 0 ? raw.slice(headerBodySplit + 4) : "";

  // Parse headers (unfold continuation lines)
  const unfolded = headersPart.replace(/\r\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[key] = value;
    }
  }

  const subject = decodeHeader(headers["subject"] || "(no subject)");
  const inReplyTo = headers["in-reply-to"] || null;
  const references = headers["references"] || null;
  const contentType = (headers["content-type"] || "text/plain").toLowerCase();

  let bodyText = "";

  if (contentType.includes("multipart/")) {
    // Extract boundary
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      bodyText = extractTextFromMultipart(bodyPart, boundary);
    } else {
      bodyText = bodyPart;
    }
  } else if (contentType.includes("text/html")) {
    bodyText = stripHtml(bodyPart);
  } else {
    bodyText = bodyPart;
  }

  // Strip quoted reply content (lines starting with >)
  bodyText = stripQuotedContent(bodyText);

  // Clean up
  bodyText = bodyText.replace(/\r\n/g, "\n").trim();

  // Limit length
  if (bodyText.length > 10000) {
    bodyText = bodyText.slice(0, 10000) + "\n[truncated]";
  }

  return { subject, bodyText, inReplyTo, references };
}

function extractTextFromMultipart(body, boundary) {
  const parts = body.split(`--${boundary}`);
  // Look for text/plain first, fall back to text/html
  let plainText = "";
  let htmlText = "";

  for (const part of parts) {
    if (part.trim() === "--" || part.trim() === "") continue;

    const partHeaderEnd = part.indexOf("\r\n\r\n");
    if (partHeaderEnd < 0) continue;

    const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
    const partBody = part.slice(partHeaderEnd + 4);

    if (partHeaders.includes("text/plain")) {
      plainText = partBody;
    } else if (partHeaders.includes("text/html")) {
      htmlText = partBody;
    }
  }

  if (plainText) return plainText;
  if (htmlText) return stripHtml(htmlText);
  return body;
}

function stripHtml(html) {
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

function stripQuotedContent(text) {
  const lines = text.split("\n");
  const result = [];
  for (const line of lines) {
    // Stop at common reply markers
    if (/^on .+ wrote:$/i.test(line.trim())) break;
    if (/^-{2,}\s*original message/i.test(line.trim())) break;
    if (/^>{2,}/.test(line)) continue; // Skip deeply quoted
    if (/^>/.test(line)) continue; // Skip single-quoted
    result.push(line);
  }
  return result.join("\n");
}

function decodeHeader(value) {
  // Basic RFC 2047 decode (=?charset?encoding?text?=)
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, text) => {
    if (encoding.toUpperCase() === "B") {
      return Buffer.from(text, "base64").toString("utf-8");
    }
    // Q encoding
    return text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  });
}

async function fireWebhook(db, mailboxId, eventType, payload) {
  try {
    const result = await db.query(
      `SELECT url, events FROM internal.email_webhooks WHERE mailbox_id = $1`,
      [mailboxId],
    );
    for (const row of result.rows) {
      const events = typeof row.events === "string" ? JSON.parse(row.events) : row.events;
      if (!events.includes(eventType)) continue;

      // Best-effort fire — don't retry from Lambda (event Lambda handles retries)
      try {
        const resp = await fetch(row.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: eventType, ...payload }),
          signal: AbortSignal.timeout(5000),
        });
        console.log(`Webhook fired to ${row.url}: ${resp.status}`);
      } catch (err) {
        console.error(`Webhook failed for ${row.url}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Webhook query failed:", err.message);
  }
}
