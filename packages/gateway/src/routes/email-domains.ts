import { Router, Request, Response } from "express";
import { serviceKeyAuth } from "../middleware/apikey.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { registerSenderDomain, getSenderDomainStatus, removeSenderDomain } from "../services/email-domains.js";

const router = Router();

router.use("/email/v1/domains", serviceKeyAuth);

// POST /email/v1/domains — register a custom sender domain
router.post("/email/v1/domains", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const { domain } = req.body || {};

  if (!domain) {
    throw new HttpError(400, "domain required");
  }

  const walletAddress = project.walletAddress;
  if (!walletAddress) {
    throw new HttpError(400, "Project has no wallet address");
  }

  const result = await registerSenderDomain(project.id, walletAddress, domain);

  if (result.error) {
    // Distinguish 409 (conflict) from 400 (validation)
    const status = result.message?.includes("another") || result.message?.includes("already has") ? 409 : 400;
    res.status(status).json({ error: result.message });
    return;
  }

  res.status(201).json(result);
}));

// GET /email/v1/domains — check sender domain status
router.get("/email/v1/domains", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const result = await getSenderDomainStatus(project.id);

  if (!result) {
    res.json({ domain: null });
    return;
  }

  res.json(result);
}));

// DELETE /email/v1/domains — remove sender domain
router.delete("/email/v1/domains", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const removed = await removeSenderDomain(project.id);

  if (!removed) {
    throw new HttpError(404, "No sender domain registered for this project");
  }

  res.json({ status: "ok", message: "Sender domain removed. Email will send from mail.run402.com." });
}));

export default router;
