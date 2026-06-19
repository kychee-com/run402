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
import { deploySchema, handleDeploy } from "./tools/deploy.js";
import { deployDiagnoseUrlSchema, handleDeployDiagnoseUrl } from "./tools/deploy-diagnose-url.js";
import { deployResumeSchema, handleDeployResume } from "./tools/deploy-resume.js";
import { deployListSchema, handleDeployList } from "./tools/deploy-list.js";
import { deployEventsSchema, handleDeployEvents } from "./tools/deploy-events.js";
import {
  deployReleaseActiveSchema,
  deployReleaseDiffSchema,
  deployReleaseGetSchema,
  handleDeployReleaseActive,
  handleDeployReleaseDiff,
  handleDeployReleaseGet,
} from "./tools/deploy-release.js";
import {
  ciCreateBindingSchema,
  ciGetBindingSchema,
  ciListBindingsSchema,
  ciRevokeBindingSchema,
  handleCiCreateBinding,
  handleCiGetBinding,
  handleCiListBindings,
  handleCiRevokeBinding,
} from "./tools/ci.js";
import { claimSubdomainSchema, handleClaimSubdomain } from "./tools/subdomain.js";
import { deleteSubdomainSchema, handleDeleteSubdomain } from "./tools/subdomain.js";
import { deployFunctionSchema, handleDeployFunction } from "./tools/deploy-function.js";
import { invokeFunctionSchema, handleInvokeFunction } from "./tools/invoke-function.js";
import { getFunctionLogsSchema, handleGetFunctionLogs } from "./tools/get-function-logs.js";
import { setSecretSchema, handleSetSecret } from "./tools/set-secret.js";

// New tools — database
import { applyExposeSchema, handleApplyExpose } from "./tools/apply-expose.js";
import { validateManifestSchema, handleValidateManifest } from "./tools/validate-manifest.js";
import { getExposeSchema, handleGetExpose } from "./tools/get-expose.js";
import { getSchemaSchema, handleGetSchema } from "./tools/get-schema.js";
import { getUsageSchema, handleGetUsage } from "./tools/get-usage.js";

// New tools — bundle & marketplace
import { browseAppsSchema, handleBrowseApps } from "./tools/browse-apps.js";
import { forkAppSchema, handleForkApp } from "./tools/fork-app.js";
import { getQuoteSchema, handleGetQuote } from "./tools/get-quote.js";
import { publishAppSchema, handlePublishApp } from "./tools/publish-app.js";
import { listVersionsSchema, handleListVersions } from "./tools/list-versions.js";

// Direct-to-S3 blob storage
import { blobPutSchema, handleBlobPut } from "./tools/assets-put.js";
import { blobGetSchema, handleBlobGet } from "./tools/assets-get.js";
import { blobLsSchema, handleBlobLs } from "./tools/assets-ls.js";
import { blobRmSchema, handleBlobRm } from "./tools/assets-rm.js";
import { blobSignSchema, handleBlobSign } from "./tools/assets-sign.js";
import { blobDiagnoseSchema, handleBlobDiagnose } from "./tools/assets-diagnose.js";
import { blobWaitFreshSchema, handleBlobWaitFresh } from "./tools/assets-wait-fresh.js";

// New tools — functions & secrets CRUD
import { listFunctionsSchema, handleListFunctions } from "./tools/list-functions.js";
import { deleteFunctionSchema, handleDeleteFunction } from "./tools/delete-function.js";
import { updateFunctionSchema, handleUpdateFunction } from "./tools/update-function.js";
import { functionsRebuildSchema, handleFunctionsRebuild } from "./tools/functions-rebuild.js";
import { listSecretsSchema, handleListSecrets } from "./tools/list-secrets.js";
import { deleteSecretSchema, handleDeleteSecret } from "./tools/delete-secret.js";
import {
  handleJobsCancel,
  handleJobsDownloadArtifact,
  handleJobsGet,
  handleJobsLogs,
  handleJobsPurge,
  handleJobsSubmit,
  jobsCancelSchema,
  jobsDownloadArtifactSchema,
  jobsGetSchema,
  jobsLogsSchema,
  jobsPurgeSchema,
  jobsSubmitSchema,
} from "./tools/jobs.js";

// New tools — subdomains & projects
import { listSubdomainsSchema, handleListSubdomains } from "./tools/list-subdomains.js";
import { deleteProjectSchema, handleDeleteProject } from "./tools/delete-project.js";
import { renameProjectSchema, handleRenameProject } from "./tools/rename-project.js";

// v1.57 — operator-only project + organization actions
import {
  adminSetLeasePerpetualSchema,
  handleAdminSetLeasePerpetual,
} from "./tools/admin-set-lease-perpetual.js";
import {
  adminArchiveProjectSchema,
  handleAdminArchiveProject,
} from "./tools/admin-archive-project.js";
import {
  adminReactivateProjectSchema,
  handleAdminReactivateProject,
} from "./tools/admin-reactivate-project.js";

// Unified project transfer (v1.96+) — wallet (accept), email (claim), org (same-actor)
import {
  acceptProjectTransferSchema,
  cancelProjectTransferSchema,
  claimProjectTransferSchema,
  handleAcceptProjectTransfer,
  handleCancelProjectTransfer,
  handleClaimProjectTransfer,
  handleInitiateProjectTransfer,
  handleListIncomingTransfers,
  handleListOutgoingTransfers,
  handlePreviewProjectTransfer,
  initiateProjectTransferSchema,
  listIncomingTransfersSchema,
  listOutgoingTransfersSchema,
  previewProjectTransferSchema,
} from "./tools/transfers.js";
import {
  createOrgSchema,
  handleCreateOrg,
  getOrgSchema,
  handleGetOrg,
  renameOrgSchema,
  handleRenameOrg,
  whoamiSchema,
  handleWhoami,
  listOrgsSchema,
  handleListOrgs,
  listOrgMembersSchema,
  handleListOrgMembers,
  addOrgMemberSchema,
  handleAddOrgMember,
  setOrgMemberRoleSchema,
  handleSetOrgMemberRole,
  removeOrgMemberSchema,
  handleRemoveOrgMember,
} from "./tools/orgs.js";
import {
  createProjectGrantSchema,
  handleCreateProjectGrant,
  revokeProjectGrantSchema,
  handleRevokeProjectGrant,
} from "./tools/grants.js";

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
import { listMailboxesSchema, handleListMailboxes } from "./tools/list-mailboxes.js";
import { setMailboxDefaultsSchema, handleSetMailboxDefaults } from "./tools/set-mailbox-defaults.js";
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
import { listMailboxWebhookDeliveriesSchema, handleListMailboxWebhookDeliveries } from "./tools/list-mailbox-webhook-deliveries.js";
import { redriveMailboxWebhookDeliverySchema, handleRedriveMailboxWebhookDelivery } from "./tools/redrive-mailbox-webhook-delivery.js";

// New tools — magic link auth
import { requestMagicLinkSchema, handleRequestMagicLink } from "./tools/request-magic-link.js";
import { verifyMagicLinkSchema, handleVerifyMagicLink } from "./tools/verify-magic-link.js";
import { setUserPasswordSchema, handleSetUserPassword } from "./tools/set-user-password.js";
import { authSettingsSchema, handleAuthSettings } from "./tools/auth-settings.js";
import { scaffoldRolesSchema, handleScaffoldRoles } from "./tools/scaffold-roles.js";
import {
  createAuthUserSchema,
  handleCreateAuthUser,
  handleInviteAuthUser,
  inviteAuthUserSchema,
} from "./tools/auth-users.js";
import {
  deletePasskeySchema,
  handleDeletePasskey,
  handleListPasskeys,
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  listPasskeysSchema,
  passkeyLoginOptionsSchema,
  passkeyLoginVerifySchema,
  passkeyRegisterOptionsSchema,
  passkeyRegisterVerifySchema,
} from "./tools/passkeys.js";

// New tools — custom sender domains
import { registerSenderDomainSchema, handleRegisterSenderDomain } from "./tools/register-sender-domain.js";
import { senderDomainStatusSchema, handleSenderDomainStatus } from "./tools/sender-domain-status.js";
import { removeSenderDomainSchema, handleRemoveSenderDomain } from "./tools/remove-sender-domain.js";
import { enableInboundSchema, handleEnableInbound } from "./tools/enable-inbound.js";
import { disableInboundSchema, handleDisableInbound } from "./tools/disable-inbound.js";

// New tools — email organizations + org checkout
import { createEmailOrganizationSchema, handleCreateEmailOrganization } from "./tools/create-email-organization.js";
import { linkWalletToOrganizationSchema, handleLinkWalletToOrganization } from "./tools/link-wallet-to-organization.js";
import { setAutoRechargeSchema, handleSetAutoRecharge } from "./tools/set-auto-recharge.js";

// New tools — AI
import { aiTranslateSchema, handleAiTranslate } from "./tools/ai-translate.js";
import { aiModerateSchema, handleAiModerate } from "./tools/ai-moderate.js";
import { aiUsageSchema, handleAiUsage } from "./tools/ai-usage.js";

// New tools — messaging, agent contact, billing, deployments, versions
import { sendMessageSchema, handleSendMessage } from "./tools/send-message.js";
import { setAgentContactSchema, handleSetAgentContact } from "./tools/set-agent-contact.js";
import { getAgentContactStatusSchema, handleGetAgentContactStatus } from "./tools/get-agent-contact-status.js";
import { verifyAgentContactEmailSchema, handleVerifyAgentContactEmail } from "./tools/verify-agent-contact-email.js";
import {
  startOperatorPasskeyEnrollmentSchema,
  handleStartOperatorPasskeyEnrollment,
} from "./tools/start-operator-passkey-enrollment.js";
import { getOperatorStatusSchema, handleGetOperatorStatus } from "./tools/get-operator-status.js";
import { getNotificationPreferencesSchema, handleGetNotificationPreferences } from "./tools/get-notification-preferences.js";
import { setNotificationPreferencesSchema, handleSetNotificationPreferences } from "./tools/set-notification-preferences.js";
import { listNotificationsSchema, handleListNotifications } from "./tools/list-notifications.js";
import { testNotificationSchema, handleTestNotification } from "./tools/test-notification.js";
import { rotateWebhookSecretSchema, handleRotateWebhookSecret } from "./tools/rotate-webhook-secret.js";
import { createCheckoutSchema, handleCreateCheckout } from "./tools/create-checkout.js";
import { billingHistorySchema, handleBillingHistory } from "./tools/billing-history.js";
import { updateVersionSchema, handleUpdateVersion } from "./tools/update-version.js";
import { deleteVersionSchema, handleDeleteVersion } from "./tools/delete-version.js";
import { getAppSchema, handleGetApp } from "./tools/get-app.js";
import { tierStatusSchema, handleTierStatus } from "./tools/tier-status.js";
import { initSchema, handleInit } from "./tools/init.js";
import { statusSchema, handleStatus } from "./tools/status.js";
import { projectInfoSchema, handleProjectInfo } from "./tools/project-info.js";
import { projectGetSchema, handleProjectGet } from "./tools/project-get.js";
import { projectUseSchema, handleProjectUse } from "./tools/project-use.js";
import { projectKeysSchema, handleProjectKeys } from "./tools/project-keys.js";

// New tools — KMS contract wallets
import { provisionSignerSchema, handleProvisionSigner } from "./tools/provision-signer.js";
import { getSignerSchema, handleGetSigner } from "./tools/get-signer.js";
import { listSignersSchema, handleListSigners } from "./tools/list-signers.js";
import { setRecoveryAddressSchema, handleSetRecoveryAddress } from "./tools/set-recovery-address.js";
import { setLowBalanceAlertSchema, handleSetLowBalanceAlert } from "./tools/set-low-balance-alert.js";
import { contractCallSchema, handleContractCall } from "./tools/contract-call.js";
import { contractDeploySchema, handleContractDeploy } from "./tools/contract-deploy.js";
import { contractReadSchema, handleContractRead } from "./tools/contract-read.js";
import { getContractCallStatusSchema, handleGetContractCallStatus } from "./tools/get-contract-call-status.js";
import { drainSignerSchema, handleDrainSigner } from "./tools/drain-signer.js";
import { deleteSignerSchema, handleDeleteSigner } from "./tools/delete-signer.js";

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
  "apply_expose",
  "Apply a declarative authorization manifest to a project (POST /projects/v1/admin/:id/expose). The manifest describes the full authorization surface: tables (with policy, owner_column, force_owner_on_insert, i_understand_this_is_unrestricted, custom_sql), views (with base, select, filter), and rpcs (with signature, grant_to). Convergent: applying the same manifest twice is a no-op; items dropped between applies have their policies/grants/triggers/views revoked. Tables are dark by default — any table not declared with expose:true is unreachable via anon/authenticated.",
  applyExposeSchema,
  async (args) => handleApplyExpose(args),
);

server.tool(
  "validate_manifest",
  "Validate an auth/expose manifest without applying it. This checks the authorization manifest used by manifest.json, database.expose, and apply_expose; it is not deploy-manifest validation. Optional migration_sql is reference context only and is not executed. Use deploy planning/dry-run surfaces for deploy manifest questions.",
  validateManifestSchema,
  async (args) => handleValidateManifest(args),
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
  "assets_put",
  "Upload a blob (file or inline content) to project storage via direct-to-S3. Accepts local_path (any size up to 5 TiB) or content (≤ 1 MB inline). Public blobs get a CDN URL; private blobs require authenticated reads. Use `immutable: true` to produce a content-addressed URL that never needs cache invalidation. For image uploads (jpeg/png/webp/heic/heif), the gateway also returns width_px/height_px/blurhash/display_url and a `variants` map (thumb 320w, medium 800w, large 1920w WebP — plus display_jpeg for HEIC sources) so apps can render responsive thumbnails without re-encoding client-side. See the SDK docs for the full AssetRef shape.",
  blobPutSchema,
  async (args) => handleBlobPut(args),
);

server.tool(
  "assets_get",
  "Download a blob to a local file path. Writes bytes directly to disk (no context-window bloat). Returns size + SHA-256 header (if the blob has one stored).",
  blobGetSchema,
  async (args) => handleBlobGet(args),
);

server.tool(
  "assets_ls",
  "List blobs in a project with optional prefix filter over a flat key namespace. Supports pagination via cursor.",
  blobLsSchema,
  async (args) => handleBlobLs(args),
);

server.tool(
  "assets_rm",
  "Delete a blob from project storage and decrement the project's storage_bytes.",
  blobRmSchema,
  async (args) => handleBlobRm(args),
);

server.tool(
  "assets_sign",
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
  "Polls the CDN until a MUTABLE blob URL serves the expected SHA-256, or the timeout elapses. **For mutable URLs only** — for immutable URLs (the `immutableUrl` returned by `assets_put`), no waiting is needed; they're bound to a SHA at upload time and never previously cached. Use this after a re-upload to an existing public mutable key when an end-user-visible URL must reflect the new content before continuing. The probe is single-vantage (us-east-1). On timeout, the tool returns isError=true so an agent can branch into a fallback — typically: switch to the immutableUrl.",
  blobWaitFreshSchema,
  async (args) => handleBlobWaitFresh(args),
);

// ─── Functions tools ────────────────────────────────────────────────────────

server.tool(
  "deploy_function",
  "Deploy a serverless function (Node 22) to a project. Handler signature: export default async (req: Request) => Response. The function can `import { db, adminDb, auth, email, ai } from '@run402/functions'` — auto-bundled by the platform. Additional npm packages are bundled at deploy time when listed in `deps` (bare names resolve to latest; pinned/range specs are honored verbatim; `@run402/functions` and `run402-functions` rejected; max 30 entries; native binaries rejected). The response includes `runtime_version` (the bundled `@run402/functions` version — surface as 'Functions runtime version', never bare 'runtime'), `deps_resolved` (map of dep name → installed concrete version), and an optional top-level `warnings` array (sibling to the function record).",
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
  "List all deployed functions for a project. Shows names, URLs, runtime, timeout, memory, and (for functions deployed under bundling-at-deploy) the Functions runtime version (`@run402/functions` version) and resolved direct deps. Functions deployed before that change have `runtime_version` and `deps_resolved` set to null.",
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

server.tool(
  "functions_rebuild",
  "Refresh function(s) onto the platform's current entry wrapper + bundled runtime WITHOUT changing source (capability function-runtime-rebuild, gateway v1.69+). Provide `name` to rebuild one function, or omit it to rebuild every function in the project. Re-bundles from each function's STORED source with deps pinned to the recorded exact versions, so the source `code_hash` is unchanged and no new release is created — this is how a gateway-side wrapper fix (e.g. an SSR auth.* fix) reaches an already-deployed function (a plain redeploy with unchanged source does NOT pick it up). Strictly opt-in; the platform never auto-rebuilds. Wallet-authed (project ownership; no service key) and allowed during billing grace. Functions deployed before dependency locking return CANNOT_REBUILD_UNLOCKED_DEPS — redeploy them from source with `deploy_function`. Use `list_functions` (runtime_stale) or `run402 doctor` to find stale functions.",
  functionsRebuildSchema,
  async (args) => handleFunctionsRebuild(args),
);

// ─── Secrets tools ──────────────────────────────────────────────────────────

server.tool(
  "set_secret",
  "Set a project secret (e.g. STRIPE_SECRET_KEY). Values are write-only and injected as process.env variables in functions. Setting an existing key overwrites it. Use this before deploy, then declare the key with secrets.require.",
  setSecretSchema,
  async (args) => handleSetSecret(args),
);

server.tool(
  "list_secrets",
  "List secret keys for a project. Values and value-derived hashes are never shown; use this only to check which keys are configured.",
  listSecretsSchema,
  async (args) => handleListSecrets(args),
);

server.tool(
  "delete_secret",
  "Delete a secret from a project.",
  deleteSecretSchema,
  async (args) => handleDeleteSecret(args),
);

// ─── Managed jobs tools ────────────────────────────────────────────────────

server.tool(
  "jobs_submit",
  "Submit a platform-managed job. The request must match the gateway jobs API shape: job_type, input with input.json, and max_cost_usd_micros. The SDK supplies the required idempotency header.",
  jobsSubmitSchema,
  async (args) => handleJobsSubmit(args),
);

server.tool(
  "jobs_get",
  "Get a managed job run by id.",
  jobsGetSchema,
  async (args) => handleJobsGet(args),
);

server.tool(
  "jobs_logs",
  "Read recent runner logs for a managed job. Use tail to cap entries and since for an epoch millisecond lower bound.",
  jobsLogsSchema,
  async (args) => handleJobsLogs(args),
);

server.tool(
  "jobs_cancel",
  "Cancel a queued or running managed job.",
  jobsCancelSchema,
  async (args) => handleJobsCancel(args),
);

server.tool(
  "jobs_purge",
  "Purge all managed job runs for a project, terminating known active runners first.",
  jobsPurgeSchema,
  async (args) => handleJobsPurge(args),
);

server.tool(
  "jobs_download_artifact",
  "Download a completed managed job's artifact by filename to a local file. Discover the recorded filenames from the artifacts map returned by jobs_get; the legacy run402:// refs were retired in favor of these gateway URLs.",
  jobsDownloadArtifactSchema,
  async (args) => handleJobsDownloadArtifact(args),
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
  "deploy",
  "Unified apply primitive. Accepts a structured ReleaseSpec — database (migrations + expose), value-free secrets.require/delete declarations, functions, site, site.public_paths, subdomains, and routes.replace web routes — with explicit replace vs patch semantics per resource. Use site.public_paths for clean static URLs such as /events backed by release asset events.html; explicit mode does not expose /events.html unless separately declared, while mode: 'implicit' restores filename-derived reachability and can widen access. Route entries map exact/final-wildcard browser paths like /admin and /admin/* to Node 22 Fetch Request -> Response functions, or exact GET/HEAD method-aware static aliases such as /events to { type: 'static', file: 'events.html' }; intentional read-only GET/HEAD wildcard function routes may set acknowledge_readonly: true. Direct /functions/v1/:name remains API-key protected. Secret values must be set first with set_secret, never placed in deploy specs. All bytes ride through CAS (no inline-body cap). Returns release_id, URLs, warnings, and a structured progress-event log. Stops before upload/commit on confirmation-required warnings unless reviewed codes are passed with allow_warning_codes or allow_warnings is true.",
  deploySchema,
  async (args) => handleDeploy(args),
);

server.tool(
  "deploy_diagnose_url",
  "Read-only authenticated diagnostics for a Run402 public URL or host/path pair. Explains whether the current live release would serve the URL, including match, diagnostic body status, static manifest/cache metadata when returned, structured warnings for ignored query/fragment, and next steps. This does not fetch bytes, purge cache, mutate deploy state, or expose internal CAS URLs.",
  deployDiagnoseUrlSchema,
  async (args) => handleDeployDiagnoseUrl(args),
);

server.tool(
  "deploy_resume",
  "Resume a deploy operation that ended in `activation_pending` or `schema_settling` (e.g. transient gateway failure between SQL commit and the pointer-swap activation). The gateway re-runs only the failed phase forward — SQL is never replayed. Idempotent: calling on an already-terminal operation returns the snapshot without re-running.",
  deployResumeSchema,
  async (args) => handleDeployResume(args),
);

server.tool(
  "deploy_list",
  "List recent deploy operations for a project. Returns operation_id, status, release_id, and timestamps. Use this to build deploy-history UIs or to find a recent operation_id to feed into `deploy_resume` / `deploy_events`. Pass `limit` to bound the result set; the gateway also returns a `cursor` for pagination when there are more.",
  deployListSchema,
  async (args) => handleDeployList(args),
);

server.tool(
  "deploy_events",
  "Fetch the recorded phase-event stream for a deploy operation. Returns the same `DeployEvent` shapes the `deploy` tool emits inline during an in-flight deploy — useful for inspecting a deploy after the fact (e.g., a deploy that the agent didn't observe directly, or one being resumed from a different process).",
  deployEventsSchema,
  async (args) => handleDeployEvents(args),
);

server.tool(
  "deploy_release_get",
  "Fetch a release inventory by id. Returns release metadata, effective/desired state kind, site path inventory, function inventory, secret keys, subdomains, and applied migrations. Use `site_limit` to cap large site inventories. Canonical SDK errors are preserved.",
  deployReleaseGetSchema,
  async (args) => handleDeployReleaseGet(args),
);

server.tool(
  "deploy_release_active",
  "Fetch the current-live release inventory for a project. Returns `release_id: null` with an empty current-live inventory when no release is active yet. Use this before deploy diffs to understand what is currently serving. Canonical SDK errors are preserved.",
  deployReleaseActiveSchema,
  async (args) => handleDeployReleaseActive(args),
);

server.tool(
  "deploy_release_diff",
  "Diff two release targets for a project. `from` may be `empty`, `active`, or a release id; `to` may be `active` or a release id. Returns release-to-release diff buckets and `migrations.applied_between_releases`. Semantic gateway errors such as invalid targets, same-release diffs, or no active release are preserved.",
  deployReleaseDiffSchema,
  async (args) => handleDeployReleaseDiff(args),
);

// ─── CI/OIDC binding tools ─────────────────────────────────────────────────

server.tool(
  "ci_create_binding",
  "Create a GitHub Actions CI/OIDC deploy binding by sending a locally signed delegation to the SDK. This MCP wrapper does not sign or broaden authority; the signed delegation defines the repository/branch or environment, allowed events/actions, and optional route_scopes. Without route_scopes, CI cannot deploy route declarations.",
  ciCreateBindingSchema,
  async (args) => handleCiCreateBinding(args),
);

server.tool(
  "ci_list_bindings",
  "List CI/OIDC deploy bindings for a project, including route_scopes when delegated. Use this to inspect which GitHub Actions subjects can deploy before editing bindings.",
  ciListBindingsSchema,
  async (args) => handleCiListBindings(args),
);

server.tool(
  "ci_get_binding",
  "Get one CI/OIDC deploy binding by id, including its subject, allowed events/actions, repository id, revocation state, and route_scopes.",
  ciGetBindingSchema,
  async (args) => handleCiGetBinding(args),
);

server.tool(
  "ci_revoke_binding",
  "Revoke one CI/OIDC deploy binding. Revocation stops future CI gateway requests, but does not undo already deployed releases or rotate secrets.",
  ciRevokeBindingSchema,
  async (args) => handleCiRevokeBinding(args),
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

// ─── Marketplace tools ───────────────────────────────────────────────────────

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
  "Check current tier subscription — tier name, status, expiry, usage, and function authoring caps when returned (max timeout, memory, scheduled functions, min cron interval). Requires allowance auth.",
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

server.tool(
  "rename_project",
  "Rename a project (PATCH /projects/v1/:id) — fix an auto-generated name. Authorization is org-membership based (admin+ on the owning org, or a project:write grant) and authorize-before-reveal: an unauthorized or guessed id returns the same 403 as a real-but-unauthorized project, never a not-found oracle. Uses the wallet's SIWX auth (not a project service key), so it works even if the project isn't in the local key store. The server validates the name (non-empty, ≤ 200 chars, no control characters).",
  renameProjectSchema,
  async (args) => handleRenameProject(args),
);

// ─── Admin tools ─────────────────────────────────────────────────────────────

server.tool(
  "admin_set_lease_perpetual",
  "Toggle an organization's `lease_perpetual` escape hatch (v1.57+). When `lease_perpetual: true`, the organization never advances past `active` regardless of lease expiry; every project in the organization inherits the pinned state. Enabling on a grace-state organization (past_due / frozen / dormant) reactivates inline and returns `reactivated: true`. Platform-admin only — uses the configured allowance wallet for admin auth. Replaces the v1.56 `pin_project` (gateway endpoint /projects/v1/admin/:id/pin was removed in v1.57). Calls POST /orgs/v1/admin/:org_id/lease-perpetual.",
  adminSetLeasePerpetualSchema,
  async (args) => handleAdminSetLeasePerpetual(args),
);

server.tool(
  "admin_archive_project",
  "Operator moderation action — archive a single project (sets `projects.archived_at = NOW()`). Independent of organization-level lifecycle: sibling projects on the same organization keep serving. No-op when the project is already archived. Platform-admin only. Calls POST /projects/v1/admin/:id/archive.",
  adminArchiveProjectSchema,
  async (args) => handleAdminArchiveProject(args),
);

server.tool(
  "admin_reactivate_project",
  "Operator un-archive — flips `projects.archived_at` back to NULL. In v1.57 this was narrowed: it no longer touches organization-level lifecycle. To reactivate a grace-state organization, subscribe a tier (`tier_set`) or enable lease-perpetual (`admin_set_lease_perpetual`). Platform-admin only. Calls POST /projects/v1/admin/:id/reactivate.",
  adminReactivateProjectSchema,
  async (args) => handleAdminReactivateProject(args),
);

// ─── Project transfer (unified noun, v1.96+) ────────────────────────────────

server.tool(
  "initiate_project_transfer",
  "Initiate a project transfer (v1.96+). Addressed to a WALLET (`to_wallet`, completed by `accept_project_transfer`), an EMAIL (`to_email`, completed by `claim_project_transfer`), OR an ORG (`to_org_id`, same-actor move completed synchronously) — provide exactly one. Wallet/email transfers create a pending row with 72h expiry and freeze owner-side mutations until completed, cancelled, or expired. `to_org_id` requires active owner membership on both source and destination orgs; if the caller does not own the destination org, the gateway returns 403 and creates no pending org transfer yet. The project moves under the `migrate` billing policy. Owner's tier lease is NOT refunded. GitHub repo ownership is NOT transferred. Calls POST /projects/v1/:project_id/transfers.",
  initiateProjectTransferSchema,
  async (args) => handleInitiateProjectTransfer(args),
);

server.tool(
  "preview_project_transfer",
  "Fetch the preview document for a pending wallet/email project transfer (v1.96+). Returns the safe review payload: project name, custom domains, subdomains, function names, secret NAMES (values are never returned), CI bindings that will be revoked at completion, mailbox summary, billing implications, and — on email transfers — the retain_collaborator offer. Caller must be a party to the transfer. Same-actor org moves return their accepted result from initiate_project_transfer and usually have no preview. Calls GET /agent/v1/transfers/:transfer_id.",
  previewProjectTransferSchema,
  async (args) => handlePreviewProjectTransfer(args),
);

server.tool(
  "accept_project_transfer",
  "Accept an incoming WALLET transfer (v1.96+). Your wallet must equal the transfer's to_wallet. The accept transaction atomically: (a) flips ownership to your wallet, (b) revokes the previous owner's CI bindings on the project, (c) enqueues notifications to both parties, (d) stamps a persistent `secrets_rotation_advised` advisory. Secret VALUES are inherited (rotation strongly advised via `set_secret` for each name). GitHub repo ownership is NOT part of the transfer. Email transfers complete via `claim_project_transfer`, not this tool. Org moves complete from `initiate_project_transfer` with `to_org_id`. Calls POST /agent/v1/transfers/:transfer_id/accept.",
  acceptProjectTransferSchema,
  async (args) => handleAcceptProjectTransfer(args),
);

server.tool(
  "claim_project_transfer",
  "Claim an incoming EMAIL transfer into an org (v1.96+) — the email analog of `accept_project_transfer`. The transfer's addressed email must match your verified email. Provide `org_id` to claim into an org you own/admin, or omit to create a new org. Atomically flips ownership and returns the new owner's project keys (persisted to the local keystore, symmetric with accept) so you can operate the project immediately. Org moves complete from `initiate_project_transfer` with `to_org_id`. Calls POST /agent/v1/transfers/:transfer_id/claim.",
  claimProjectTransferSchema,
  async (args) => handleClaimProjectTransfer(args),
);

server.tool(
  "cancel_project_transfer",
  "Cancel a pending wallet/email project transfer (v1.96+). You must be authorized for the row's kind (a wallet signing party, or an owner/admin of the offering org / the addressed-email principal). Already-accepted/cancelled/expired transfers return 409 TRANSFER_ALREADY_PROCESSED. Same-actor org moves normally have no pending row to cancel. Calls POST /agent/v1/transfers/:transfer_id/cancel.",
  cancelProjectTransferSchema,
  async (args) => handleCancelProjectTransfer(args),
);

server.tool(
  "list_incoming_transfers",
  "List pending project transfers OFFERED TO the authenticated wallet (v1.59+). Each entry carries `preview_path` for deep-linking into the preview tool. Calls GET /agent/v1/transfers/incoming.",
  listIncomingTransfersSchema,
  async (args) => handleListIncomingTransfers(args),
);

server.tool(
  "list_outgoing_transfers",
  "List pending project transfers INITIATED BY the authenticated wallet (v1.59+). Each entry carries `preview_path` for deep-linking into the preview tool. Calls GET /agent/v1/transfers/outgoing.",
  listOutgoingTransfersSchema,
  async (args) => handleListOutgoingTransfers(args),
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
  "Check the organization balance for the agent's allowance wallet — available and held funds. The wallet is resolved to its organization over SIWX (signed automatically); reading a wallet that is not linked to yours requires an admin key.",
  checkBalanceSchema,
  async (args) => handleCheckBalance(args),
);

server.tool(
  "list_projects",
  "List projects from the named, domain-aware inventory (GET /projects/v1). Membership-scoped by default: every project owned by an org the agent's wallet is an active member of, with name, site_url, custom_domains, org (org_id), and status. SIWX wallet auth is signed automatically. Pass org_id to filter to one org (authorize-before-reveal: non-member/guessed → 403, non-UUID → 400), all:true to read the cross-wallet inventory across every wallet controlling your operator email, or limit/cursor to paginate.",
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
  "Create a project-scoped email mailbox at <slug>@mail.run402.com. Returns mailbox_settings and next_actions when the gateway provides default-role repair guidance. Not idempotent: slug conflicts/cooldowns/limit errors are surfaced.",
  createMailboxSchema,
  async (args) => handleCreateMailbox(args),
);

server.tool(
  "list_mailboxes",
  "List a project's mailboxes, including default-role metadata (`is_default_outbound`, `is_auth_sender`), readiness (`can_send`, `send_blocked_reason`, `domain_kind`), mailbox_settings, and next_actions. Use before choosing or repairing email defaults.",
  listMailboxesSchema,
  async (args) => handleListMailboxes(args),
);

server.tool(
  "set_mailbox_defaults",
  "Set default_outbound_mailbox_id and/or auth_sender_mailbox_id for a project. Use list_mailboxes first to choose an explicit mailbox id; sending without a mailbox uses the configured outbound default instead of guessing.",
  setMailboxDefaultsSchema,
  async (args) => handleSetMailboxDefaults(args),
);

server.tool(
  "send_email",
  "Send an email. Two modes: template (project_invite, magic_link, notification) or raw HTML (subject + html). Optional from_name for display name. Single recipient only. Pass mailbox to target a slug/id; otherwise the configured default_outbound_mailbox_id is used. Result echoes mailbox_id and from_address when the gateway provides them.",
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

server.tool(
  "list_mailbox_webhook_deliveries",
  "List durable webhook delivery rows for the project's mailbox. Webhook delivery is at-least-once with bounded retries + backoff; failures land in 'failed_permanent' (the dead-letter queue). Filter by status to inspect what was lost. Consumers must dedupe on the envelope idempotency_key.",
  listMailboxWebhookDeliveriesSchema,
  async (args) => handleListMailboxWebhookDeliveries(args),
);

server.tool(
  "redrive_mailbox_webhook_delivery",
  "Re-queue a dead-lettered (failed_permanent) webhook delivery so the worker attempts delivery again. Use after fixing the consumer endpoint.",
  redriveMailboxWebhookDeliverySchema,
  async (args) => handleRedriveMailboxWebhookDelivery(args),
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
  "Register agent contact info (name, email, webhook). New or changed emails start operator email reply verification. Free with allowance auth.",
  setAgentContactSchema,
  async (args) => handleSetAgentContact(args),
);

server.tool(
  "get_agent_contact_status",
  "Get the current agent contact assurance state: wallet_only, email_pending, email_verified, passkey_pending, or operator_passkey.",
  getAgentContactStatusSchema,
  async (args) => handleGetAgentContactStatus(args),
);

server.tool(
  "verify_agent_contact_email",
  "Start or resend the operator email reply challenge for the active agent contact email. Does not expose the challenge secret.",
  verifyAgentContactEmailSchema,
  async (args) => handleVerifyAgentContactEmail(args),
);

server.tool(
  "start_operator_passkey_enrollment",
  "Email a short-lived Run402 operator passkey enrollment link to the verified contact email. Requires email_verified.",
  startOperatorPasskeyEnrollmentSchema,
  async (args) => handleStartOperatorPasskeyEnrollment(args),
);

// ─── Operator notifications (v1.55) ───────────────────────────────────────

server.tool(
  "get_operator_status",
  "Compact operator-health snapshot: contact assurance, critical items, skipped notifications, organizations, projects, active thresholds. Read via run402 doctor.",
  getOperatorStatusSchema,
  async (args) => handleGetOperatorStatus(args),
);

server.tool(
  "get_notification_preferences",
  "Read the operator's notification preferences (channels, cadence, threshold/lifecycle/security toggles, locale, timezone).",
  getNotificationPreferencesSchema,
  async (args) => handleGetNotificationPreferences(args),
);

server.tool(
  "set_notification_preferences",
  "Update operator notification preferences. Cross-wallet effects require email_verified assurance; webhook URL changes require operator_passkey assurance.",
  setNotificationPreferencesSchema,
  async (args) => handleSetNotificationPreferences(args),
);

server.tool(
  "list_notifications",
  "List the operator's notification audit log (delivered, failed, and skipped attempts). Paginated; filter by event type or since timestamp.",
  listNotificationsSchema,
  async (args) => handleListNotifications(args),
);

server.tool(
  "test_notification",
  "Trigger a real test notification (audit row marked is_test=true). Rate-limited per wallet at 1/min. Verifies the full pipeline end-to-end.",
  testNotificationSchema,
  async (args) => handleTestNotification(args),
);

server.tool(
  "rotate_webhook_secret",
  "Generate a fresh HMAC signing secret for the operator's webhook endpoint. Returned EXACTLY once. Previous secret remains valid for 24h. Requires operator_passkey assurance.",
  rotateWebhookSecretSchema,
  async (args) => handleRotateWebhookSecret(args),
);

// ─── Billing tools ─────────────────────────────────────────────────────────

server.tool(
  "create_checkout",
  "Create a Stripe checkout URL for an organization. Products: balance_topup, tier, email_pack.",
  createCheckoutSchema,
  async (args) => handleCreateCheckout(args),
);

server.tool(
  "billing_history",
  "View billing ledger history for the agent's allowance wallet. The wallet is resolved to its organization over SIWX (signed automatically); a wallet not linked to yours requires an admin key.",
  billingHistorySchema,
  async (args) => handleBillingHistory(args),
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
  "Full organization snapshot — allowance, billing balance, tier subscription, projects, and active project. Single-call overview.",
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
  "project_get",
  "Authoritative server read of a project — name, owning org, tier, effective status, active deploy, mailbox addresses, and usage vs. tier limits. Live API call; returns no keys (use project_keys for those).",
  projectGetSchema,
  async (args) => handleProjectGet(args),
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
  "create_auth_user",
  "Create or update a project auth user with the service key. Can set project_admin and optionally send a trusted invite.",
  createAuthUserSchema,
  async (args) => handleCreateAuthUser(args),
);

server.tool(
  "invite_auth_user",
  "Create/update a project auth user and send a trusted invite magic link. Requires service_key and an allowed redirect_url.",
  inviteAuthUserSchema,
  async (args) => handleInviteAuthUser(args),
);

server.tool(
  "set_user_password",
  "Change, reset, or set a user's password. Change: provide current_password + new_password. Reset (via magic link login): just new_password. Set (passwordless user): requires allow_password_set=true on project.",
  setUserPasswordSchema,
  async (args) => handleSetUserPassword(args),
);

server.tool(
  "auth_settings",
  "Update project auth settings: allow_password_set, preferred_sign_in_method, public_signup, and require_passkey_for_project_admin. Requires service_key.",
  authSettingsSchema,
  async (args) => handleAuthSettings(args),
);

server.tool(
  "scaffold_roles",
  "Generate a role-table migration + requireRole gate snippet + first-operator bootstrap for Run402 function role gates. Offline and deterministic (no project or network). Inputs: table, user_col, role_col, roles[], cache_ttl.",
  scaffoldRolesSchema,
  async (args) => handleScaffoldRoles(args),
);

server.tool(
  "passkey_register_options",
  "Create WebAuthn passkey registration options for the authenticated user.",
  passkeyRegisterOptionsSchema,
  async (args) => handlePasskeyRegisterOptions(args),
);

server.tool(
  "passkey_register_verify",
  "Verify a browser WebAuthn registration response and store the user's passkey.",
  passkeyRegisterVerifySchema,
  async (args) => handlePasskeyRegisterVerify(args),
);

server.tool(
  "passkey_login_options",
  "Create WebAuthn passkey login options for a project app origin.",
  passkeyLoginOptionsSchema,
  async (args) => handlePasskeyLoginOptions(args),
);

server.tool(
  "passkey_login_verify",
  "Verify a browser WebAuthn assertion and return a normal Run402 auth session.",
  passkeyLoginVerifySchema,
  async (args) => handlePasskeyLoginVerify(args),
);

server.tool(
  "list_passkeys",
  "List the authenticated user's active passkeys.",
  listPasskeysSchema,
  async (args) => handleListPasskeys(args),
);

server.tool(
  "delete_passkey",
  "Delete one authenticated-user passkey by id.",
  deletePasskeySchema,
  async (args) => handleDeletePasskey(args),
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

// --- Email organizations + org checkout ---

server.tool(
  "create_email_organization",
  "Create an email-based organization (Stripe-only, no wallet required). Sends a verification email. Idempotent — duplicate emails return the existing organization.",
  createEmailOrganizationSchema,
  async (args) => handleCreateEmailOrganization(args),
);

server.tool(
  "link_wallet_to_organization",
  "Link a wallet to an existing email organization, enabling hybrid Stripe + x402 access. Fails if the wallet is already linked elsewhere.",
  linkWalletToOrganizationSchema,
  async (args) => handleLinkWalletToOrganization(args),
);

server.tool(
  "set_auto_recharge",
  "Enable or disable automatic email pack repurchase when credits drop below a threshold. Requires a saved Stripe payment method.",
  setAutoRechargeSchema,
  async (args) => handleSetAutoRecharge(args),
);

// ─── KMS signers ───────────────────────────────────────────────────────────

server.tool(
  "provision_signer",
  "Provision an AWS KMS-backed Ethereum signer for signing smart-contract write transactions. Private keys never leave KMS. Cost: $0.04/day rental ($1.20/month) plus $0.000005 per contract call. Requires $1.20 in cash credit at creation (30 days of rent). Non-custodial.",
  provisionSignerSchema,
  async (args) => handleProvisionSigner(args),
);

server.tool(
  "get_signer",
  "Get a KMS signer's metadata + live native-token balance + USD-micros (Chainlink-cached price).",
  getSignerSchema,
  async (args) => handleGetSigner(args),
);

server.tool(
  "list_signers",
  "List all KMS signers owned by the project, including deleted ones.",
  listSignersSchema,
  async (args) => handleListSigners(args),
);

server.tool(
  "set_recovery_address",
  "Set or clear the optional recovery address used for auto-drain on day-90 deletion of a KMS signer.",
  setRecoveryAddressSchema,
  async (args) => handleSetRecoveryAddress(args),
);

server.tool(
  "set_low_balance_alert",
  "Set the low-balance threshold (in wei) for a KMS signer. Email alerts fire when the signer's native balance drops below this threshold.",
  setLowBalanceAlertSchema,
  async (args) => handleSetLowBalanceAlert(args),
);

server.tool(
  "contract_call",
  "Submit a smart-contract write call from a KMS signer. The gateway encodes via viem, signs the digest via AWS KMS, and broadcasts. Idempotent on optional idempotency_key. Cost: chain gas at-cost + $0.000005 KMS sign fee per call.",
  contractCallSchema,
  async (args) => handleContractCall(args),
);

server.tool(
  "contract_deploy",
  "Deploy a smart contract from a KMS signer (signs a contract-creation tx with `to: null + data: bytecode`). The `bytecode` is full creation calldata — creation bytecode + ABI-encoded constructor args, concatenated client-side (run402 does NOT compile Solidity). Returns the deterministic CREATE address synchronously in `contract_address` — known before confirmation, no polling needed to know where the contract lives. Same pricing as `contract_call`: chain gas at-cost + $0.000005 KMS sign fee.",
  contractDeploySchema,
  async (args) => handleContractDeploy(args),
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
  "drain_signer",
  "Drain a KMS signer's entire native-token balance to a destination address. Works on suspended signers — the safety valve. Cost: chain gas + $0.000005 KMS sign fee.",
  drainSignerSchema,
  async (args) => handleDrainSigner(args),
);

server.tool(
  "delete_signer",
  "Schedule the KMS key for a signer for deletion (7-day AWS minimum window). Refused if the signer has on-chain balance ≥ dust — drain first.",
  deleteSignerSchema,
  async (args) => handleDeleteSigner(args),
);

// ─── Service status (public, unauthenticated) ───────────────────────────────

server.tool(
  "service_status",
  "Reports on the Run402 SERVICE (availability, capabilities, operator, deployment) — not your organization. For your organization status (allowance, tier, projects), use `status`. Reads public GET /status. No auth, no allowance required.",
  serviceStatusSchema,
  async (args) => handleServiceStatus(args),
);

server.tool(
  "service_health",
  "Liveness check for the Run402 SERVICE — not your organization. For your organization status (allowance, tier, projects), use `status`. Reads public GET /health with per-dependency check results. No auth required.",
  serviceHealthSchema,
  async (args) => handleServiceHealth(args),
);

// ─── Org-owned control plane: identity, membership, grants (v1.77+) ──────────

server.tool(
  "create_org",
  "Create an empty organization on the prototype tier (POST /orgs/v1); you become its owner. Accepts only an optional `display_name` (no tier at create — paid tiers are a separate flow). Step-up gated; the soft per-owner free-org cap may return `FREE_ORG_OWNER_LIMIT_EXCEEDED`.",
  createOrgSchema,
  async (args) => handleCreateOrg(args),
);

server.tool(
  "get_org",
  "Read one organization (GET /orgs/v1/:org_id) — its `org_id`, `display_name`, `tier`, and your `role`. Any active member may read; a non-member (including a guessed id) gets the same non-revealing 403. Params: `org_id`.",
  getOrgSchema,
  async (args) => handleGetOrg(args),
);

server.tool(
  "rename_org",
  "Set or clear an organization's display label (PATCH /orgs/v1/:org_id). Owner-only + step-up gated. Pass `display_name: null` (or `\"\"`) to clear. Params: `org_id`, `display_name`.",
  renameOrgSchema,
  async (args) => handleRenameOrg(args),
);

server.tool(
  "whoami",
  "Resolve the caller's control-plane principal and its org memberships (GET /agent/v1/whoami). A wallet authenticates; ownership is the org. Returns the principal (id/type/displayName/createdAt), authenticator_id, and every org membership (org_id, display_name, role, status). This is the REMOTE identity — for the local wallet/profile state use `status`.",
  whoamiSchema,
  async () => handleWhoami(),
);

server.tool(
  "list_orgs",
  "List the orgs you are a member of, with each org's id, display name, your role, and membership status.",
  listOrgsSchema,
  async () => handleListOrgs(),
);

server.tool(
  "list_org_members",
  "List the members of an org and their roles. Params: `org_id`.",
  listOrgMembersSchema,
  async (args) => handleListOrgMembers(args),
);

server.tool(
  "add_org_member",
  "Add a member to an org BY WALLET (POST /orgs/v1/:org_id/members). A brand-new wallet is provisioned as a `human` principal. `role` defaults to `developer`. Requires you to hold an active `owner` membership. (Email-first invite is a separate, not-yet-shipped flow.)",
  addOrgMemberSchema,
  async (args) => handleAddOrgMember(args),
);

server.tool(
  "set_org_member_role",
  "Change a member's role (owner > admin > developer > billing > viewer). Requires an active `owner` membership. Demoting the org's only active owner fails with `409 LAST_OWNER`.",
  setOrgMemberRoleSchema,
  async (args) => handleSetOrgMemberRole(args),
);

server.tool(
  "remove_org_member",
  "Remove a member from an org. Requires an active `owner` membership. Removing the org's only active owner fails with `409 LAST_OWNER`.",
  removeOrgMemberSchema,
  async (args) => handleRemoveOrgMember(args),
);

server.tool(
  "create_project_grant",
  "Issue a per-project capability grant to a wallet (for agent/CI principals that aren't broad org members). Params: `project_id`, `wallet`, `capability` (e.g. `deploy`, `functions:write`), optional `policy` / `expires_at`. Requires you to be an owner of the project's org.",
  createProjectGrantSchema,
  async (args) => handleCreateProjectGrant(args),
);

server.tool(
  "revoke_project_grant",
  "Revoke a per-project capability grant by id. Params: `project_id`, `grant_id`. Requires you to be an owner of the project's org.",
  revokeProjectGrantSchema,
  async (args) => handleRevokeProjectGrant(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
