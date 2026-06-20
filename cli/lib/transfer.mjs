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

const HELP = `run402 transfer — Project transfer, one noun for wallet, email, and owned-org recipients

Usage:
  run402 transfer init (--to <wallet|email> | --to-org <org_id>) [--project <id>] [--billing-policy migrate] [--message <text>] [--kysigned <record_id>] [--retain-collaborator developer]
  run402 transfer preview <transfer_id>
  run402 transfer list [--incoming | --outgoing] [--limit N] [--after <cursor>]
  run402 transfer accept <transfer_id>
  run402 transfer claim <transfer_id> [--into <org_id>] [--accept-retained-collaborator]
  run402 transfer cancel <transfer_id> [--reason <text>]

Subcommands:
  init        Initiate ownership change. --to <wallet> = two-party wallet transfer
              (completed by 'accept'); --to <email> = email->org transfer (completed by 'claim');
              --to-org <org_id> = same-actor move to an owned org (completes immediately).
  preview     Fetch the safe review document (pending transfer — kind-agnostic)
  list        List pending transfers (incoming default, or --outgoing) — pending rows unioned
  accept      Accept an incoming WALLET transfer (your wallet must be the to_wallet)
  claim       Claim an incoming EMAIL transfer into an org (--into <id>; omit = new org)
  cancel      Cancel a pending transfer of any kind

Notes:
  - Owner-side mutations on a project with a pending transfer return 409
    PROJECT_HAS_PENDING_TRANSFER. Cancel the transfer or wait 72h for expiry.
  - Phase 1A supports only billing_policy=migrate (default).
  - --to-org is same-actor only in the first gateway release: you must own both orgs.
  - Secret VALUES are inherited by the recipient on completion; rotation is advised.
  - GitHub repo ownership is NOT transferred — handle that out of band.
`;

const SUB_HELP = {
  init: `run402 transfer init — Initiate a project transfer

Usage:
  run402 transfer init (--to <wallet|email> | --to-org <org_id>) [--project <id>] [--billing-policy migrate] [--message <text>] [--kysigned <record_id>] [--retain-collaborator developer]

Options:
  --project <id>         Project id (defaults to the active project)
  --to <wallet|email>    Recipient (required). A wallet uses the two-party rail (completed by
                         'accept'); an email uses the email->org rail (completed by 'claim').
  --to-org <org_id>      Destination org you already own. Same-actor only in the first gateway
                         release; completes immediately and returns project keys.
  --billing-policy <p>   Billing policy (wallet rail). Phase 1A only allows 'migrate' (default).
  --message <text>       Optional note shown to the recipient in preview + emails.
  --kysigned <record_id> Optional KySigned record id (wallet rail; Phase 1A: informational only).
  --retain-collaborator <role>  Email recipients only (v1.91): keep a 'developer' membership in
                         the recipient's org after the transfer. The recipient must accept it at
                         claim (--accept-retained-collaborator); omit for full severance.

Notes:
  - Caller's wallet/session must currently own or admin the project (gateway re-checks fresh DB).
  - Owner-side mutations on the project are frozen until accept/claim/cancel/expiry.
    Owned-org moves complete immediately and do not create a pending window.
  - The project lease stays with your organization; it is NOT refunded.
`,
  preview: `run402 transfer preview — Fetch the preview document

Usage:
  run402 transfer preview <transfer_id>

Returns project name, custom domains, subdomains, function names, secret NAMES
(values are never returned), CI bindings that will be revoked on completion, and
billing implications. Works for pending wallet/email/future-org transfers; any
party to the transfer may preview.
`,
  list: `run402 transfer list — List pending transfers

Usage:
  run402 transfer list [--incoming | --outgoing] [--limit N] [--after <cursor>]

Lists pending transfers, unioned; each row carries recipient_kind.

Options:
  --incoming        List transfers OFFERED TO you (default).
  --outgoing        List transfers INITIATED BY you.
  --limit N         Page size (default 50).
  --after <cursor>  Opaque keyset cursor (next_cursor from a prior page).
`,
  accept: `run402 transfer accept — Accept an incoming WALLET transfer

Usage:
  run402 transfer accept <transfer_id>

Your wallet must equal the transfer's to_wallet. The accept transaction
atomically: flips ownership, revokes the previous owner's CI bindings on the
project, enqueues notifications to both parties, and stamps a
'secrets_rotation_advised' advisory on the project. (Email transfers complete
via 'claim', not 'accept'.)
`,
  cancel: `run402 transfer cancel — Cancel a pending transfer

Usage:
  run402 transfer cancel <transfer_id> [--reason <text>]

Cancels a pending transfer of any kind. You must be authorized for the row's
kind (a wallet signing party, or an owner/admin of the offering org / the
addressed-email principal). Already-processed transfers return 409
TRANSFER_ALREADY_PROCESSED.
`,
  claim: `run402 transfer claim — Claim an incoming EMAIL transfer

Usage:
  run402 transfer claim <transfer_id> [--into <org_id>] [--accept-retained-collaborator]

Claims an email-addressed transfer into an org you own. Omit --into to claim into
a brand-new org. This is the email analog of 'accept'.

Options:
  --into <org_id>       Org to claim into (omit = brand-new org).
  --accept-retained-collaborator Accept the sender's v1.91 retained-developer-membership offer
                                 (see 'transfer preview' retain_collaborator). Omit = full severance.
`,
};

const BILLING_POLICIES = new Set(["migrate"]);
const RETAIN_ROLES = new Set(["developer"]);

async function init(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--project", "--to", "--to-org", "--billing-policy", "--message", "--kysigned", "--retain-collaborator"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for transfer init: ${extra[0]}` });
  }
  const to = flagValue(parsedArgs, "--to");
  const toOrg = flagValue(parsedArgs, "--to-org");
  if (!to && !toOrg) {
    fail({ code: "BAD_USAGE", message: "Missing recipient. Pass --to <wallet|email> or --to-org <org_id>." });
  }
  if (to && toOrg) {
    fail({ code: "BAD_USAGE", message: "Pass exactly one recipient flag: --to <wallet|email> or --to-org <org_id>." });
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
  const retainCollaborator = flagValue(parsedArgs, "--retain-collaborator");

  // One noun, three recipient shapes. --to keeps wallet/email auto-detection;
  // --to-org is explicit because org ids are not human-recipient addresses.
  const recipientKind = toOrg ? "org" : (to.includes("@") ? "email" : "wallet");

  // --retain-collaborator (v1.91) is an email-only opt-in: the sender keeps a
  // developer membership in the recipient's org (recipient must accept at claim).
  if (retainCollaborator !== null) {
    if (recipientKind !== "email") {
      fail({
        code: "BAD_FLAG",
        message: "--retain-collaborator applies only to email recipients.",
        details: { flag: "--retain-collaborator" },
      });
    }
    if (!RETAIN_ROLES.has(retainCollaborator)) {
      fail({
        code: "BAD_FLAG",
        message: `Unsupported --retain-collaborator role: ${retainCollaborator}. Allowed: ${[...RETAIN_ROLES].join(", ")}.`,
        details: { flag: "--retain-collaborator", value: retainCollaborator, allowed: [...RETAIN_ROLES] },
      });
    }
  }
  if (kysigned !== null && recipientKind !== "wallet") {
    fail({
      code: "BAD_FLAG",
      message: "--kysigned applies only to wallet recipients; email and owned-org transfers do not use the KySigned rail.",
      details: { flag: "--kysigned" },
    });
  }
  if (billingPolicy !== null && recipientKind !== "wallet") {
    fail({
      code: "BAD_FLAG",
      message: "--billing-policy applies only to wallet recipients; email and owned-org transfers always migrate ownership.",
      details: { flag: "--billing-policy" },
    });
  }

  // All recipient shapes initiate on the unified transfer endpoint — sign that path.
  allowanceAuthHeaders(`/projects/v1/${projectId}/transfers`);

  try {
    let res;
    if (recipientKind === "org") {
      res = await getSdk().admin.transfers.initiate({
        projectId,
        toOrgId: toOrg,
        message: message ?? undefined,
      });
    } else if (recipientKind === "email") {
      res = await getSdk().admin.transfers.initiate({
        projectId,
        toEmail: to,
        message: message ?? undefined,
        retainCollaborator: retainCollaborator ? { role: retainCollaborator } : undefined,
      });
    } else {
      res = await getSdk().admin.transfers.initiate({
        projectId,
        toWallet: to,
        billingPolicy: billingPolicy ?? undefined,
        message: message ?? undefined,
        kysignedRecordId: kysigned ?? undefined,
      });
    }
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function preview(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer preview <transfer_id>" });
  }
  const transferId = positionals[0];
  // Preview is kind-agnostic — one route serves wallet, email, and future org transfers.
  allowanceAuthHeaders(`/agent/v1/transfers/${transferId}`);

  try {
    const data = await getSdk().admin.transfers.preview(transferId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--limit", "--after"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--incoming", "--outgoing", "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for transfer list: ${extra[0]}` });
  }

  const incoming = parsedArgs.includes("--incoming");
  const outgoing = parsedArgs.includes("--outgoing");
  if (incoming && outgoing) {
    fail({ code: "BAD_USAGE", message: "Cannot pass both --incoming and --outgoing." });
  }
  const direction = outgoing ? "outgoing" : "incoming";

  const limitFlag = flagValue(parsedArgs, "--limit");
  const after = flagValue(parsedArgs, "--after");
  const limit =
    limitFlag === null
      ? undefined
      : parseIntegerFlag("--limit", limitFlag, { min: 1, max: 1000 });

  // Incoming/outgoing are kind-agnostic — each returns the union of pending
  // wallet/email/future-org rows, tagged with recipient_kind.
  allowanceAuthHeaders(`/agent/v1/transfers/${direction}`);

  try {
    const result =
      direction === "incoming"
        ? await getSdk().admin.transfers.listIncoming({ limit, after: after ?? undefined })
        : await getSdk().admin.transfers.listOutgoing({ limit, after: after ?? undefined });
    console.log(
      JSON.stringify(
        {
          direction,
          transfers: result.transfers,
          has_more: result.has_more,
          next_cursor: result.next_cursor,
        },
        null,
        2,
      ),
    );
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
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer cancel <transfer_id> [--reason <text>]" });
  }
  const transferId = positionals[0];
  const reason = flagValue(parsedArgs, "--reason");
  // Cancel is kind-agnostic — one route serves wallet and email transfers.
  allowanceAuthHeaders(`/agent/v1/transfers/${transferId}/cancel`);

  try {
    const data = await getSdk().admin.transfers.cancel(transferId, { reason: reason ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function claim(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--into"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--accept-retained-collaborator", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length !== 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 transfer claim <transfer_id> [--into <org_id>] [--accept-retained-collaborator]" });
  }
  const transferId = positionals[0];
  const into = flagValue(parsedArgs, "--into");
  // v1.91: accept the sender's retained-developer-membership offer (see the
  // preview's `retain_collaborator` block). Absent = full severance (default).
  const acceptRetain = parsedArgs.includes("--accept-retained-collaborator");
  allowanceAuthHeaders(`/agent/v1/transfers/${transferId}/claim`);

  try {
    const data = await getSdk().admin.transfers.claim(transferId, {
      organizationId: into ?? undefined,
      acceptRetainedCollaborator: acceptRetain || undefined,
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
