/**
 * run402 webhook-secret — Manage the operator webhook signing secret.
 *
 * Split out from notifications.mjs so the SURFACE inventory parser sees
 * `webhook-secret:rotate` as its own command, separate from the
 * `notifications:*` group.
 */

import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, normalizeArgv } from "./argparse.mjs";

const HELP = `run402 webhook-secret — Manage the operator webhook signing secret

Usage:
  run402 webhook-secret rotate

Notes:
  - Returns the new plaintext secret EXACTLY once. Store it immediately.
  - Previous secret remains valid for 24 hours after rotation.
  - Requires operator_passkey assurance level.
`;

export async function run(sub, args = []) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (sub !== "rotate") {
    fail({ code: "BAD_USAGE", message: "Usage: run402 webhook-secret rotate" });
  }
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  allowanceAuthHeaders("/agent/v1/webhook-secret/rotate");
  try {
    const data = await getSdk().admin.rotateWebhookSecret();
    console.log(JSON.stringify(data, null, 2));
    console.error(""); // separator
    console.error("⚠  Store this secret NOW — it will not be shown again.");
    console.error("⚠  Your previous secret remains valid for the next 24 hours.");
  } catch (err) {
    reportSdkError(err);
  }
}
