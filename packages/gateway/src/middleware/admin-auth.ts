/**
 * Admin auth middleware — detects admin identity from multiple mechanisms.
 *
 * Detection order: ADMIN_KEY header → SIWx with admin wallet → session cookie.
 * Sets req.isAdmin = true on success. Non-blocking: calls next() regardless.
 *
 * Composed middleware:
 *   serviceKeyOrAdmin — tries serviceKeyAuth, then adminAuth, 401 if neither
 *   walletAuthOrAdmin — tries walletAuth(false), then adminAuth, 401 if neither
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { parseSIWxHeader, verifySIWxSignature } from "@x402/extensions/sign-in-with-x";
import { ADMIN_KEY, ADMIN_SESSION_SECRET } from "../config.js";
import { isAdminWallet } from "../services/admin-wallets.js";
import { serviceKeyAuth } from "./apikey.js";
import { walletAuth } from "./wallet-auth.js";

const SESSION_COOKIE = "run402_admin";
const MAX_AGE_MS = 5 * 60 * 1000;

// --- Session cookie verification (shared with admin-dashboard.ts) ---

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

export function getAdminSession(req: Request): { email: string; name: string } | null {
  const raw = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const cookie = raw.split("=").slice(1).join("=");
  const [b64, sig] = cookie.split(".");
  if (!b64 || !sig) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmacSign(b64), "hex"), Buffer.from(sig, "hex"))) return null;
  } catch { return null; }
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return { email: data.email, name: data.name };
  } catch { return null; }
}

// --- Core admin detection ---

/**
 * Non-blocking middleware: sets req.isAdmin = true if admin credentials found.
 * Always calls next() — does NOT reject non-admin requests.
 */
export async function adminAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // 1. ADMIN_KEY header (cheapest check) — supports both X-Admin-Key and Authorization: Bearer
  const xAdminKey = req.headers["x-admin-key"] as string | undefined;
  if (ADMIN_KEY && xAdminKey === ADMIN_KEY) {
    req.isAdmin = true;
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (ADMIN_KEY && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === ADMIN_KEY) {
      req.isAdmin = true;
      next();
      return;
    }
  }

  // 2. SIWx with admin wallet
  const siwxHeader = req.headers["sign-in-with-x"] as string | undefined;
  if (siwxHeader) {
    try {
      const payload = parseSIWxHeader(siwxHeader);

      // Temporal validation
      if (payload.expirationTime && new Date(payload.expirationTime).getTime() < Date.now()) {
        next(); return;
      }
      if (payload.issuedAt && Date.now() - new Date(payload.issuedAt).getTime() > MAX_AGE_MS) {
        next(); return;
      }

      const verification = await verifySIWxSignature(payload);
      if (verification.valid && verification.address) {
        const normalized = verification.address.toLowerCase();
        req.walletAddress = normalized;
        if (isAdminWallet(normalized)) {
          req.isAdmin = true;
          next();
          return;
        }
      }
    } catch { /* invalid SIWx, continue */ }
  }

  // 3. Session cookie
  const session = getAdminSession(req);
  if (session) {
    req.isAdmin = true;
    next();
    return;
  }

  next();
}

// --- Composed middleware ---

/**
 * Tries adminAuth first (non-blocking), then serviceKeyAuth.
 * If admin → next(). If service_key → next(). If neither → 401.
 */
export async function serviceKeyOrAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try admin detection first (non-blocking, just sets req.isAdmin)
  await new Promise<void>((resolve) => adminAuth(req, res, () => resolve()));

  if (req.isAdmin) {
    next();
    return;
  }

  // Fall through to serviceKeyAuth
  serviceKeyAuth(req, res, next);
}

/**
 * Tries adminAuth first (non-blocking), then walletAuth(false).
 * If admin → next(). If wallet → next(). If neither → 401.
 */
export async function walletAuthOrAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try admin detection first (non-blocking, just sets req.isAdmin)
  await new Promise<void>((resolve) => adminAuth(req, res, () => resolve()));

  if (req.isAdmin) {
    next();
    return;
  }

  // Fall through to walletAuth
  const walletMiddleware = walletAuth(false);
  walletMiddleware(req, res, next);
}
