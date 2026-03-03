import { Router, Request, Response } from "express";
import { notifyMessage } from "../services/telegram.js";

const router = Router();

router.post("/v1/message", (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Missing or empty 'message' field" });
    return;
  }

  // Fire-and-forget Telegram notification
  notifyMessage(message.trim());

  res.json({ status: "sent" });
});

export default router;
