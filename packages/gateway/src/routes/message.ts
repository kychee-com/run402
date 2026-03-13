import { Router, Request, Response } from "express";
import { notifyMessage } from "../services/telegram.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

const router = Router();

router.get("/v1/message", (_req: Request, res: Response) => {
  res.json({
    description: "Send a message to Run402 developers",
    price: "$0.01",
    method: "POST",
    body: { message: "string (required)" },
  });
});

router.post("/v1/message", asyncHandler(async (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new HttpError(400, "Missing or empty 'message' field");
  }

  // Fire-and-forget Telegram notification
  notifyMessage(message.trim());

  res.json({ status: "sent" });
}));

export default router;
