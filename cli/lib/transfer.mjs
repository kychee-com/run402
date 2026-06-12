import { allowanceAuthHeaders, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertKnownFlags,
  flagValue,
  hasHelp,
  normalizeArgv,
  parseIntegerFlag,
  positionalArgs,
} from "./argparse.mjs";

const HELP = `run402 transfer — Two-party project transfer (v1.59)

Usage:
  run402 transfer init --to <wallet|email> [--project <id>] [--billing-policy migrate] [--message <text>] [--kysigned <record_id>]
  run402 transfer preview <transfer_id>
  run402 transfer list [--incoming | --outgoing] [--limit N] [--offset N]
  run402 transfer accept <transfer_id>
  run402 transfer claim <transfer_id> [--into <organization_id>]
  run402 transfer cancel <transfer_id> [--reason <text>] [--handoff]

Subcommands:
  init        Initiate ownership change. --to <wallet> = two-party wallet transfer;
              --to <email> = email->org handoff (the recipient claims it).
  preview     Fetch the safe review document (add --handoff for an email handoff)
  list        List pending transfers (incoming default, --outgoing, or --handoffs)
  accept      Accept an incoming wallet transfer (your wallet must be the to_wallet)
  claim       Claim an incoming email handoff into an org (--into <id>; omit = new org)
  cancel      Cancel a pending transfer/handoff (--handoff routes to a handoff)

Notes:
  - Owner-side mutations on a project with a pending transfer return 409
    PROJECT_HAS_PENDING_TRANSFER. Cancel the transfer or wait 72h for expiry.
  - Phase 1A supports only billing_policy=migrate (default).
  - Secret VALUES are inherited by the recipient on accept; rotation is advised.
  - GitHub repo ownership is NOT transferred — handle that out of band.
`;

const SUB_HELP = {
  init: `run402 transfer init — Initiate a project transfer

Usage:
  run402 transfer init --to <wallet|email> [--project <id>] [--billing-policy migrate] [--message <text>] [--kysigned <record_id>]

Options:
  --project <id>         Project id (defaults to the active project)
  --to <wallet>          Recipient wallet (required). Any case; lowercased server-side.
  --billing-policy <p>   Billing policy. Phase 1A only allows 'migrate' (default).
  --message <text>       Optional note shown to the recipient in preview + emails.
  --kysigned <record_id> Optional KySigned record id (Phase 1A: informational only).

Notes:
  - Caller's wallet must currently own the project (gateway re-checks fresh DB).
  - Owner-side mutations on the project are frozen until accept/cancel/expiry.
  - The project lease stays with your organization; it is NOT refunded.
`,
  preview: `run402 transfer preview — Fetch the preview document

Usage:
  run402 transfer preview <transfer_id>

Returns project name, custom domains, subdomains, function names, secret NAMES
(values are never returned), CI bindings that will be revoked on accept, and
billing implications. Either the from_wallet or the to_wallet may preview.
`,
  list: `run402 transfer list — List pending transfers

Usage:
  run402 transfer list [--incoming | --outgoing] [--limit N] [--offset N]

Options:
  --incoming    List transfers OFFERED TO your wallet (default).
  --outgoing    List transfers INITIATED BY your wallet.
  --limit N     Page size (default 50).
  --offset N    Pagination offset (default 0).
`,
  accept: `run402 transfer accept — Accept an incoming transfer

Usage:
  run402 transfer accept <transfer_id>

Your wallet must equal the transfer's to_wallet. The accept transaction
atomically: flips ownership, revokes the previous owner's CI bindings on the
project, enqueues notifications to both parties, and stamps a
'secrets_rotation_advised' advisory on the project.
`,
  cancel: `run402 transfer cancel — Cancel a pending transfer

Usage:
  run402 transfer cancel <transfer_id> [--reason <text>] [--handoff]

Either the from_wallet or the to_wallet may cancel. Already-processed
transfers return 409 TRANSFER_ALREADY_PROCESSED. Pass --handoff to cancel an
email->org handoff instead of a wallet transfer.
`,
  claim: `run402 transfer claim — Claim an incoming email handoff

Usage:
  run402 transfer claim <transfer_id> [--into <organization_id>]

Claims a handoff addressed to your email into an org you own. Omit --into to
claim into a brand-new org. This is the email-handoff analog of 'accept'.
`,
};

const BILLING_POLICIES = new Set(["migrate"]);

async function init(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project", "--to", "--billing-policy", "--message", "--kysigned"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for transfer init: ${extra[0]}` });
  }
  const toWallet = flagValue(parsedArgs, "--to");
  if (!toWallet) {
    fail({ code: "BAD_USAGE", message: "Missing --to <wallet>" });
  }
  const projectFlag = flagValue(parsedArgs, "--project");
  const projectId = await resolveProjectId(projectFlag);
  if (!projectId) {
    fail({ code: "NO_PROJECT", message: "No project id. Pass --project <id> or set an active project with 'run402 projects use <id>'." });
  }
  const billingPolicy = flagValue(parsedArgs, "--billing-policy");
  if (billingPolicy !== null && !BILLING_POLICIES.has(billingPolicy)) {
    fail({
      code: "BAD_FLAG",
      message: `Unsupported --billing-policy: ${billingPolicy}. Phase 1A allows only 'migrate'.`,
      details: { flag: "--billing-policy", value: billingPolicy, allowed: [...BILLING_POLICIES] },
    });
  }
  const message = flagValue(parsedArgs, "--message");
  const kysigned = flagValue(parsedArgs, "--kysigned");

  // One noun, two rails: an email recipient routes to the email->org handoff;
  // a wallet recipient routes to the two-party wallet transfer.
  const isEmail = toWallet.includes("@");
  allowanceAuthHeaders(
    isEmail ? `/projects/v1/${projectId}/handoffs` : `/projects/v1/${projectId}/transfers`,
  );

  try {
    const res = isEmail
      ? await getSdk().admin.transfers.initiateHandoff({
          projectId,
          toEmail: toWallet,
          message: message ?? undefined,
        })
      : await getSdk().admin.transfers.initiate({
          projectId,
          toWallet,
          billingPolicy: billingPolicy ?? undefined,
          message: message ?? undefined,
          kysignedRecordId: kysigned ?? undefined,
        });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function preview(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--handoff", "--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer preview <transfer_id> [--handoff]" });
  }
  const transferId = positionals[0];
  const handoff = parsedArgs.includes("--handoff");
  allowanceAuthHeaders(`/agent/v1/${handoff ? "handoffs" : "transfers"}/${transferId}`);

  try {
    const data = handoff
      ? await getSdk().admin.transfers.previewHandoff(transferId)
      : await getSdk().admin.transfers.preview(transferId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--limit", "--offset"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--incoming", "--outgoing", "--handoffs", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for transfer list: ${extra[0]}` });
  }

  // Email->org handoffs ride the same rail but have their own incoming inbox.
  if (parsedArgs.includes("--handoffs")) {
    allowanceAuthHeaders("/agent/v1/handoffs/incoming");
    try {
      const handoffs = await getSdk().admin.transfers.listIncomingHandoffs();
      console.log(JSON.stringify({ kind: "handoffs", handoffs }, null, 2));
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  const incoming = parsedArgs.includes("--incoming");
  const outgoing = parsedArgs.includes("--outgoing");
  if (incoming && outgoing) {
    fail({ code: "BAD_USAGE", message: "Cannot pass both --incoming and --outgoing." });
  }
  const direction = outgoing ? "outgoing" : "incoming";

  const limitFlag = flagValue(parsedArgs, "--limit");
  const offsetFlag = flagValue(parsedArgs, "--offset");
  const limit =
    limitFlag === null
      ? undefined
      : parseIntegerFlag("--limit", limitFlag, { min: 1, max: 1000 });
  const offset =
    offsetFlag === null
      ? undefined
      : parseIntegerFlag("--offset", offsetFlag, { min: 0 });

  allowanceAuthHeaders(`/agent/v1/transfers/${direction}`);

  try {
    const data =
      direction === "incoming"
        ? await getSdk().admin.transfers.listIncoming({ limit, offset })
        : await getSdk().admin.transfers.listOutgoing({ limit, offset });
    console.log(JSON.stringify({ direction, transfers: data }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function accept(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer accept <transfer_id>" });
  }
  const transferId = positionals[0];
  allowanceAuthHeaders(`/agent/v1/transfers/${transferId}/accept`);

  try {
    const data = await getSdk().admin.transfers.accept(transferId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function cancel(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--reason"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--handoff", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer cancel <transfer_id> [--reason <text>] [--handoff]" });
  }
  const transferId = positionals[0];
  const reason = flagValue(parsedArgs, "--reason");
  const handoff = parsedArgs.includes("--handoff");
  allowanceAuthHeaders(`/agent/v1/${handoff ? "handoffs" : "transfers"}/${transferId}/cancel`);

  try {
    const data = handoff
      ? await getSdk().admin.transfers.cancelHandoff(transferId)
      : await getSdk().admin.transfers.cancel(transferId, reason ?? undefined);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function claim(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--into"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer claim <transfer_id> [--into <organization_id>]" });
  }
  const transferId = positionals[0];
  const into = flagValue(parsedArgs, "--into");
  allowanceAuthHeaders(`/agent/v1/handoffs/${transferId}/claim`);

  try {
    const data = await getSdk().admin.transfers.claimHandoff(transferId, {
      organizationId: into ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && hasHelp(args) && SUB_HELP[sub]) {
    console.log(SUB_HELP[sub]);
    process.exit(0);
  }
  switch (sub) {
    case "init":
      await init(args);
      return;
    case "preview":
      await preview(args);
      return;
    case "list":
      await list(args);
      return;
    case "accept":
      await accept(args);
      return;
    case "claim":
      await claim(args);
      return;
    case "cancel":
      await cancel(args);
      return;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
