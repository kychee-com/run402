import { Router, Request, Response } from "express";
import { isAddress } from "viem";
import { sendDrip } from "../services/faucet.js";
import { FAUCET_TREASURY_KEY, FAUCET_DRIP_AMOUNT, FAUCET_DRIP_COOLDOWN } from "../config.js";

const router = Router();

// In-memory per-IP rate limit
const dripTimestamps = new Map<string, number>();

// Clean up stale entries hourly
setInterval(() => {
  const cutoff = Date.now() - FAUCET_DRIP_COOLDOWN;
  for (const [ip, ts] of dripTimestamps) {
    if (ts < cutoff) dripTimestamps.delete(ip);
  }
}, 60 * 60 * 1000);

router.post("/v1/faucet", async (req: Request, res: Response) => {
  // Check faucet is configured
  if (!FAUCET_TREASURY_KEY) {
    res.status(503).json({ error: "Faucet not configured" });
    return;
  }

  // Validate address
  const { address } = req.body || {};
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "Invalid or missing Ethereum address" });
    return;
  }

  // Rate limit by IP
  const ip = req.ip || "unknown";
  const lastDrip = dripTimestamps.get(ip);
  if (lastDrip && Date.now() - lastDrip < FAUCET_DRIP_COOLDOWN) {
    const retryAfter = Math.ceil((FAUCET_DRIP_COOLDOWN - (Date.now() - lastDrip)) / 1000);
    res.status(429).json({
      error: "Rate limit exceeded. One drip per 24 hours.",
      retry_after: retryAfter,
    });
    return;
  }

  try {
    const transactionHash = await sendDrip(address as `0x${string}`);
    dripTimestamps.set(ip, Date.now());

    res.json({
      transactionHash,
      amount: FAUCET_DRIP_AMOUNT,
      token: "USDC",
      network: "base-sepolia",
    });
  } catch (err: any) {
    if (err.code === "TREASURY_LOW") {
      res.status(503).json({ error: "Treasury balance too low. Try again later." });
    } else {
      console.error("Faucet drip error:", err.message);
      res.status(500).json({ error: "Failed to send drip" });
    }
  }
});

export default router;
