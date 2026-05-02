import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAllowancePath } from "./config.js";

export interface AllowanceData {
  address: string;
  privateKey: string;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
  rail?: "x402" | "mpp";
}

// 0x-prefixed 40-hex EVM address.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// 0x-prefixed 64-hex secp256k1 private key (32 bytes).
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * Load the agent allowance from disk.
 *
 * Returns `null` for the two "no allowance configured" cases:
 *   - the file does not exist
 *   - the file exists but is not parseable JSON (preserve existing UX —
 *     consumers print "no_allowance" and tell the user to run init)
 *
 * Throws a structured `Error` (GH-194) when the file parses as JSON but the
 * shape is wrong (missing/wrong-type/wrong-length fields). Without this guard
 * downstream callers crash with raw stack traces:
 *   - `cli/lib/status.mjs` reaches for `allowance.address.toLowerCase()`
 *     and crashes with `TypeError: Cannot read properties of undefined`.
 *   - `core/src/allowance-auth.ts` passes a malformed `privateKey` to
 *     `@noble/curves` which throws "expected 32 bytes, got N".
 *
 * The CLI's `cli/lib/config.mjs:readAllowance()` wrapper and the MCP
 * `src/tools/{status,init}.ts` callers translate the throw into their own
 * structured envelopes (`code: BAD_ALLOWANCE_FILE`).
 */
export function readAllowance(path?: string): AllowanceData | null {
  const p = path ?? getAllowancePath();
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Preserve historical UX — completely unparseable input reads as "no
    // allowance configured" rather than as an error. Consumers already handle
    // null with a friendly "run 'run402 init'" message.
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `allowance.json must contain a JSON object (got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      }). Back up the file and run 'run402 init' to recreate it.`,
    );
  }
  const data = parsed as Partial<AllowanceData>;
  if (typeof data.address !== "string" || !ADDRESS_RE.test(data.address)) {
    throw new Error(
      "allowance.json missing valid 'address' (expected 0x-prefixed 40-hex string). " +
        "Back up the file and run 'run402 init' to recreate it.",
    );
  }
  if (typeof data.privateKey !== "string" || !PRIVATE_KEY_RE.test(data.privateKey)) {
    throw new Error(
      "allowance.json missing valid 'privateKey' (expected 0x-prefixed 64-hex string). " +
        "Back up the file and run 'run402 init' to recreate it.",
    );
  }
  return data as AllowanceData;
}

export function saveAllowance(data: AllowanceData, path?: string): void {
  const p = path ?? getAllowancePath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.allowance.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}
