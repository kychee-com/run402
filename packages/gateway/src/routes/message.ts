import { Router, Request, Response } from "express";
import { notifyMessage } from "../services/telegram.js";

const router = Router();

router.get("/v1/message", (_req: Request, res: Response) => {
  res.json({
    description: "Send a message to Run402 developers",
    price: "$0.01 USDC",
    method: "POST",
    body: { message: "string (required)" },
  });
});

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
