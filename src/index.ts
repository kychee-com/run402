#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Existing tools
import { provisionSchema, handleProvision } from "./tools/provision.js";
import { runSqlSchema, handleRunSql } from "./tools/run-sql.js";
import { restQuerySchema, handleRestQuery } from "./tools/rest-query.js";
import { setTierSchema, handleSetTier } from "./tools/set-tier.js";
import { deploySiteSchema, handleDeploySite } from "./tools/deploy-site.js";
import { deploySiteDirSchema, handleDeploySiteDir } from "./tools/deploy-site-dir.js";
import { claimSubdomainSchema, handleClaimSubdomain } from "./tools/subdomain.js";
import { deleteSubdomainSchema, handleDeleteSubdomain } from "./tools/subdomain.js";
import { deployFunctionSchema, handleDeployFunction } from "./tools/deploy-function.js";
import { invokeFunctionSchema, handleInvokeFunction } from "./tools/invoke-function.js";
import { getFunctionLogsSchema, handleGetFunctionLogs } from "./tools/get-function-logs.js";
import { setSecretSchema, handleSetSecret } from "./tools/set-secret.js";

// New tools — database
import { setupRlsSchema, handleSetupRls } from "./tools/setup-rls.js";
import { applyExposeSchema, handleApplyExpose } from "./tools/apply-expose.js";
import { getExposeSchema, handleGetExpose } from "./tools/get-expose.js";
import { getSchemaSchema, handleGetSchema } from "./tools/get-schema.js";
import { getUsageSchema, handleGetUsage } from "./tools/get-usage.js";

// New tools — bundle & marketplace
import { bundleDeploySchema, handleBundleDeploy } from "./tools/bundle-deploy.js";
import { browseAppsSchema, handleBrowseApps } from "./tools/browse-apps.js";
import { forkAppSchema, handleForkApp } from "./tools/fork-app.js";
import { getQuoteSchema, handleGetQuote } from "./tools/get-quote.js";
import { publishAppSchema, handlePublishApp } from "./tools/publish-app.js";
import { listVersionsSchema, handleListVersions } from "./tools/list-versions.js";

// Direct-to-S3 blob storage
import { blobPutSchema, handleBlobPut } from "./tools/blob-put.js";
import { blobGetSchema, handleBlobGet } from "./tools/blob-get.js";
import { blobLsSchema, handleBlobLs } from "./tools/blob-ls.js";
import { blobRmSchema, handleBlobRm } from "./tools/blob-rm.js";
import { blobSignSchema, handleBlobSign } from "./tools/blob-sign.js";
import { blobDiagnoseSchema, handleBlobDiagnose } from "./tools/blob-diagnose.js";
import { blobWaitFreshSchema, handleBlobWaitFresh } from "./tools/blob-wait-fresh.js";

// New tools — functions & secrets CRUD
import { listFunctionsSchema, handleListFunctions } from "./tools/list-functions.js";
import { deleteFunctionSchema, handleDeleteFunction } from "./tools/delete-function.js";
import { updateFunctionSchema, handleUpdateFunction } from "./tools/update-function.js";
import { listSecretsSchema, handleListSecrets } from "./tools/list-secrets.js";
import { deleteSecretSchema, handleDeleteSecret } from "./tools/delete-secret.js";

// New tools — subdomains & projects
import { listSubdomainsSchema, handleListSubdomains } from "./tools/list-subdomains.js";
import { deleteProjectSchema, handleDeleteProject } from "./tools/delete-project.js";
import { pinProjectSchema, handlePinProject } from "./tools/pin-project.js";

// New tools — user role management
import { promoteUserSchema, handlePromoteUser } from "./tools/promote-user.js";
import { demoteUserSchema, handleDemoteUser } from "./tools/demote-user.js";

// New tools — custom domains
import { addCustomDomainSchema, handleAddCustomDomain } from "./tools/add-custom-domain.js";
import { listCustomDomainsSchema, handleListCustomDomains } from "./tools/list-custom-domains.js";
import { checkDomainStatusSchema, handleCheckDomainStatus } from "./tools/check-domain-status.js";
import { removeCustomDomainSchema, handleRemoveCustomDomain } from "./tools/remove-custom-domain.js";

// New tools — billing
import { checkBalanceSchema, handleCheckBalance } from "./tools/check-balance.js";
import { listProjectsSchema, handleListProjects } from "./tools/list-projects.js";

// New tools — allowance, faucet, image
import { allowanceStatusSchema, handleAllowanceStatus } from "./tools/allowance-status.js";
import { allowanceCreateSchema, handleAllowanceCreate } from "./tools/allowance-create.js";
import { allowanceExportSchema, handleAllowanceExport } from "./tools/allowance-export.js";
import { requestFaucetSchema, handleRequestFaucet } from "./tools/request-faucet.js";
import { generateImageSchema, handleGenerateImage } from "./tools/generate-image.js";

// New tools — email
import { createMailboxSchema, handleCreateMailbox } from "./tools/create-mailbox.js";
import { sendEmailSchema, handleSendEmail } from "./tools/send-email.js";
import { listEmailsSchema, handleListEmails } from "./tools/list-emails.js";
import { getEmailSchema, handleGetEmail } from "./tools/get-email.js";
import { getEmailRawSchema, handleGetEmailRaw } from "./tools/get-email-raw.js";
import { getMailboxSchema, handleGetMailbox } from "./tools/get-mailbox.js";
import { deleteMailboxSchema, handleDeleteMailbox } from "./tools/delete-mailbox.js";

// New tools — mailbox webhooks
import { listMailboxWebhooksSchema, handleListMailboxWebhooks } from "./tools/list-mailbox-webhooks.js";
import { getMailboxWebhookSchema, handleGetMailboxWebhook } from "./tools/get-mailbox-webhook.js";
import { deleteMailboxWebhookSchema, handleDeleteMailboxWebhook } from "./tools/delete-mailbox-webhook.js";
import { updateMailboxWebhookSchema, handleUpdateMailboxWebhook } from "./tools/update-mailbox-webhook.js";
import { registerMailboxWebhookSchema, handleRegisterMailboxWebhook } from "./tools/register-mailbox-webhook.js";

// New tools — magic link auth
import { requestMagicLinkSchema, handleRequestMagicLink } from "./tools/request-magic-link.js";
import { verifyMagicLinkSchema, handleVerifyMagicLink } from "./tools/verify-magic-link.js";
import { setUserPasswordSchema, handleSetUserPassword } from "./tools/set-user-password.js";
import { authSettingsSchema, handleAuthSettings } from "./tools/auth-settings.js";

// New tools — custom sender domains
import { registerSenderDomainSchema, handleRegisterSenderDomain } from "./tools/register-sender-domain.js";
import { senderDomainStatusSchema, handleSenderDomainStatus } from "./tools/sender-domain-status.js";
import { removeSenderDomainSchema, handleRemoveSenderDomain } from "./tools/remove-sender-domain.js";
import { enableInboundSchema, handleEnableInbound } from "./tools/enable-inbound.js";
import { disableInboundSchema, handleDisableInbound } from "./tools/disable-inbound.js";

// New tools — email billing accounts + Stripe tier checkout + email packs
import { createEmailBillingAccountSchema, handleCreateEmailBillingAccount } from "./tools/create-email-billing-account.js";
import { linkWalletToAccountSchema, handleLinkWalletToAccount } from "./tools/link-wallet-to-account.js";
import { tierCheckoutSchema, handleTierCheckout } from "./tools/tier-checkout.js";
import { buyEmailPackSchema, handleBuyEmailPack } from "./tools/buy-email-pack.js";
import { setAutoRechargeSchema, handleSetAutoRecharge } from "./tools/set-auto-recharge.js";

// New tools — AI
import { aiTranslateSchema, handleAiTranslate } from "./tools/ai-translate.js";
import { aiModerateSchema, handleAiModerate } from "./tools/ai-moderate.js";
import { aiUsageSchema, handleAiUsage } from "./tools/ai-usage.js";

// New tools — messaging, agent contact, billing, deployments, versions
import { sendMessageSchema, handleSendMessage } from "./tools/send-message.js";
import { setAgentContactSchema, handleSetAgentContact } from "./tools/set-agent-contact.js";
import { createCheckoutSchema, handleCreateCheckout } from "./tools/create-checkout.js";
import { billingHistorySchema, handleBillingHistory } from "./tools/billing-history.js";
import { getDeploymentSchema, handleGetDeployment } from "./tools/get-deployment.js";
import { updateVersionSchema, handleUpdateVersion } from "./tools/update-version.js";
import { deleteVersionSchema, handleDeleteVersion } from "./tools/delete-version.js";
import { getAppSchema, handleGetApp } from "./tools/get-app.js";
import { tierStatusSchema, handleTierStatus } from "./tools/tier-status.js";
import { initSchema, handleInit } from "./tools/init.js";
import { statusSchema, handleStatus } from "./tools/status.js";
import { projectInfoSchema, handleProjectInfo } from "./tools/project-info.js";
import { projectUseSchema, handleProjectUse } from "./tools/project-use.js";
import { projectKeysSchema, handleProjectKeys } from "./tools/project-keys.js";

// New tools — KMS contract wallets
import { provisionContractWalletSchema, handleProvisionContractWallet } from "./tools/provision-contract-wallet.js";
import { getContractWalletSchema, handleGetContractWallet } from "./tools/get-contract-wallet.js";
import { listContractWalletsSchema, handleListContractWallets } from "./tools/list-contract-wallets.js";
import { setRecoveryAddressSchema, handleSetRecoveryAddress } from "./tools/set-recovery-address.js";
import { setLowBalanceAlertSchema, handleSetLowBalanceAlert } from "./tools/set-low-balance-alert.js";
import { contractCallSchema, handleContractCall } from "./tools/contract-call.js";
import { contractReadSchema, handleContractRead } from "./tools/contract-read.js";
import { getContractCallStatusSchema, handleGetContractCallStatus } from "./tools/get-contract-call-status.js";
import { drainContractWalletSchema, handleDrainContractWallet } from "./tools/drain-contract-wallet.js";
import { deleteContractWalletSchema, handleDeleteContractWallet } from "./tools/delete-contract-wallet.js";

// New tools — service status (public, unauthenticated)
import { serviceStatusSchema, handleServiceStatus } from "./tools/service-status.js";
import { serviceHealthSchema, handleServiceHealth } from "./tools/service-health.js";

const server = new McpServer({
  name: "run402",
  version: "1.3.0",
});

// ─── Core database tools ────────────────────────────────────────────────────

server.tool(
  "provision_postgres_project",
  "Provision a new Postgres database. Returns project credentials on success, or payment details if x402 payment is needed.",
  provisionSchema,
  async (args) => handleProvision(args),
);

server.tool(
  "run_sql",
  "Execute SQL (DDL or queries) against a provisioned project. Returns results as a markdown table.",
  runSqlSchema,
  async (args) => handleRunSql(args),
);

server.tool(
  "rest_query",
  "Query or mutate data via the PostgREST REST API. Supports GET/POST/PATCH/DELETE with query params.",
  restQuerySchema,
  async (args) => handleRestQuery(args),
);

server.tool(
  "setup_rls",
  "⚠ DEPRECATED — use `apply_expose` instead. Sunset: 2026-05-23. The `/rls` endpoint still works during the deprecation window and returns Deprecation/Sunset headers; after the sunset date it will return 410 Gone. Apply row-level security to tables. Templates: user_owns_rows, public_read_authenticated_write, public_read_write_UNRESTRICTED (requires i_understand_this_is_unrestricted: true).",
  setupRlsSchema,
  async (args) => handleSetupRls(args),
);

server.tool(
  "apply_expose",
  "Apply a declarative authorization manifest to a project (POST /projects/v1/admin/:id/expose). The manifest describes the full authorization surface: tables (with policy, owner_column, force_owner_on_insert, i_understand_this_is_unrestricted, custom_sql), views (with base, select, filter), and rpcs (with signature, grant_to). Convergent: applying the same manifest twice is a no-op; items dropped between applies have their policies/grants/triggers/views revoked. Tables are dark by default — any table not declared with expose:true is unreachable via anon/authenticated. Supersedes `setup_rls`.",
  applyExposeSchema,
  async (args) => handleApplyExpose(args),
);

server.tool(
  "get_expose",
  "Get the current authorization manifest for a project (GET /projects/v1/admin/:id/expose). Returns the last-applied manifest from `internal.project_manifest`, or a manifest reconstructed by introspecting live DB state if none has ever been applied. The `source` field is `\"applied\"` or `\"introspected\"`.",
  getExposeSchema,
  async (args) => handleGetExpose(args),
);

server.tool(
  "get_schema",
  "Introspect the database schema — tables, columns, types, constraints, and RLS policies. Useful for understanding the database structure before writing queries.",
  getSchemaSchema,
  async (args) => handleGetSchema(args),
);

server.tool(
  "get_usage",
  "Get project usage report — API calls, storage usage, limits, and lease expiry.",
  getUsageSchema,
  async (args) => handleGetUsage(args),
);

// ─── Storage tools ──────────────────────────────────────────────────────────

server.tool(
  "blob_put",
  "Upload a blob (file or inline content) to project storage via direct-to-S3. Accepts local_path (any size up to 5 TiB) or content (≤ 1 MB inline). Public blobs get a CDN URL; private blobs require authenticated reads. Use `immutable: true` to produce a content-addressed URL that never needs cache invalidation.",
  blobPutSchema,
  async (args) => handleBlobPut(args),
);

server.tool(
  "blob_get",
  "Download a blob to a local file path. Writes bytes directly to disk (no context-window bloat). Returns size + SHA-256 header (if the blob has one stored).",
  blobGetSchema,
  async (args) => handleBlobGet(args),
);

server.tool(
  "blob_ls",
  "List blobs in a project with optional prefix filter over a flat key namespace. Supports pagination via cursor.",
  blobLsSchema,
  async (args) => handleBlobLs(args),
);

server.tool(
  "blob_rm",
  "Delete a blob from project storage and decrement the project's storage_bytes.",
  blobRmSchema,
  async (args) => handleBlobRm(args),
);

server.tool(
  "blob_sign",
  "Generate a time-boxed S3 presigned GET URL for a blob. Use this to share a private blob externally without exposing your apikey. Default TTL 1 hour, max 7 days.",
  blobSignSchema,
  async (args) => handleBlobSign(args),
);

server.tool(
  "diagnose_public_url",
  "Returns the live CDN state for a public blob URL (probed once from gateway-us-east-1 — NOT a global view). Use this when a deployed asset shows the wrong version or you suspect cache staleness. The result includes `expectedSha256` (from gateway DB), `observedSha256` (what CloudFront just served), recent `invalidation` status, and a human-readable `hint` with actionable next-steps. The `probeMayHaveWarmedCache: true` field warns that the probe itself populates the cache, so subsequent reads from elsewhere may differ. URLs outside the requesting project return 403; non-`*.run402.com` URLs return 400 unless they're on one of your active custom domains.",
  blobDiagnoseSchema,
  async (args) => handleBlobDiagnose(args),
);

server.tool(
  "wait_for_cdn_freshness",
  "Polls the CDN until a MUTABLE blob URL serves the expected SHA-256, or the timeout elapses. **For mutable URLs only** — for immutable URLs (the `immutableUrl` returned by `blob_put`), no waiting is needed; they're bound to a SHA at upload time and never previously cached. Use this after a re-upload to an existing public mutable key when an end-user-visible URL must reflect the new content before continuing. The probe is single-vantage (us-east-1). On timeout, the tool returns isError=true so an agent can branch into a fallback — typically: switch to the immutableUrl.",
  blobWaitFreshSchema,
  async (args) => handleBlobWaitFresh(args),
);

// ─── Functions tools ────────────────────────────────────────────────────────

server.tool(
  "deploy_function",
  "Deploy a serverless function (Node 22) to a project. Handler signature: export default async (req: Request) => Response. The function can `import { db, adminDb, getUser, email, ai } from '@run402/functions'` — these helpers are provided by the platform. Other npm packages are not yet supported in deployed code (the `deps` field is reserved for a follow-up release that will install user-supplied packages).",
  deployFunctionSchema,
  async (args) => handleDeployFunction(args),
);

server.tool(
  "invoke_function",
  "Invoke a deployed function via HTTP. Returns the function's response body and status code. Useful for testing functions without building a frontend.",
  invokeFunctionSchema,
  async (args) => handleInvokeFunction(args),
);

server.tool(
  "get_function_logs",
  "Get recent logs from a deployed function. Shows console.log/error output and error stack traces from CloudWatch.",
  getFunctionLogsSchema,
  async (args) => handleGetFunctionLogs(args),
);

server.tool(
  "list_functions",
  "List all deployed functions for a project. Shows names, URLs, runtime, timeout, and memory.",
  listFunctionsSchema,
  async (args) => handleListFunctions(args),
);

server.tool(
  "delete_function",
  "Delete a deployed function from a project.",
  deleteFunctionSchema,
  async (args) => handleDeleteFunction(args),
);

server.tool(
  "update_function",
  "Update a function's schedule, timeout, or memory without re-deploying code. Pass schedule as a cron expression to set/update, or null to remove.",
  updateFunctionSchema,
  async (args) => handleUpdateFunction(args),
);

// ─── Secrets tools ──────────────────────────────────────────────────────────

server.tool(
  "set_secret",
  "Set a project secret (e.g. STRIPE_SECRET_KEY). Secrets are injected as process.env variables in functions. Setting an existing key overwrites it.",
  setSecretSchema,
  async (args) => handleSetSecret(args),
);

server.tool(
  "list_secrets",
  "List secret keys for a project (values are not shown). Useful for checking which secrets are configured.",
  listSecretsSchema,
  async (args) => handleListSecrets(args),
);

server.tool(
  "delete_secret",
  "Delete a secret from a project.",
  deleteSecretSchema,
  async (args) => handleDeleteSecret(args),
);

// ─── Deployment & subdomain tools ───────────────────────────────────────────

server.tool(
  "deploy_site",
  "Deploy a static site (HTML/CSS/JS) from inline file bytes. Files are staged to a temp directory, then uploaded via the v1.32 plan/commit transport — only bytes the gateway doesn't already have are PUT. Served at a unique URL via CloudFront. Free with active tier.",
  deploySiteSchema,
  async (args) => handleDeploySite(args),
);

server.tool(
  "deploy_site_dir",
  "Deploy a static site from a local directory. Walks the tree, hashes each file, and uploads only the bytes the gateway doesn't already have via the v1.32 plan/commit transport. Files named .git, node_modules, or .DS_Store are skipped; symlinks are rejected. Re-deploying an unchanged tree issues no S3 PUTs. Free with active tier.",
  deploySiteDirSchema,
  async (args) => handleDeploySiteDir(args),
);

server.tool(
  "claim_subdomain",
  "Claim a custom subdomain (e.g. myapp.run402.com) and point it at an existing deployment. Free, requires service_key auth.",
  claimSubdomainSchema,
  async (args) => handleClaimSubdomain(args),
);

server.tool(
  "delete_subdomain",
  "Release a custom subdomain. The URL will stop serving content.",
  deleteSubdomainSchema,
  async (args) => handleDeleteSubdomain(args),
);

server.tool(
  "list_subdomains",
  "List all subdomains claimed by a project.",
  listSubdomainsSchema,
  async (args) => handleListSubdomains(args),
);

// ─── Custom domain tools ────────────────────────────────────────────────────

server.tool(
  "add_custom_domain",
  "Register a custom domain (e.g. example.com) to point at a Run402 subdomain. Returns DNS instructions for the human to configure.",
  addCustomDomainSchema,
  async (args) => handleAddCustomDomain(args),
);

server.tool(
  "list_custom_domains",
  "List all custom domains registered for a project.",
  listCustomDomainsSchema,
  async (args) => handleListCustomDomains(args),
);

server.tool(
  "check_domain_status",
  "Check if a custom domain's DNS is configured and SSL is active. Poll this after registering a domain.",
  checkDomainStatusSchema,
  async (args) => handleCheckDomainStatus(args),
);

server.tool(
  "remove_custom_domain",
  "Release a custom domain mapping. Traffic to the domain will no longer route to Run402.",
  removeCustomDomainSchema,
  async (args) => handleRemoveCustomDomain(args),
);

// ─── Bundle deploy & marketplace tools ──────────────────────────────────────

server.tool(
  "bundle_deploy",
  "Deploy to an existing project. Runs migrations, applies RLS, sets secrets, deploys functions, deploys a static site, and claims a subdomain. Requires a provisioned project_id. Free with active tier.",
  bundleDeploySchema,
  async (args) => handleBundleDeploy(args),
);

server.tool(
  "browse_apps",
  "Browse public apps available for forking. Optionally filter by tags.",
  browseAppsSchema,
  async (args) => handleBrowseApps(args),
);

server.tool(
  "fork_app",
  "Fork a published app into a new project. Creates a full copy including database, functions, site, and optionally claims a subdomain.",
  forkAppSchema,
  async (args) => handleForkApp(args),
);

server.tool(
  "publish_app",
  "Publish a project as a forkable app. Set visibility and tags for discoverability.",
  publishAppSchema,
  async (args) => handlePublishApp(args),
);

server.tool(
  "list_versions",
  "List published versions of a project.",
  listVersionsSchema,
  async (args) => handleListVersions(args),
);

// ─── Project lifecycle tools ────────────────────────────────────────────────

server.tool(
  "get_quote",
  "Get tier pricing for Run402 projects. Free, no auth required. Shows prices, lease durations, storage limits, and API call limits.",
  getQuoteSchema,
  async (args) => handleGetQuote(args),
);

server.tool(
  "tier_status",
  "Check current tier subscription — tier name, status, and expiry. Requires allowance auth.",
  tierStatusSchema,
  async (args) => handleTierStatus(args),
);

server.tool(
  "set_tier",
  "Subscribe, renew, or upgrade tier. Auto-detects action based on allowance state. Returns success or payment details if x402 payment is needed.",
  setTierSchema,
  async (args) => handleSetTier(args),
);

server.tool(
  "delete_project",
  "Immediately and irreversibly delete a project: the gateway runs the full destructive cascade (drop tenant schema, delete Lambda functions, release subdomains, tombstone mailbox, remove sender domain, wipe secrets and app versions) and sets status=purged. This tool also removes the project from the local key store. Distinct from the automatic lease-expiry grace window — this action is the explicit purge and cannot be undone. To recover from a missed renewal use `set_tier` instead.",
  deleteProjectSchema,
  async (args) => handleDeleteProject(args),
);

// ─── Admin tools ─────────────────────────────────────────────────────────────

server.tool(
  "pin_project",
  "Pin a project so it is not garbage-collected or expired. Admin only — requires run402 platform admin auth; project owners authenticating with service_key or SIWX will receive 403 admin_required. Not a self-service command for regular users.",
  pinProjectSchema,
  async (args) => handlePinProject(args),
);

server.tool(
  "promote_user",
  "Promote a user to project_admin role by email. Admins can manage secrets from the browser. Requires service_key.",
  promoteUserSchema,
  async (args) => handlePromoteUser(args),
);

server.tool(
  "demote_user",
  "Demote a user from project_admin role by email. Reverts to default authenticated role. Requires service_key.",
  demoteUserSchema,
  async (args) => handleDemoteUser(args),
);

// ─── Billing & allowance tools ───────────────────────────────────────────────

server.tool(
  "check_balance",
  "Check billing account balance for an agent allowance address. Shows available and held funds.",
  checkBalanceSchema,
  async (args) => handleCheckBalance(args),
);

server.tool(
  "list_projects",
  "List all active projects for an agent allowance address.",
  listProjectsSchema,
  async (args) => handleListProjects(args),
);

// ─── Allowance & faucet tools ─────────────────────────────────────────────

server.tool(
  "allowance_status",
  "Check local agent allowance status — address, network, and funding status.",
  allowanceStatusSchema,
  async (args) => handleAllowanceStatus(args),
);

server.tool(
  "allowance_create",
  "Create a new local agent allowance (Base Sepolia testnet). Generates a private key and derives the Ethereum address. Saved to ~/.config/run402/allowance.json.",
  allowanceCreateSchema,
  async (args) => handleAllowanceCreate(args),
);

server.tool(
  "allowance_export",
  "Export the local agent allowance address. Safe to share publicly.",
  allowanceExportSchema,
  async (args) => handleAllowanceExport(args),
);

server.tool(
  "request_faucet",
  "Request free testnet USDC from the Run402 faucet (Base Sepolia). Rate limit: 1 per IP per 24h. Returns 0.25 USDC — enough for 2 prototype databases.",
  requestFaucetSchema,
  async (args) => handleRequestFaucet(args),
);

// ─── Image generation tools ──────────────────────────────────────────────

server.tool(
  "generate_image",
  "Generate a PNG image from a text prompt. Costs $0.03 USDC via x402. Aspect ratios: square (1:1), landscape (16:9), portrait (9:16).",
  generateImageSchema,
  async (args) => handleGenerateImage(args),
);

// ─── Email tools ────────────────────────────────────────────────────────────

server.tool(
  "create_mailbox",
  "Create a project-scoped email mailbox at <slug>@mail.run402.com. One mailbox per project.",
  createMailboxSchema,
  async (args) => handleCreateMailbox(args),
);

server.tool(
  "send_email",
  "Send an email from the project's mailbox. Two modes: template (project_invite, magic_link, notification) or raw HTML (subject + html). Optional from_name for display name. Single recipient only.",
  sendEmailSchema,
  async (args) => handleSendEmail(args),
);

server.tool(
  "list_emails",
  "List sent emails from the project's mailbox. Shows message ID, template, recipient, status, and timestamp.",
  listEmailsSchema,
  async (args) => handleListEmails(args),
);

server.tool(
  "get_email",
  "Get a sent email with details and any replies.",
  getEmailSchema,
  async (args) => handleGetEmail(args),
);

server.tool(
  "get_email_raw",
  "Get the raw RFC-822 bytes of an inbound email message, base64-encoded. The decoded bytes are bit-identical to the DKIM-signed original — no parsing, normalization, or CRLF cleanup. Use this for cryptographic verification (DKIM checks, zk-email proofs). Inbound messages only; outbound returns 404. For display/threading, use get_email instead.",
  getEmailRawSchema,
  async (args) => handleGetEmailRaw(args),
);

server.tool(
  "get_mailbox",
  "Get the project's mailbox info (ID, address, slug). Use to check if a mailbox exists.",
  getMailboxSchema,
  async (args) => handleGetMailbox(args),
);

server.tool(
  "delete_mailbox",
  "Delete the project's mailbox (irreversible — drops all messages and webhook subscriptions). Requires confirm=true. If mailbox_id is omitted, resolves the project's mailbox.",
  deleteMailboxSchema,
  async (args) => handleDeleteMailbox(args),
);

server.tool(
  "register_mailbox_webhook",
  "Register a webhook on the project's mailbox. Receives POST notifications for email events (delivery, bounced, complained, reply_received).",
  registerMailboxWebhookSchema,
  async (args) => handleRegisterMailboxWebhook(args),
);

server.tool(
  "list_mailbox_webhooks",
  "List all webhooks registered on the project's mailbox.",
  listMailboxWebhooksSchema,
  async (args) => handleListMailboxWebhooks(args),
);

server.tool(
  "get_mailbox_webhook",
  "Get details of a specific webhook by ID.",
  getMailboxWebhookSchema,
  async (args) => handleGetMailboxWebhook(args),
);

server.tool(
  "delete_mailbox_webhook",
  "Delete a webhook. Idempotent — succeeds even if already deleted.",
  deleteMailboxWebhookSchema,
  async (args) => handleDeleteMailboxWebhook(args),
);

server.tool(
  "update_mailbox_webhook",
  "Update a webhook's URL and/or events. At least one field required. Events is a full replacement, not a merge.",
  updateMailboxWebhookSchema,
  async (args) => handleUpdateMailboxWebhook(args),
);

// ─── AI tools ──────────────────────────────────────────────────────────────

server.tool(
  "ai_translate",
  "Translate text to a target language. Requires service key and active AI Translation add-on. Supports optional source language and context hint.",
  aiTranslateSchema,
  async (args) => handleAiTranslate(args),
);

server.tool(
  "ai_moderate",
  "Run content moderation on text. Returns flagged status and category scores. Free for all projects, requires service key.",
  aiModerateSchema,
  async (args) => handleAiModerate(args),
);

server.tool(
  "ai_usage",
  "Get AI translation usage for the current billing period — used words, quota, and remaining balance.",
  aiUsageSchema,
  async (args) => handleAiUsage(args),
);

// ─── Messaging & agent contact tools ───────────────────────────────────────

server.tool(
  "send_message",
  "Send a message to the Run402 developers. Requires an active tier.",
  sendMessageSchema,
  async (args) => handleSendMessage(args),
);

server.tool(
  "set_agent_contact",
  "Register agent contact info (name, email, webhook) so Run402 can reach you. Free with allowance auth.",
  setAgentContactSchema,
  async (args) => handleSetAgentContact(args),
);

// ─── Billing tools ─────────────────────────────────────────────────────────

server.tool(
  "create_checkout",
  "Create a Stripe checkout URL for your human to fund your agent allowance with a credit card.",
  createCheckoutSchema,
  async (args) => handleCreateCheckout(args),
);

server.tool(
  "billing_history",
  "View billing transaction history for an agent allowance address.",
  billingHistorySchema,
  async (args) => handleBillingHistory(args),
);

// ─── Deployment status tool ────────────────────────────────────────────────

server.tool(
  "get_deployment",
  "Get deployment status and URL for a static site deployment.",
  getDeploymentSchema,
  async (args) => handleGetDeployment(args),
);

// ─── Version management tools ──────────────────────────────────────────────

server.tool(
  "update_version",
  "Update metadata (description, tags, visibility, fork_allowed) of a published app version.",
  updateVersionSchema,
  async (args) => handleUpdateVersion(args),
);

server.tool(
  "delete_version",
  "Delete a published app version.",
  deleteVersionSchema,
  async (args) => handleDeleteVersion(args),
);

server.tool(
  "get_app",
  "Inspect a specific published app — details, required secrets, fork pricing.",
  getAppSchema,
  async (args) => handleGetApp(args),
);

// ─── Init tool ────────────────────────────────────────────────────────────

server.tool(
  "init",
  "Set up agent allowance, request faucet funding, and check tier status — single-call bootstrap. Idempotent, safe to re-run.",
  initSchema,
  async (args) => handleInit(args),
);

// ─── Status tool ──────────────────────────────────────────────────────────

server.tool(
  "status",
  "Full account snapshot — allowance, billing balance, tier subscription, projects, and active project. Single-call overview.",
  statusSchema,
  async (args) => handleStatus(args as Record<string, never>),
);

// ─── Local project tools ──────────────────────────────────────────────────

server.tool(
  "project_info",
  "Show local project details — REST URL, keys, site URL, and deployment info. Reads from local keystore only.",
  projectInfoSchema,
  async (args) => handleProjectInfo(args),
);

server.tool(
  "project_use",
  "Set the active/default project in the local keystore.",
  projectUseSchema,
  async (args) => handleProjectUse(args),
);

server.tool(
  "project_keys",
  "Get anon_key and service_key for a project from the local keystore.",
  projectKeysSchema,
  async (args) => handleProjectKeys(args),
);

// --- Magic link auth ---

server.tool(
  "request_magic_link",
  "Send a passwordless login email (magic link) to a project user. Auto-creates the user on first verification. Rate limited per email (5/hr) and per project (by tier).",
  requestMagicLinkSchema,
  async (args) => handleRequestMagicLink(args),
);

server.tool(
  "verify_magic_link",
  "Exchange a magic link token for access_token + refresh_token. Creates the user if they don't exist. Token is single-use and expires in 15 minutes.",
  verifyMagicLinkSchema,
  async (args) => handleVerifyMagicLink(args),
);

server.tool(
  "set_user_password",
  "Change, reset, or set a user's password. Change: provide current_password + new_password. Reset (via magic link login): just new_password. Set (passwordless user): requires allow_password_set=true on project.",
  setUserPasswordSchema,
  async (args) => handleSetUserPassword(args),
);

server.tool(
  "auth_settings",
  "Update project auth settings. Currently supports allow_password_set (boolean) to control whether passwordless users can add a password. Requires service_key.",
  authSettingsSchema,
  async (args) => handleAuthSettings(args),
);

// --- Custom sender domains ---

server.tool(
  "register_sender_domain",
  "Register a custom email sending domain for a project. Returns DNS records (DKIM CNAMEs + SPF/DMARC) to add. Once verified, email sends from your domain instead of mail.run402.com.",
  registerSenderDomainSchema,
  async (args) => handleRegisterSenderDomain(args),
);

server.tool(
  "sender_domain_status",
  "Check the verification status of a project's custom sender domain. Polls SES for pending domains.",
  senderDomainStatusSchema,
  async (args) => handleSenderDomainStatus(args),
);

server.tool(
  "remove_sender_domain",
  "Remove a project's custom sender domain. Email reverts to sending from mail.run402.com.",
  removeSenderDomainSchema,
  async (args) => handleRemoveSenderDomain(args),
);

server.tool(
  "enable_sender_domain_inbound",
  "Enable inbound email on a verified custom sender domain. Replies to <slug>@<your-domain> will route through run402. Requires DKIM-verified domain. Returns the MX record to add to DNS.",
  enableInboundSchema,
  async (args) => handleEnableInbound(args),
);

server.tool(
  "disable_sender_domain_inbound",
  "Disable inbound email on a custom sender domain. Replies to <slug>@<your-domain> will no longer be delivered.",
  disableInboundSchema,
  async (args) => handleDisableInbound(args),
);

// --- Email billing accounts + Stripe tier checkout + email packs ---

server.tool(
  "create_email_billing_account",
  "Create an email-based billing account (Stripe-only, no wallet required). Sends a verification email. Idempotent — duplicate emails return the existing account.",
  createEmailBillingAccountSchema,
  async (args) => handleCreateEmailBillingAccount(args),
);

server.tool(
  "link_wallet_to_account",
  "Link a wallet to an existing email billing account, enabling hybrid Stripe + x402 access. Fails if the wallet is already linked elsewhere.",
  linkWalletToAccountSchema,
  async (args) => handleLinkWalletToAccount(args),
);

server.tool(
  "tier_checkout",
  "Subscribe/renew/upgrade to a run402 tier via Stripe credit card. Alternative to x402 on-chain payment. Supports wallet or email identifier. Returns a Stripe checkout URL.",
  tierCheckoutSchema,
  async (args) => handleTierCheckout(args),
);

server.tool(
  "buy_email_pack",
  "Buy a $5 email pack (10,000 emails, never expire). Pack credits activate when tier daily limit is exhausted AND a custom sender domain is verified. Returns a Stripe checkout URL.",
  buyEmailPackSchema,
  async (args) => handleBuyEmailPack(args),
);

server.tool(
  "set_auto_recharge",
  "Enable or disable automatic email pack repurchase when credits drop below a threshold. Requires a saved Stripe payment method.",
  setAutoRechargeSchema,
  async (args) => handleSetAutoRecharge(args),
);

// ─── KMS contract wallets ──────────────────────────────────────────────────

server.tool(
  "provision_contract_wallet",
  "Provision an AWS KMS-backed Ethereum wallet for signing smart-contract write transactions. Private keys never leave KMS. Cost: $0.04/day rental ($1.20/month) plus $0.000005 per contract call. Requires $1.20 in cash credit at creation (30 days of rent). Non-custodial.",
  provisionContractWalletSchema,
  async (args) => handleProvisionContractWallet(args),
);

server.tool(
  "get_contract_wallet",
  "Get a KMS contract wallet's metadata + live native-token balance + USD-micros (Chainlink-cached price).",
  getContractWalletSchema,
  async (args) => handleGetContractWallet(args),
);

server.tool(
  "list_contract_wallets",
  "List all KMS contract wallets owned by the project, including deleted ones.",
  listContractWalletsSchema,
  async (args) => handleListContractWallets(args),
);

server.tool(
  "set_recovery_address",
  "Set or clear the optional recovery address used for auto-drain on day-90 deletion of a KMS contract wallet.",
  setRecoveryAddressSchema,
  async (args) => handleSetRecoveryAddress(args),
);

server.tool(
  "set_low_balance_alert",
  "Set the low-balance threshold (in wei) for a KMS contract wallet. Email alerts fire when the wallet's native balance drops below this threshold.",
  setLowBalanceAlertSchema,
  async (args) => handleSetLowBalanceAlert(args),
);

server.tool(
  "contract_call",
  "Submit a smart-contract write call from a KMS wallet. The gateway encodes via viem, signs the digest via AWS KMS, and broadcasts. Idempotent on optional idempotency_key. Cost: chain gas at-cost + $0.000005 KMS sign fee per call.",
  contractCallSchema,
  async (args) => handleContractCall(args),
);

server.tool(
  "contract_read",
  "Read-only smart-contract call (view/pure functions). No signing, no gas, no billing — pure RPC convenience.",
  contractReadSchema,
  async (args) => handleContractRead(args),
);

server.tool(
  "get_contract_call_status",
  "Look up a previously submitted contract call by call_id. Returns lifecycle state (pending/confirmed/failed), block number, gas used, gas cost in USD-micros, receipt, and any error.",
  getContractCallStatusSchema,
  async (args) => handleGetContractCallStatus(args),
);

server.tool(
  "drain_contract_wallet",
  "Drain a KMS contract wallet's entire native-token balance to a destination address. Works on suspended wallets — the safety valve. Cost: chain gas + $0.000005 KMS sign fee.",
  drainContractWalletSchema,
  async (args) => handleDrainContractWallet(args),
);

server.tool(
  "delete_contract_wallet",
  "Schedule the KMS key for a contract wallet for deletion (7-day AWS minimum window). Refused if the wallet has on-chain balance ≥ dust — drain first.",
  deleteContractWalletSchema,
  async (args) => handleDeleteContractWallet(args),
);

// ─── Service status (public, unauthenticated) ───────────────────────────────

server.tool(
  "service_status",
  "Reports on the Run402 SERVICE (availability, capabilities, operator, deployment) — not your account. For your account status (allowance, tier, projects), use `status`. Reads public GET /status. No auth, no allowance required.",
  serviceStatusSchema,
  async (args) => handleServiceStatus(args),
);

server.tool(
  "service_health",
  "Liveness check for the Run402 SERVICE — not your account. For your account status (allowance, tier, projects), use `status`. Reads public GET /health with per-dependency check results. No auth required.",
  serviceHealthSchema,
  async (args) => handleServiceHealth(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
