import jwt from "jsonwebtoken";
import { config } from "./config.js";

export interface User {
  id: string;
  role: string;
  email: string;
}

/**
 * Verify the caller's JWT and return user identity.
 * Returns { id, role, email } or null if unauthenticated/invalid.
 */
export function getUser(req: Request): User | null {
  const authHeader =
    typeof (req.headers as unknown as Record<string, string>).get === "function"
      ? (req.headers as Headers).get("authorization")
      : (req.headers as unknown as Record<string, string | undefined>)?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as {
      sub: string;
      role: string;
      email: string;
      project_id: string;
    };
    if (payload.project_id !== config.PROJECT_ID) return null;
    return { id: payload.sub, role: payload.role, email: payload.email };
  } catch {
    return null;
  }
}
