/**
 * Custom sender domain service — register, verify, and manage custom email
 * sending domains via AWS SES. Domains are wallet-scoped: once verified by
 * one project, other projects owned by the same wallet can reuse instantly.
 */

import { SESv2Client, CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { SESClient, DescribeReceiptRuleCommand, UpdateReceiptRuleCommand } from "@aws-sdk/client-ses";
import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";

const ses = new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" });
const sesV1 = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });

const SES_RULE_SET_NAME = "run402-inbound";
const SES_RULE_NAME = "InboundMailRule";
const MX_RECORD = "10 inbound-smtp.us-east-1.amazonaws.com";

// --- Domain blocklist ---

const BLOCKLISTED_DOMAINS = new Set([
  "run402.com", "mail.run402.com", "kychee.com",
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
  "yahoo.com", "yahoo.co.uk", "aol.com", "icloud.com",
  "me.com", "mac.com", "protonmail.com", "proton.me",
  "zoho.com", "yandex.com", "mail.com", "gmx.com",
  "live.com", "msn.com",
]);

// --- Domain validation ---

const DOMAIN_RE = /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/;

function isValidDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  return DOMAIN_RE.test(domain.toLowerCase());
}

// --- Result types ---

interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

interface RegisterResult {
  error?: true;
  message?: string;
  domain?: string;
  status?: string;
  dns_records?: DnsRecord[];
  instructions?: string;
}

interface InboundStatus {
  enabled: boolean;
  mx_record: string;
  mx_verified: boolean;
}

interface DomainStatus {
  domain: string;
  status: string;
  dkim_records: DnsRecord[];
  verified_at: string | null;
  created_at: string;
  inbound: InboundStatus;
}

// --- Registration ---

export async function registerSenderDomain(
  projectId: string,
  walletAddress: string,
  domain: string,
): Promise<RegisterResult> {
  const normalizedDomain = domain.toLowerCase().trim();

  // Blocklist check
  if (BLOCKLISTED_DOMAINS.has(normalizedDomain)) {
    return { error: true, message: `Domain "${normalizedDomain}" is not allowed (blocklist)` };
  }

  // Format validation
  if (!isValidDomain(normalizedDomain)) {
    return { error: true, message: "Invalid domain format" };
  }

  // Check if project already has a domain
  const existing = await pool.query(
    sql(`SELECT domain, status FROM internal.email_domains WHERE project_id = $1`),
    [projectId],
  );
  if (existing.rows.length > 0) {
    return { error: true, message: `Project already has a sender domain: ${existing.rows[0].domain}` };
  }

  // Check if domain is registered by another wallet
  const domainOwner = await pool.query(
    sql(`SELECT wallet_address, status, dkim_records FROM internal.email_domains WHERE domain = $1 LIMIT 1`),
    [normalizedDomain],
  );

  if (domainOwner.rows.length > 0) {
    const owner = domainOwner.rows[0];
    if (owner.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
      return { error: true, message: "Domain is registered by another wallet" };
    }

    // Same wallet — reuse existing verified domain
    if (owner.status === "verified") {
      const dkimRecords = typeof owner.dkim_records === "string"
        ? JSON.parse(owner.dkim_records)
        : owner.dkim_records;

      await pool.query(
        sql(`INSERT INTO internal.email_domains (domain, project_id, wallet_address, status, dkim_records, verified_at)
             VALUES ($1, $2, $3, 'verified', $4, NOW())`),
        [normalizedDomain, projectId, walletAddress, JSON.stringify(dkimRecords)],
      );

      return {
        domain: normalizedDomain,
        status: "verified",
        dns_records: dkimRecords,
        instructions: "Domain already verified by your wallet. Ready to use immediately.",
      };
    }
  }

  // New domain — register with SES
  let dkimTokens: string[];
  try {
    const response = await ses.send(new CreateEmailIdentityCommand({
      EmailIdentity: normalizedDomain,
    }));
    dkimTokens = response.DkimAttributes?.Tokens || [];
  } catch (err: unknown) {
    // If identity already exists in SES (from a previous attempt), fetch its tokens
    if (err && typeof err === "object" && "name" in err && err.name === "AlreadyExistsException") {
      const existing = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: normalizedDomain }));
      dkimTokens = existing.DkimAttributes?.Tokens || [];
    } else {
      console.error("  SES CreateEmailIdentity error:", err);
      return { error: true, message: "Failed to register domain with SES" };
    }
  }

  // Build DNS records
  const dnsRecords: DnsRecord[] = [
    // 3 DKIM CNAME records
    ...dkimTokens.map(token => ({
      type: "CNAME",
      name: `${token}._domainkey.${normalizedDomain}`,
      value: `${token}.dkim.amazonses.com`,
    })),
    // SPF TXT (recommended)
    {
      type: "TXT",
      name: normalizedDomain,
      value: "v=spf1 include:amazonses.com ~all",
    },
    // DMARC TXT (recommended)
    {
      type: "TXT",
      name: `_dmarc.${normalizedDomain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${normalizedDomain}`,
    },
  ];

  // Store in DB
  await pool.query(
    sql(`INSERT INTO internal.email_domains (domain, project_id, wallet_address, status, dkim_records)
         VALUES ($1, $2, $3, 'pending', $4)`),
    [normalizedDomain, projectId, walletAddress, JSON.stringify(dnsRecords)],
  );

  return {
    domain: normalizedDomain,
    status: "pending",
    dns_records: dnsRecords,
    instructions: `Add the 3 CNAME records to your DNS provider to verify domain ownership (DKIM). The SPF and DMARC TXT records are recommended for deliverability. Check status with GET /email/v1/domains — verification usually takes a few minutes after DNS records propagate.`,
  };
}

// --- Status ---

export async function getSenderDomainStatus(
  projectId: string,
): Promise<DomainStatus | null> {
  const result = await pool.query(
    sql(`SELECT domain, status, dkim_records, verified_at, created_at, inbound_enabled FROM internal.email_domains WHERE project_id = $1`),
    [projectId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const dkimRecords = typeof row.dkim_records === "string"
    ? JSON.parse(row.dkim_records)
    : row.dkim_records;

  const inbound = await buildInboundStatus(row.domain, row.inbound_enabled === true);

  // If already verified, return without polling SES
  if (row.status === "verified") {
    return {
      domain: row.domain,
      status: "verified",
      dkim_records: dkimRecords,
      verified_at: row.verified_at,
      created_at: row.created_at,
      inbound,
    };
  }

  // Pending — poll SES for current DKIM status
  try {
    const sesResult = await ses.send(new GetEmailIdentityCommand({
      EmailIdentity: row.domain,
    }));

    const dkimStatus = sesResult.DkimAttributes?.Status;

    if (dkimStatus === "SUCCESS") {
      // Update to verified
      await pool.query(
        sql(`UPDATE internal.email_domains SET status = $1, verified_at = NOW() WHERE domain = $2 AND project_id = $3`),
        ["verified", row.domain, projectId],
      );
      return {
        domain: row.domain,
        status: "verified",
        dkim_records: dkimRecords,
        verified_at: new Date().toISOString(),
        created_at: row.created_at,
        inbound,
      };
    }
  } catch (err) {
    console.error("  SES GetEmailIdentity error:", err);
  }

  return {
    domain: row.domain,
    status: row.status,
    dkim_records: dkimRecords,
    verified_at: row.verified_at,
    created_at: row.created_at,
    inbound,
  };
}

// --- MX verification for inbound ---

// Small DNS cache to avoid hammering the resolver on repeated status calls.
const mxCache = new Map<string, { verified: boolean; expiresAt: number }>();
const MX_CACHE_TTL_MS = 5 * 60 * 1000;
const EXPECTED_MX_SUFFIX = "inbound-smtp.us-east-1.amazonaws.com";

async function buildInboundStatus(domain: string, enabled: boolean): Promise<InboundStatus> {
  return {
    enabled,
    mx_record: MX_RECORD,
    mx_verified: enabled ? await isMxVerified(domain) : false,
  };
}

async function isMxVerified(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() < cached.expiresAt) return cached.verified;
  let verified = false;
  try {
    const { resolveMx } = await import("node:dns/promises");
    const records = await resolveMx(domain);
    verified = records.some((r) => r.exchange.toLowerCase().endsWith(EXPECTED_MX_SUFFIX));
  } catch {
    verified = false;
  }
  mxCache.set(domain, { verified, expiresAt: Date.now() + MX_CACHE_TTL_MS });
  return verified;
}

// --- Removal ---

export async function removeSenderDomain(projectId: string): Promise<boolean> {
  // Find the domain for this project
  const result = await pool.query(
    sql(`SELECT domain, project_id, inbound_enabled FROM internal.email_domains WHERE project_id = $1`),
    [projectId],
  );

  if (result.rows.length === 0) return false;

  const { domain, inbound_enabled } = result.rows[0];

  // Cascade: disable inbound first if it was enabled
  if (inbound_enabled) {
    await disableInbound(projectId, domain);
  }

  // Remove DB row for this project
  await pool.query(
    sql(`DELETE FROM internal.email_domains WHERE domain = $1 AND project_id = $2`),
    [domain, projectId],
  );

  // Check if other projects still use this domain
  const others = await pool.query(
    sql(`SELECT project_id FROM internal.email_domains WHERE domain = $1`),
    [domain],
  );

  // Only delete SES identity if no other projects use it
  if (others.rows.length === 0) {
    try {
      await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    } catch (err) {
      console.error("  SES DeleteEmailIdentity error:", err);
    }
  }

  return true;
}

// --- Inbound enable/disable ---

interface InboundResult {
  error?: true;
  message?: string;
  status?: string;
  mx_record?: string;
}

/**
 * Enable inbound email on a verified custom sender domain.
 * Adds the domain to the SES receipt rule's recipient list so SES routes
 * inbound mail for this domain to the inbound Lambda.
 */
export async function enableInbound(
  projectId: string,
  domain: string,
): Promise<InboundResult> {
  const normalizedDomain = domain.toLowerCase().trim();

  const result = await pool.query(
    sql(`SELECT domain, status, inbound_enabled FROM internal.email_domains WHERE project_id = $1 AND domain = $2`),
    [projectId, normalizedDomain],
  );
  if (result.rows.length === 0) {
    return { error: true, message: "Domain not found for this project" };
  }

  const row = result.rows[0];
  if (row.status !== "verified") {
    return { error: true, message: "Domain must be DKIM-verified before enabling inbound" };
  }

  // Idempotent: already enabled
  if (row.inbound_enabled) {
    return { status: "enabled", mx_record: MX_RECORD };
  }

  // Update DB flag
  await pool.query(
    sql(`UPDATE internal.email_domains SET inbound_enabled = TRUE WHERE project_id = $1 AND domain = $2`),
    [projectId, normalizedDomain],
  );

  // Add domain to SES receipt rule recipients
  await addDomainToReceiptRule(normalizedDomain);

  return { status: "enabled", mx_record: MX_RECORD };
}

/**
 * Disable inbound email on a custom sender domain.
 * Removes the domain from the SES receipt rule's recipient list.
 */
export async function disableInbound(
  projectId: string,
  domain: string,
): Promise<InboundResult> {
  const normalizedDomain = domain.toLowerCase().trim();

  const result = await pool.query(
    sql(`SELECT domain, status, inbound_enabled FROM internal.email_domains WHERE project_id = $1 AND domain = $2`),
    [projectId, normalizedDomain],
  );
  if (result.rows.length === 0) {
    return { error: true, message: "Domain not found for this project" };
  }

  const row = result.rows[0];

  // Idempotent: already disabled
  if (!row.inbound_enabled) {
    return { status: "disabled" };
  }

  // Update DB flag
  await pool.query(
    sql(`UPDATE internal.email_domains SET inbound_enabled = FALSE WHERE project_id = $1 AND domain = $2`),
    [projectId, normalizedDomain],
  );

  // Remove domain from SES receipt rule recipients
  await removeDomainFromReceiptRule(normalizedDomain);

  return { status: "disabled" };
}

// --- SES receipt rule reconciliation ---
//
// Concurrent enableInbound/disableInbound calls could race on DescribeReceiptRule
// + UpdateReceiptRule — two readers see the same pre-state and the second writer
// wipes the first's addition. Serialize via Postgres advisory lock keyed on the
// rule-set name hash. Fits-in-a-single-tick operations; low-traffic path.

const RULE_SET_LOCK_KEY = hashStringToInt(`ses:${SES_RULE_SET_NAME}:${SES_RULE_NAME}`);

function hashStringToInt(s: string): number {
  // 32-bit FNV-1a → fits in Postgres integer range for pg_advisory_lock(int).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h | 0; // coerce to signed int32
}

async function withRuleSetLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(sql("BEGIN"));
    await client.query(sql("SELECT pg_advisory_xact_lock($1)"), [RULE_SET_LOCK_KEY]);
    const result = await fn();
    await client.query(sql("COMMIT"));
    return result;
  } catch (err) {
    try { await client.query(sql("ROLLBACK")); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function addDomainToReceiptRule(domain: string): Promise<void> {
  try {
    await withRuleSetLock(async () => {
      const desc = await sesV1.send(new DescribeReceiptRuleCommand({
        RuleSetName: SES_RULE_SET_NAME,
        RuleName: SES_RULE_NAME,
      }));
      const rule = desc.Rule;
      if (!rule) return;

      const recipients = rule.Recipients || [];
      if (recipients.includes(domain)) return; // already present

      rule.Recipients = [...recipients, domain];
      await sesV1.send(new UpdateReceiptRuleCommand({
        RuleSetName: SES_RULE_SET_NAME,
        Rule: rule,
      }));
    });
  } catch (err) {
    console.error("  SES receipt rule update (add) error:", err);
    throw err;
  }
}

async function removeDomainFromReceiptRule(domain: string): Promise<void> {
  try {
    await withRuleSetLock(async () => {
      const desc = await sesV1.send(new DescribeReceiptRuleCommand({
        RuleSetName: SES_RULE_SET_NAME,
        RuleName: SES_RULE_NAME,
      }));
      const rule = desc.Rule;
      if (!rule) return;

      const recipients = (rule.Recipients || []).filter((r: string) => r !== domain);
      rule.Recipients = recipients;
      await sesV1.send(new UpdateReceiptRuleCommand({
        RuleSetName: SES_RULE_SET_NAME,
        Rule: rule,
      }));
    });
  } catch (err) {
    console.error("  SES receipt rule update (remove) error:", err);
    throw err;
  }
}

// --- Lightweight lookup for email-send ---

const domainCache = new Map<string, { domain: string | null; expiresAt: number }>();
const CACHE_TTL = 60_000; // 60s

export async function getVerifiedSenderDomain(projectId: string): Promise<string | null> {
  const cached = domainCache.get(projectId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.domain;
  }

  const result = await pool.query(
    sql(`SELECT domain, status FROM internal.email_domains WHERE project_id = $1`),
    [projectId],
  );

  const domain = (result.rows.length > 0 && result.rows[0].status === "verified")
    ? result.rows[0].domain
    : null;

  domainCache.set(projectId, { domain, expiresAt: Date.now() + CACHE_TTL });
  return domain;
}
