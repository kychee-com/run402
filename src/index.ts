#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Existing tools
import { provisionSchema, handleProvision } from "./tools/provision.js";
import { runSqlSchema, handleRunSql } from "./tools/run-sql.js";
import { restQuerySchema, handleRestQuery } from "./tools/rest-query.js";
import { uploadFileSchema, handleUploadFile } from "./tools/upload-file.js";
import { setTierSchema, handleSetTier } from "./tools/set-tier.js";
import { deploySiteSchema, handleDeploySite } from "./tools/deploy-site.js";
import { claimSubdomainSchema, handleClaimSubdomain } from "./tools/subdomain.js";
import { deleteSubdomainSchema, handleDeleteSubdomain } from "./tools/subdomain.js";
import { deployFunctionSchema, handleDeployFunction } from "./tools/deploy-function.js";
import { invokeFunctionSchema, handleInvokeFunction } from "./tools/invoke-function.js";
import { getFunctionLogsSchema, handleGetFunctionLogs } from "./tools/get-function-logs.js";
import { setSecretSchema, handleSetSecret } from "./tools/set-secret.js";

// New tools — database
import { setupRlsSchema, handleSetupRls } from "./tools/setup-rls.js";
import { getSchemaSchema, handleGetSchema } from "./tools/get-schema.js";
import { getUsageSchema, handleGetUsage } from "./tools/get-usage.js";

// New tools — bundle & marketplace
import { bundleDeploySchema, handleBundleDeploy } from "./tools/bundle-deploy.js";
import { browseAppsSchema, handleBrowseApps } from "./tools/browse-apps.js";
import { forkAppSchema, handleForkApp } from "./tools/fork-app.js";
import { getQuoteSchema, handleGetQuote } from "./tools/get-quote.js";
import { publishAppSchema, handlePublishApp } from "./tools/publish-app.js";
import { listVersionsSchema, handleListVersions } from "./tools/list-versions.js";

// New tools — storage CRUD
import { downloadFileSchema, handleDownloadFile } from "./tools/download-file.js";
import { deleteFileSchema, handleDeleteFile } from "./tools/delete-file.js";
import { listFilesSchema, handleListFiles } from "./tools/list-files.js";

// New tools — functions & secrets CRUD
import { listFunctionsSchema, handleListFunctions } from "./tools/list-functions.js";
import { deleteFunctionSchema, handleDeleteFunction } from "./tools/delete-function.js";
import { listSecretsSchema, handleListSecrets } from "./tools/list-secrets.js";
import { deleteSecretSchema, handleDeleteSecret } from "./tools/delete-secret.js";

// New tools — subdomains & projects
import { listSubdomainsSchema, handleListSubdomains } from "./tools/list-subdomains.js";
import { archiveProjectSchema, handleArchiveProject } from "./tools/archive-project.js";
import { pinProjectSchema, handlePinProject } from "./tools/pin-project.js";

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
import { getMailboxSchema, handleGetMailbox } from "./tools/get-mailbox.js";

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
  "Apply row-level security to tables. Templates: user_owns_rows (users access own rows only), public_read (anyone reads, authenticated writes), public_read_write (open access).",
  setupRlsSchema,
  async (args) => handleSetupRls(args),
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
  "upload_file",
  "Upload text content to project storage. Returns the storage key and size.",
  uploadFileSchema,
  async (args) => handleUploadFile(args),
);

server.tool(
  "download_file",
  "Download a file from project storage. Returns the file content.",
  downloadFileSchema,
  async (args) => handleDownloadFile(args),
);

server.tool(
  "delete_file",
  "Delete a file from project storage.",
  deleteFileSchema,
  async (args) => handleDeleteFile(args),
);

server.tool(
  "list_files",
  "List files in a storage bucket. Shows file names, sizes, and last modified dates.",
  listFilesSchema,
  async (args) => handleListFiles(args),
);

// ─── Functions tools ────────────────────────────────────────────────────────

server.tool(
  "deploy_function",
  "Deploy a serverless function (Node 22) to a project. Handler signature: export default async (req: Request) => Response. Pre-bundled packages: stripe, openai, @anthropic-ai/sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse.",
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
  "Deploy a static site (HTML/CSS/JS). Files are uploaded to S3 and served via CloudFront at a unique URL. Free with active tier.",
  deploySiteSchema,
  async (args) => handleDeploySite(args),
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
  "archive_project",
  "Archive a project and remove it from the local key store. This action cannot be undone.",
  archiveProjectSchema,
  async (args) => handleArchiveProject(args),
);

// ─── Admin tools ─────────────────────────────────────────────────────────────

server.tool(
  "pin_project",
  "Pin a project so it is not garbage-collected or expired. Requires admin access.",
  pinProjectSchema,
  async (args) => handlePinProject(args),
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
  "Send a template-based email from the project's mailbox. Templates: project_invite, magic_link, notification. Single recipient only.",
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
  "get_mailbox",
  "Get the project's mailbox info (ID, address, slug). Use to check if a mailbox exists.",
  getMailboxSchema,
  async (args) => handleGetMailbox(args),
);

// ─── Messaging & agent contact tools ───────────────────────────────────────

server.tool(
  "send_message",
  "Send a message to the Run402 developers. Free with allowance auth.",
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

const transport = new StdioServerTransport();
await server.connect(transport);
