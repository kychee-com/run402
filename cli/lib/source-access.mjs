/**
 * `run402 source-access` — a human member's source-access custody, read side.
 *
 * Gateway subsystem: gitvault-recovery-custody (/agent/v1/source-access/*).
 * A member's gitvault decryption key exists only as sealed `swrap2_` wrappers
 * (passkey PRF and/or source recovery code). Enrollment, activation, and
 * revocation are BROWSER ceremonies (WebAuthn) at console.run402.com/account
 * — this command family is deliberately read-only: `status` (what wrappers
 * exist, their states, the custody scheme) and `export` (the versioned
 * member recovery bundle that makes the recovery code work with NO run402
 * server). A server-side wrapper row alone is NOT offline backup — the
 * exported bundle, kept in your own storage separately from the code, is.
 *
 * Auth: your control-plane (human) session — `run402 operator login
 * --loopback` first. Without one the request falls back to the active
 * WALLET identity, which answers for the AGENT principal (normally no
 * wrappers) — truthful, but probably not what a human wanted; a stderr note
 * says so.
 */
import { writeFileSync } from "node:fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  flagValue,
  requirePositionalCount,
  failUnknownSubcommand,
} from "./argparse.mjs";
import { readControlPlaneSession, isControlPlaneSessionExpired } from "../core-dist/control-plane-session.js";

const HELP = `run402 source-access — your source-access key wrappers (gitvault member custody)

Usage:
  run402 source-access status
  run402 source-access export [--out <file> | --out -]

Commands:
  status   Your source-access key + wrapper set: custody scheme, each
           wrapper's kind (webauthn_prf / recovery_code) and state
           (pending / active / revoked). Principal-scoped — only ever YOUR
           wrappers. Read-only.
  export   Download your versioned member recovery bundle
           (r402s-member-recovery-bundle/v1): key identity + every ACTIVE
           wrapper ciphertext. Together with your source recovery code —
           kept SEPARATELY — it recovers your vaults with no run402 server
           (\`run402 repos recover <mirror> --bundle <file> --receipt <pin>\`).
           Writes run402-source-recovery-bundle-<fingerprint>.json (0600) in
           the current directory unless --out says otherwise; the full JSON
           also goes to stdout (pipe contract). To make the bundle travel
           WITH a vault mirror, copy it to member-recovery-bundles/<name>.json
           under the mirrored prefix — recover finds it there automatically.

Options:
  --out <file>   export: where to write the bundle (0600). \`--out -\` skips
                 the file and prints to stdout only.
  --json         Already the default output; accepted for consistency.

Auth:
  Sign in as YOURSELF first: run402 operator login --loopback
  (Without a control-plane session the call answers for the active WALLET's
  agent principal — normally an empty wrapper set.)

Enrollment / activation / revocation / code replacement are browser
ceremonies: console.run402.com/account → Source access.

Examples:
  run402 operator login --loopback
  run402 source-access status
  run402 source-access export --out ./bundle.json
`;

/** The cached control-plane WRITE session's bearer, or null (falls back to wallet SIWX with a stderr note). */
function controlPlaneToken() {
  const cp = readControlPlaneSession();
  if (cp && !isControlPlaneSessionExpired(cp, Date.now())) return cp.control_plane_session_token;
  return null;
}

function tokenOptsWithNote(command) {
  const token = controlPlaneToken();
  if (!token) {
    process.stderr.write(
      `no control-plane (human) session — ${command} will answer for the active WALLET's agent principal, which normally holds no wrappers. Run 'run402 operator login --loopback' to see your own.\n`,
    );
    return {};
  }
  return { token };
}

async function status(args) {
  assertKnownFlags(args, ["--json", "--help", "-h"]);
  requirePositionalCount(args, [], { min: 0, max: 0, command: "run402 source-access status", missing: "" });
  const sdk = getSdk();
  try {
    const result = await sdk.operator.session.sourceAccessWrappers(tokenOptsWithNote("status"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.encryption_key) {
      console.error("no source-access key enrolled — enroll at console.run402.com/account → Source access.");
      return;
    }
    const active = result.wrappers.filter((w) => w.state === "active");
    const pending = result.wrappers.filter((w) => w.state === "pending");
    console.error(
      `${result.encryption_key.ek_fingerprint} (${result.encryption_key.custody_scheme}, ${result.encryption_key.state}): ` +
        `${active.length} active wrapper(s) [${active.map((w) => w.kind).join(", ") || "none"}]` +
        (pending.length > 0 ? `, ${pending.length} pending (unfinished enrollment — finish or it expires)` : "") + ".",
    );
    if (active.length > 0 && !active.some((w) => w.kind === "recovery_code")) {
      console.error("no recovery_code wrapper — a passkey-only key has no offline/no-server recovery path; add a recovery code at console.run402.com/account.");
    }
  } catch (err) {
    reportSdkError(err);
  }
}

async function exportBundle(args) {
  assertKnownFlags(args, ["--out", "--json", "--help", "-h"], ["--out"]);
  requirePositionalCount(args, ["--out"], { min: 0, max: 0, command: "run402 source-access export", missing: "" });
  const out = flagValue(args, "--out");
  const sdk = getSdk();
  try {
    const bundle = await sdk.operator.session.sourceAccessRecoveryBundle(tokenOptsWithNote("export"));
    // Full JSON to stdout regardless — the pipe contract is sacred; the file
    // is the keep-a-copy convenience (0600 — the bundle is ciphertext the
    // platform cannot open, but it is still half of a recovery credential).
    console.log(JSON.stringify(bundle, null, 2));
    if (out !== "-") {
      const path = out ?? `run402-source-recovery-bundle-${(bundle.ek_fingerprint || "key").slice(0, 11)}.json`;
      writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
      console.error(`bundle written to ${path} (0600).`);
    }
    console.error("keep this bundle SEPARATELY from your source recovery code — together they are equivalent to your member private key.");
    console.error("to make it travel with a vault mirror: copy it to member-recovery-bundles/<name>.json under the mirrored prefix; `run402 repos recover` finds it there.");
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args = []) {
  args = normalizeArgv(args);
  if (!sub || sub === "--help" || sub === "-h" || hasHelp(args)) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status":
      await status(args);
      break;
    case "export":
      await exportBundle(args);
      break;
    default:
      failUnknownSubcommand("source-access", sub, {
        hint: "Run `run402 source-access --help` for usage (subcommands: status, export).",
      });
  }
}
