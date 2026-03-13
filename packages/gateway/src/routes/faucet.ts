import { Router, Request, Response } from "express";
import { isAddress } from "viem";
import { sendDrip, getTreasuryBalance, recordFaucetSnapshot } from "../services/faucet.js";
import { FAUCET_TREASURY_KEY, FAUCET_DRIP_AMOUNT, FAUCET_DRIP_COOLDOWN, ADMIN_KEY } from "../config.js";
import { hasCode } from "../utils/errors.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";
import { recordWallet } from "../utils/wallet.js";

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

router.post("/v1/faucet", asyncHandler(async (req: Request, res: Response) => {
  if (!FAUCET_TREASURY_KEY) {
    throw new HttpError(503, "Faucet not configured");
  }

  const { address } = req.body || {};
  if (!address || !isAddress(address)) {
    throw new HttpError(400, "Invalid or missing Ethereum address");
  }

  // Rate limit by IP
  const ip = req.ip || "unknown";
  const lastDrip = dripTimestamps.get(ip);
  if (lastDrip && Date.now() - lastDrip < FAUCET_DRIP_COOLDOWN) {
    const retryAfter = Math.ceil((FAUCET_DRIP_COOLDOWN - (Date.now() - lastDrip)) / 1000);
    throw new HttpError(429, `Rate limit exceeded. One drip per 24 hours. Retry after ${retryAfter}s`);
  }

  recordWallet(address, "faucet");

  try {
    const transactionHash = await sendDrip(address as `0x${string}`);
    dripTimestamps.set(ip, Date.now());

    // Snapshot balance after drip (fire-and-forget)
    getTreasuryBalance().then(b => recordFaucetSnapshot(b, "drip")).catch(() => {});

    res.json({
      transactionHash,
      amount_usd_micros: Math.round(parseFloat(FAUCET_DRIP_AMOUNT) * 1_000_000),
      token: "USDC",
      network: "base-sepolia",
    });
  } catch (err: unknown) {
    if (hasCode(err) && err.code === "TREASURY_LOW") {
      throw new HttpError(503, "Treasury balance too low. Try again later.");
    }
    throw err;
  }
}));

// POST /admin/v1/faucet — admin drip (no rate limit, custom amount, admin only)
router.post("/admin/v1/faucet", asyncHandler(async (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    throw new HttpError(403, "Requires platform admin key");
  }

  if (!FAUCET_TREASURY_KEY) {
    throw new HttpError(503, "Faucet not configured");
  }

  const { address, amount } = req.body || {};
  if (!address || !isAddress(address)) {
    throw new HttpError(400, "Invalid or missing Ethereum address");
  }

  const dripAmount = typeof amount === "string" && /^\d+(\.\d+)?$/.test(amount) ? amount : FAUCET_DRIP_AMOUNT;

  try {
    const transactionHash = await sendDrip(address as `0x${string}`, dripAmount);
    getTreasuryBalance().then(b => recordFaucetSnapshot(b, "admin-drip")).catch(() => {});
    console.log(`  Admin faucet: ${dripAmount} USDC to ${address}`);

    res.json({
      transactionHash,
      amount_usd_micros: Math.round(parseFloat(dripAmount) * 1_000_000),
      token: "USDC",
      network: "base-sepolia",
    });
  } catch (err: unknown) {
    if (hasCode(err) && err.code === "TREASURY_LOW") {
      throw new HttpError(503, "Treasury balance too low.");
    }
    throw err;
  }
}));

export default router;
