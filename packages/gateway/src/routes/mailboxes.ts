/**
 * Mailbox routes — project-scoped email at <slug>@mail.run402.com
 *
 * POST   /v1/mailboxes                      — Create mailbox (service_key auth)
 * GET    /v1/mailboxes                      — List project's mailboxes (service_key auth)
 * GET    /v1/mailboxes/:id                  — Get mailbox details (service_key auth)
 * DELETE /v1/mailboxes/:id                  — Delete mailbox (service_key auth)
 * POST   /v1/mailboxes/:id/messages         — Send email (service_key auth)
 * GET    /v1/mailboxes/:id/messages         — List messages (service_key auth)
 * GET    /v1/mailboxes/:id/messages/:msgId  — Get message with replies (service_key auth)
 * POST   /v1/mailboxes/:id/webhooks         — Register webhook (service_key auth)
 * POST   /v1/mailboxes/:id/status           — Admin reactivate (admin auth)
 */

import { Router, Request, Response } from "express";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { serviceKeyOrAdmin } from "../middleware/admin-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { validateUUID, validatePaginationInt, validateURL } from "../utils/validate.js";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import {
  validateSlug,
  formatAddress,
  createMailbox,
  getMailbox,
  listMailboxes,
  deleteMailbox,
  reactivateMailbox,
  MailboxError,
} from "../services/mailbox.js";
import {
  sendEmail,
  listMessages,
  getMessage,
} from "../services/email-send.js";

const router = Router();

function formatMailboxResponse(record: {
  id: string;
  slug: string;
  project_id: string;
  status: string;
  sends_today: number;
  unique_recipients: number;
  created_at: string;
  updated_at: string;
}) {
  return {
    mailbox_id: record.id,
    address: formatAddress(record.slug),
    slug: record.slug,
    project_id: record.project_id,
    status: record.status,
    sends_today: record.sends_today,
    unique_recipients: record.unique_recipients,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

// POST /v1/mailboxes — create a mailbox
router.post("/mailboxes/v1", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const { slug } = req.body || {};

  if (!slug || typeof slug !== "string") {
    throw new HttpError(400, "Missing or invalid 'slug' field");
  }

  const validationError = validateSlug(slug);
  if (validationError) {
    throw new HttpError(400, validationError);
  }

  const projectId = req.project?.id;
  if (!projectId) throw new HttpError(401, "No project context");

  try {
    const record = await createMailbox(slug, projectId);
    res.status(201).json(formatMailboxResponse(record));
  } catch (err: unknown) {
    if (err instanceof MailboxError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /v1/mailboxes — list project's mailboxes
router.get("/mailboxes/v1", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.project?.id;
  if (!projectId) throw new HttpError(401, "No project context");

  const records = await listMailboxes(projectId);
  res.json({ mailboxes: records.map(formatMailboxResponse) });
}));

// GET /v1/mailboxes/:id — get mailbox details
router.get("/mailboxes/v1/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  const record = await getMailbox(req.params.id as string);
  if (!record) throw new HttpError(404, "Mailbox not found");

  const projectId = req.project?.id;
  if (projectId && record.project_id !== projectId) {
    throw new HttpError(403, "Mailbox owned by different project");
  }

  res.json(formatMailboxResponse(record));
}));

// DELETE /v1/mailboxes/:id — delete (tombstone) a mailbox
router.delete("/mailboxes/v1/:id", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  const projectId = req.project?.id;
  if (!projectId) throw new HttpError(401, "No project context");

  try {
    const deleted = await deleteMailbox(req.params.id as string, projectId);
    if (!deleted) throw new HttpError(404, "Mailbox not found");

    const record = await getMailbox(req.params.id as string);
    res.json({ status: "deleted", address: record ? formatAddress(record.slug) : "" });
  } catch (err: unknown) {
    if (err instanceof MailboxError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// POST /v1/mailboxes/:id/messages — send email
router.post("/mailboxes/v1/:id/messages", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  const { template, to, variables } = req.body || {};

  if (!template || typeof template !== "string") {
    throw new HttpError(400, "Missing or invalid 'template' field");
  }
  if (!to || typeof to !== "string") {
    throw new HttpError(400, "Missing or invalid 'to' field — must be a single email address");
  }
  if (Array.isArray(to)) {
    throw new HttpError(400, "Only one recipient per send");
  }

  // Verify mailbox belongs to project
  const mailbox = await getMailbox(req.params.id as string);
  if (!mailbox) throw new HttpError(404, "Mailbox not found");

  const projectId = req.project?.id;
  if (projectId && mailbox.project_id !== projectId) {
    throw new HttpError(403, "Mailbox owned by different project");
  }

  try {
    const result = await sendEmail(
      req.params.id as string,
      template,
      to,
      variables || {},
    );
    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof MailboxError) {
      // 402 errors include JSON body with upgrade info
      if (err.statusCode === 402) {
        try {
          const body = JSON.parse(err.message);
          throw new HttpError(402, body.error, body);
        } catch (parseErr) {
          if (parseErr instanceof HttpError) throw parseErr;
        }
      }
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }
}));

// GET /v1/mailboxes/:id/messages — list messages
router.get("/mailboxes/v1/:id/messages", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  const mailbox = await getMailbox(req.params.id as string);
  if (!mailbox) throw new HttpError(404, "Mailbox not found");

  const projectId = req.project?.id;
  if (projectId && mailbox.project_id !== projectId) {
    throw new HttpError(403, "Mailbox owned by different project");
  }

  const limit = validatePaginationInt(req.query.limit, "limit", { fallback: 50, max: 200 });
  const cursor = req.query.after as string | undefined;

  const result = await listMessages(req.params.id as string, limit, cursor);
  res.json(result);
}));

// GET /v1/mailboxes/:id/messages/:messageId — get single message with replies
router.get("/mailboxes/v1/:id/messages/:messageId", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  validateUUID(req.params.messageId, "messageId");
  const mailbox = await getMailbox(req.params.id as string);
  if (!mailbox) throw new HttpError(404, "Mailbox not found");

  const projectId = req.project?.id;
  if (projectId && mailbox.project_id !== projectId) {
    throw new HttpError(403, "Mailbox owned by different project");
  }

  const message = await getMessage(req.params.id as string, req.params.messageId as string);
  if (!message) throw new HttpError(404, "Message not found");

  res.json(message);
}));

// POST /v1/mailboxes/:id/webhooks — register webhook
router.post("/mailboxes/v1/:id/webhooks", serviceKeyAuth, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  const { url, events } = req.body || {};

  validateURL(url, "url");
  if (!events || !Array.isArray(events) || events.length === 0) {
    throw new HttpError(400, "Missing or invalid 'events' array");
  }

  const validEvents = ["delivery", "bounced", "complained", "reply_received"];
  for (const e of events) {
    if (!validEvents.includes(e)) {
      throw new HttpError(400, `Invalid event: ${e}. Valid events: ${validEvents.join(", ")}`);
    }
  }

  const mailbox = await getMailbox(req.params.id as string);
  if (!mailbox) throw new HttpError(404, "Mailbox not found");

  const projectId = req.project?.id;
  if (projectId && mailbox.project_id !== projectId) {
    throw new HttpError(403, "Mailbox owned by different project");
  }

  const webhookId = `whk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    sql(`INSERT INTO internal.email_webhooks (id, mailbox_id, url, events) VALUES ($1, $2, $3, $4)`),
    [webhookId, req.params.id, url, JSON.stringify(events)],
  );

  res.status(201).json({ webhook_id: webhookId, url, events });
}));

// POST /v1/mailboxes/:id/status — admin-only reactivate suspended mailbox
router.post("/mailboxes/v1/:id/status", serviceKeyOrAdmin, asyncHandler(async (req: Request, res: Response) => {
  validateUUID(req.params.id, "mailbox_id");
  if (!req.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }

  const { status } = req.body || {};
  if (status !== "active") {
    throw new HttpError(400, "Only 'active' status is supported for reactivation");
  }

  const reactivated = await reactivateMailbox(req.params.id as string);
  if (!reactivated) {
    throw new HttpError(404, "Mailbox not found or not suspended");
  }

  res.json({ status: "active", mailbox_id: req.params.id });
}));

export default router;
