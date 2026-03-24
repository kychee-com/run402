/**
 * SES event processing Lambda.
 *
 * Triggered by SNS topic receiving SES delivery/bounce/complaint notifications.
 * Updates message status, manages suppression lists, auto-suspends on abuse.
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD — Aurora connection
 */

import pg from "pg";

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
    try {
      const snsMessage = JSON.parse(record.Sns.Message);
      await processSesEvent(snsMessage);
    } catch (err) {
      console.error("Failed to process SES event:", err.message);
    }
  }
}

async function processSesEvent(message) {
  const eventType = message.eventType || message.notificationType;
  const db = getPool();

  if (eventType === "Delivery") {
    await handleDelivery(db, message);
  } else if (eventType === "Bounce") {
    await handleBounce(db, message);
  } else if (eventType === "Complaint") {
    await handleComplaint(db, message);
  } else {
    console.log(`Unhandled SES event type: ${eventType}`);
  }
}

async function handleDelivery(db, message) {
  const sesMessageId = message.mail?.messageId;
  if (!sesMessageId) return;

  const result = await db.query(
    `UPDATE internal.email_messages SET status = 'delivered' WHERE ses_message_id = $1 AND direction = 'outbound' RETURNING id, mailbox_id`,
    [sesMessageId],
  );

  if (result.rows.length > 0) {
    console.log(`Delivery confirmed: ${sesMessageId}`);
    await fireWebhooks(db, result.rows[0].mailbox_id, "delivery", {
      message_id: result.rows[0].id,
      ses_message_id: sesMessageId,
    });
  }
}

async function handleBounce(db, message) {
  const sesMessageId = message.mail?.messageId;
  const bounceType = message.bounce?.bounceType;
  if (!sesMessageId) return;

  // Update message status
  const result = await db.query(
    `UPDATE internal.email_messages SET status = 'bounced' WHERE ses_message_id = $1 AND direction = 'outbound' RETURNING id, mailbox_id, to_address`,
    [sesMessageId],
  );

  if (result.rows.length === 0) return;

  const { id: msgId, mailbox_id: mailboxId, to_address: toAddress } = result.rows[0];
  console.log(`Bounce (${bounceType}): ${sesMessageId} → ${toAddress}`);

  // Hard bounce → add to project suppression list
  if (bounceType === "Permanent" && toAddress) {
    // Get project_id from mailbox
    const mbxResult = await db.query(
      `SELECT project_id FROM internal.mailboxes WHERE id = $1`,
      [mailboxId],
    );
    const projectId = mbxResult.rows[0]?.project_id;
    if (projectId) {
      await db.query(
        `INSERT INTO internal.email_suppressions (email_address, scope, project_id, reason)
         VALUES ($1, 'project', $2, 'bounce')
         ON CONFLICT DO NOTHING`,
        [toAddress, projectId],
      );
      console.log(`Added ${toAddress} to project suppression list`);
    }

    // Check bounce threshold — 3 hard bounces in 24h → suspend
    const bounceCount = await db.query(
      `SELECT COUNT(*) FROM internal.email_messages
       WHERE mailbox_id = $1 AND status = 'bounced' AND created_at > NOW() - INTERVAL '24 hours'`,
      [mailboxId],
    );
    if (parseInt(bounceCount.rows[0].count) >= 3) {
      await db.query(
        `UPDATE internal.mailboxes SET status = 'suspended', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
        [mailboxId],
      );
      console.log(`Mailbox ${mailboxId} suspended: bounce threshold exceeded`);
    }
  }

  await fireWebhooks(db, mailboxId, "bounced", {
    message_id: msgId,
    to_address: toAddress,
    bounce_type: bounceType,
  });
}

async function handleComplaint(db, message) {
  const sesMessageId = message.mail?.messageId;
  if (!sesMessageId) return;

  // Update message status
  const result = await db.query(
    `UPDATE internal.email_messages SET status = 'complained' WHERE ses_message_id = $1 AND direction = 'outbound' RETURNING id, mailbox_id, to_address`,
    [sesMessageId],
  );

  if (result.rows.length === 0) return;

  const { id: msgId, mailbox_id: mailboxId, to_address: toAddress } = result.rows[0];
  console.log(`Complaint: ${sesMessageId} from ${toAddress}`);

  // Add to global suppression list
  if (toAddress) {
    await db.query(
      `INSERT INTO internal.email_suppressions (email_address, scope, project_id, reason)
       VALUES ($1, 'global', '', 'complaint')
       ON CONFLICT DO NOTHING`,
      [toAddress],
    );
    console.log(`Added ${toAddress} to global suppression list`);
  }

  // Suspend mailbox immediately on first complaint
  await db.query(
    `UPDATE internal.mailboxes SET status = 'suspended', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
    [mailboxId],
  );
  console.log(`Mailbox ${mailboxId} suspended: spam complaint`);

  await fireWebhooks(db, mailboxId, "complained", {
    message_id: msgId,
    to_address: toAddress,
  });
}

async function fireWebhooks(db, mailboxId, eventType, payload) {
  try {
    const result = await db.query(
      `SELECT url, events FROM internal.email_webhooks WHERE mailbox_id = $1`,
      [mailboxId],
    );
    for (const row of result.rows) {
      const events = typeof row.events === "string" ? JSON.parse(row.events) : row.events;
      if (!events.includes(eventType)) continue;

      // Retry up to 3 times with exponential backoff
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(row.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: eventType, mailbox_id: mailboxId, ...payload }),
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok) {
            console.log(`Webhook fired to ${row.url}: ${resp.status}`);
            break;
          }
          console.warn(`Webhook ${row.url} returned ${resp.status}, attempt ${attempt + 1}/3`);
        } catch (err) {
          console.warn(`Webhook ${row.url} failed, attempt ${attempt + 1}/3:`, err.message);
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } else {
          console.error(`Webhook ${row.url} failed after 3 attempts (event: ${eventType})`);
        }
      }
    }
  } catch (err) {
    console.error("Webhook query failed:", err.message);
  }
}
