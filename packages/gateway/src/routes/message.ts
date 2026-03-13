import { Router, Request, Response } from "express";
import { notifyMessage } from "../services/telegram.js";
import { walletAuth } from "../middleware/wallet-auth.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

router.get("/message/v1", (_req: Request, res: Response) => {
  res.json({
    description: "Send a message to Run402 developers (free with active tier)",
    method: "POST",
    auth: "EIP-4361 wallet signature",
    body: { message: "string (required)" },
  });
});

router.post("/message/v1", walletAuth(false), asyncHandler(async (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new HttpError(400, "Missing or empty 'message' field");
  }

  // Fire-and-forget Telegram notification
  notifyMessage(message.trim());

  res.json({ status: "sent" });
}));

export default router;
