import { readFileSync } from "node:fs";
import { getSdk } from "./sdk.mjs";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { resolveOrgId } from "./org-context.mjs";
import {
  assertKnownFlags,
  failUnknownSubcommand,
  flagValue,
  normalizeArgv,
  parseIntegerFlag,
  requirePositionalCount,
  validateRegularFile,
} from "./argparse.mjs";

const HELP = `run402 buzz — Buzz community ↔ Run402 control plane

The four independent states are:
  skill installation       shared software capability; inert and non-authoritative
  community installation   Buzz community ↔ Run402 organization association
  human adoption           Buzz owner ↔ Run402 human co-owner
  agent enrollment         one Buzz agent ↔ bounded existing-project grants

Canonical workflows:
  run402 buzz status
  run402 buzz adopt offer --org <org_id> --identity-link <idlnk_id> [--deployment-context-file <json>]
      --org                       the Run402 organization id as "run402 org whoami" returns it (a UUID)
      --deployment-context-file   JSON with exactly these five non-empty strings, and no others:
                                  project_id, release_id, live_url, source_revision, verified_at
  run402 buzz install --org <org_id> --community <buzz:community:host> --authority <hex-pubkey>
  run402 buzz enroll --installation <buzzci_id> --identity-link <idlnk_id> --grants-file <json> --expires-at <ISO-8601>

Explicit consent/decision commands:
  run402 buzz adopt offer show <buzzhao_id>
  run402 buzz adopt offer cancel <buzzhao_id>
  run402 buzz adopt complete <buzzha_id> --event-file <owner-event.json>
  run402 buzz adopt cancel <buzzha_id>
  run402 buzz install activate <buzzci_id> --proof-file <authority-proof.json>
  run402 buzz install update <buzzci_id> --policy-file <policy.json> --policy-revision <n> --default <true|false>
  run402 buzz install revoke <buzzci_id>
  run402 buzz approve <buzzae_id> --grants-file <json> --descriptor-revision <n> --policy-revision <n>
  run402 buzz deny <buzzae_id> [--reason <text>]
  run402 buzz revoke <buzzae_id>

Project-event routing into a Buzz channel (configure → authorize → test → live):
  run402 buzz notifications configure --org <uuid> --installation <buzzci_id> --name <route_name> --channel <uuid> --project <id> [--event-type <t> ...] [--event-class <c> ...]
  run402 buzz notifications status [--org <uuid> | <buzzper_id>]
  run402 buzz notifications test <buzzper_id> [--wait]
  run402 buzz notifications deliveries <buzzper_id> [--limit <n>] [--cursor <c>] [--delivery <buzzped_id>]
  run402 buzz notifications pause|resume|rotate|revoke <buzzper_id>
  (run \`run402 buzz notifications --help\` for the full workflow)

Advanced recovery reads:
  run402 buzz adopt direct --org <org_id> --identity-link <idlnk_id>
  run402 buzz adopt list --org <org_id>
  run402 buzz adopt show <buzzha_id>
  run402 buzz install list --org <org_id>
  run402 buzz install show <buzzci_id>
  run402 buzz install discover --community <buzz:community:host>
  run402 buzz install descriptor <buzzci_id>
  run402 buzz enroll list [--org <org_id>] [--status <state>]
  run402 buzz enroll show <buzzae_id>

Security:
  - JSON stdout only; progress and pending-state advice go to stderr.
  - This command never accepts an nsec, private key, mnemonic, seed, service key,
    delegate token, recovery code, or payment material.
  - Buzz signatures are public evidence. Run402 authority still comes only from
    human/agent principals, org membership, and project grants.
  - Every command in this group has zero spend impact.
`;

function requiredFlag(args, flag) {
  const value = flagValue(args, flag);
  if (value === null) fail({ code: "BAD_FLAG", message: `${flag} is required`, details: { flag } });
  return value;
}

function readJsonFile(path, field) {
  validateRegularFile(path, field);
  const bytes = readFileSync(path);
  if (bytes.byteLength > 256 * 1024) fail({ code: "BAD_FILE", message: `${field} exceeds 262144 bytes`, details: { field, max_bytes: 262144 } });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail({ code: "BAD_FILE", message: `${field} must contain valid UTF-8 JSON`, details: { field } }); }
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
  if (result?.status === "pending") {
    console.error("Buzz control-plane state is pending; follow the single next_actions entry in the JSON response.");
  }
  if (result?.status === "completed" && result?.completed_buzz_human_adoption) {
    console.error("Completed: Run402 recorded a terminal consent receipt. The public identity attribution does not grant organization authority; the ordinary owner membership is the only source of organization authority. The identity link and membership can be revoked independently, while the receipt remains completed.");
  }
}

async function invoke(operation) {
  try { print(await operation()); }
  catch (error) { reportSdkError(error); }
}

async function status(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--help", "-h"]);
  requirePositionalCount(a, [], { min: 0, max: 0, command: "run402 buzz status" });
  await invoke(async () => {
    const result = await getSdk().buzz.status();
    if (!result.supported) console.error("The selected gateway predates run402.buzz-control-plane.v1; no mutation was attempted.");
    return result;
  });
}

async function adopt(args) {
  const [operation, ...rest] = args;
  if (operation === "offer") return adoptionOffer(rest);
  if (operation === "complete") {
    const values = ["--event-file", "--idempotency-key"];
    const a = normalizeArgv(rest);
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz adopt complete <buzzha_id> --event-file <json>" });
    const event = readJsonFile(requiredFlag(a, "--event-file"), "--event-file");
    return invoke(() => getSdk({ authMode: "operator" }).buzz.humanAdoptions.complete(id, event, flagValue(a, "--idempotency-key") ?? undefined));
  }
  if (operation === "cancel") {
    const a = normalizeArgv(rest);
    const values = ["--idempotency-key"];
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz adopt cancel <buzzha_id>" });
    return invoke(() => getSdk({ authMode: "wallet" }).buzz.humanAdoptions.cancel(id, flagValue(a, "--idempotency-key") ?? undefined));
  }
  if (operation === "list") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org"], ["--org"]);
    requirePositionalCount(a, ["--org"], { min: 0, max: 0, command: "run402 buzz adopt list --org <org_id>" });
    const orgId = await resolveOrgId(a, { cmd: "buzz" });
    return invoke(() => getSdk().buzz.humanAdoptions.list(orgId));
  }
  if (operation === "show") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a);
    const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: "run402 buzz adopt show <buzzha_id>" });
    return invoke(() => getSdk().buzz.humanAdoptions.get(id));
  }

  const directArgs = operation === "direct" ? rest : args;
  const a = normalizeArgv(directArgs);
  const values = ["--org", "--identity-link", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 buzz adopt direct [--org <org_id>] --identity-link <idlnk_id>" });
  const organizationId = await resolveOrgId(a, { cmd: "buzz" });
  return invoke(() => getSdk({ authMode: "wallet" }).buzz.adopt({
    organizationId,
    identityLinkId: requiredFlag(a, "--identity-link"),
    idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
  }));
}

async function adoptionOffer(args) {
  const [operation, ...rest] = args;
  if (operation === "show") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a);
    const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: "run402 buzz adopt offer show <buzzhao_id>" });
    return invoke(() => getSdk({ authMode: "wallet" }).buzz.humanAdoptionOffers.get(id));
  }
  if (operation === "cancel") {
    const a = normalizeArgv(rest);
    const values = ["--idempotency-key"];
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz adopt offer cancel <buzzhao_id>" });
    return invoke(() => getSdk({ authMode: "wallet" }).buzz.humanAdoptionOffers.cancel(id, flagValue(a, "--idempotency-key") ?? undefined));
  }
  const a = normalizeArgv(args);
  const values = ["--org", "--identity-link", "--deployment-context-file", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 buzz adopt offer [--org <org_id>] --identity-link <idlnk_id>" });
  const deploymentPath = flagValue(a, "--deployment-context-file");
  const organizationId = await resolveOrgId(a, { cmd: "buzz" });
  return invoke(async () => {
    const client = getSdk({ authMode: "wallet" });
    const status = await client.buzz.status();
    if (!status.buzz?.capabilities?.human_adoption_offers) {
      fail({
        code: "BUZZ_ADOPTION_OFFERS_UNSUPPORTED",
        message: "The selected Run402 gateway does not support conversational human-adoption offers; no mutation was attempted.",
        hint: "Upgrade the run402 client/gateway. The advanced compatibility flow remains available as `run402 buzz adopt direct --org <org_id> --identity-link <idlnk_id>`.",
        safe_to_retry: true,
      });
    }
    return client.buzz.offerAdoption({
      organizationId,
      identityLinkId: requiredFlag(a, "--identity-link"),
      deploymentContext: deploymentPath ? readJsonFile(deploymentPath, "--deployment-context-file") : undefined,
      idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
    });
  });
}

async function install(args) {
  const [operation, ...rest] = args;
  if (operation === "activate") {
    const a = normalizeArgv(rest);
    const values = ["--proof-file", "--idempotency-key"];
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz install activate <buzzci_id> --proof-file <json>" });
    const proof = readJsonFile(requiredFlag(a, "--proof-file"), "--proof-file");
    const key = flagValue(a, "--idempotency-key") ?? undefined;
    return invoke(() => getSdk().buzz.communityInstallations.activate(id, proof, key));
  }
  if (operation === "revoke") {
    const a = normalizeArgv(rest);
    const values = ["--idempotency-key"];
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz install revoke <buzzci_id>" });
    return invoke(() => getSdk().buzz.communityInstallations.revoke(id, flagValue(a, "--idempotency-key") ?? undefined));
  }
  if (operation === "update") {
    const a = normalizeArgv(rest);
    const values = ["--policy-file", "--policy-revision", "--default", "--idempotency-key"];
    assertKnownFlags(a, values, values);
    const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz install update <buzzci_id> --policy-file <json> --policy-revision <n> --default <true|false>" });
    const defaultValue = requiredFlag(a, "--default");
    if (!["true", "false"].includes(defaultValue)) fail({ code: "BAD_FLAG", message: "--default must be true or false", details: { flag: "--default" } });
    return invoke(() => getSdk().buzz.communityInstallations.update(id, {
      enrollmentPolicy: readJsonFile(requiredFlag(a, "--policy-file"), "--policy-file"),
      policyRevision: parseIntegerFlag("--policy-revision", requiredFlag(a, "--policy-revision")),
      defaultForEnrollment: defaultValue === "true",
      idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
    }));
  }
  if (operation === "list") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--org"], ["--org"]);
    requirePositionalCount(a, ["--org"], { min: 0, max: 0, command: "run402 buzz install list --org <org_id>" });
    const orgId = await resolveOrgId(a, { cmd: "buzz" });
    return invoke(() => getSdk().buzz.communityInstallations.list(orgId));
  }
  if (operation === "discover") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a, ["--community"], ["--community"]);
    requirePositionalCount(a, ["--community"], { min: 0, max: 0, command: "run402 buzz install discover --community <buzz:community:host>" });
    return invoke(() => getSdk({ authMode: "none" }).buzz.communityInstallations.discoverPublicDescriptors(requiredFlag(a, "--community")));
  }
  if (["show", "descriptor"].includes(operation)) {
    const a = normalizeArgv(rest);
    assertKnownFlags(a);
    const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: `run402 buzz install ${operation} <buzzci_id>` });
    return invoke(() => operation === "show"
      ? getSdk().buzz.communityInstallations.get(id)
      : getSdk({ authMode: "none" }).buzz.communityInstallations.getPublicDescriptor(id));
  }

  const a = normalizeArgv(args);
  const values = ["--org", "--community", "--authority", "--policy-file", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 buzz install [--org <org_id>] --community <subject> --authority <hex>" });
  const policyFile = flagValue(a, "--policy-file");
  const organizationId = await resolveOrgId(a, { cmd: "buzz" });
  return invoke(() => getSdk().buzz.install({
    organizationId,
    buzzCommunitySubject: requiredFlag(a, "--community"),
    buzzCommunityAuthoritySubject: requiredFlag(a, "--authority"),
    enrollmentPolicy: policyFile ? readJsonFile(policyFile, "--policy-file") : undefined,
    idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
  }));
}

async function enroll(args) {
  const [operation, ...rest] = args;
  if (operation === "list") {
    const a = normalizeArgv(rest);
    const values = ["--org", "--status"];
    assertKnownFlags(a, values, values);
    requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 buzz enroll list [--org <org_id>] [--status <state>]" });
    return invoke(() => getSdk().buzz.enrollments.list({ organizationId: flagValue(a, "--org") ?? undefined, status: flagValue(a, "--status") ?? undefined }));
  }
  if (operation === "show") {
    const a = normalizeArgv(rest);
    assertKnownFlags(a);
    const [id] = requirePositionalCount(a, [], { min: 1, max: 1, command: "run402 buzz enroll show <buzzae_id>" });
    return invoke(() => getSdk().buzz.enrollments.get(id));
  }
  const a = normalizeArgv(args);
  const values = ["--installation", "--identity-link", "--grants-file", "--expires-at", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  requirePositionalCount(a, values, { min: 0, max: 0, command: "run402 buzz enroll --installation <buzzci_id> --identity-link <idlnk_id> --grants-file <json> --expires-at <ISO>" });
  return invoke(() => getSdk({ authMode: "wallet" }).buzz.enroll({
    buzzCommunityInstallationId: requiredFlag(a, "--installation"),
    identityLinkId: requiredFlag(a, "--identity-link"),
    requestedGrants: readJsonFile(requiredFlag(a, "--grants-file"), "--grants-file"),
    expiresAt: requiredFlag(a, "--expires-at"),
    idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
  }));
}

async function approve(args) {
  const a = normalizeArgv(args);
  const values = ["--grants-file", "--descriptor-revision", "--policy-revision", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz approve <buzzae_id> --grants-file <json> --descriptor-revision <n> --policy-revision <n>" });
  return invoke(() => getSdk().buzz.enrollments.approve(id, {
    approvedGrants: readJsonFile(requiredFlag(a, "--grants-file"), "--grants-file"),
    installationDescriptorRevision: parseIntegerFlag("--descriptor-revision", requiredFlag(a, "--descriptor-revision")),
    installationPolicyRevision: parseIntegerFlag("--policy-revision", requiredFlag(a, "--policy-revision")),
    idempotencyKey: flagValue(a, "--idempotency-key") ?? undefined,
  }));
}

async function deny(args) {
  const a = normalizeArgv(args);
  const values = ["--reason", "--idempotency-key"];
  assertKnownFlags(a, values, values);
  const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz deny <buzzae_id> [--reason <text>]" });
  return invoke(() => getSdk().buzz.enrollments.deny(id, flagValue(a, "--reason") ?? undefined, flagValue(a, "--idempotency-key") ?? undefined));
}

async function revoke(args) {
  const a = normalizeArgv(args);
  const values = ["--idempotency-key"];
  assertKnownFlags(a, values, values);
  const [id] = requirePositionalCount(a, values, { min: 1, max: 1, command: "run402 buzz revoke <buzzae_id>" });
  return invoke(() => getSdk().buzz.enrollments.revoke(id, flagValue(a, "--idempotency-key") ?? undefined));
}

export async function run(sub, args = []) {
  if (sub === "notifications") {
    // The group owns its own help (`run402 buzz notifications --help` must
    // teach the routing workflow, not this module's lifecycle states).
    const { run: runNotifications } = await import("./buzz-notifications.mjs");
    return runNotifications(args[0], args.slice(1));
  }
  if (!sub || sub === "help" || sub === "--help" || sub === "-h" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "status": return status(args);
    case "adopt": return adopt(args);
    case "install": return install(args);
    case "enroll": return enroll(args);
    case "approve": return approve(args);
    case "deny": return deny(args);
    case "revoke": return revoke(args);
    default: failUnknownSubcommand("buzz", sub);
  }
}
