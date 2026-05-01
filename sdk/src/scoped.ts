/**
 * Project-scoped sub-client. `ScopedRun402` wraps the SDK's project-id-bearing
 * namespaces with the id pre-bound, so callers don't have to thread the id
 * through every call.
 *
 * Construct via `r.project(id?)` — see the JSDoc on
 * {@link Run402.project} for the resolution rule (explicit arg vs. fallback to
 * the credential provider's active-project state).
 *
 * Methods that take an options object containing `project_id`/`project`
 * (deploy, subdomains, domains) honour a caller-supplied value over the scoped
 * id, so a scoped client can still address a different project ad-hoc.
 *
 * Methods that don't take a project id (e.g. `projects.list(wallet)`,
 * `projects.getQuote()`, `projects.active()`, `apps.browse(tags?)`,
 * `ai.generateImage(opts)`, etc.) pass through unchanged.
 */
import type { Client } from "./kernel.js";
import type { Run402 } from "./index.js";
import type { ProjectKeys } from "./credentials.js";
import type {
  ListProjectsResult,
  PinResult,
  ProjectInfo,
  QuoteResult,
  SchemaReport,
  UsageReport,
} from "./namespaces/projects.types.js";
import type {
  AppDetails,
  BrowseAppsResult,
  BundleDeployOptions,
  BundleDeployResult,
  ForkAppOptions,
  ForkAppResult,
  ListVersionsResult,
  PublishAppOptions,
  PublishedVersion,
  UpdateVersionOptions,
} from "./namespaces/apps.js";
import type {
  AiUsageResult,
  GenerateImageOptions,
  GenerateImageResult,
  ModerateResult,
  TranslateOptions,
  TranslateResult,
} from "./namespaces/ai.js";
import type {
  AuthSettings,
  MagicLinkOptions,
  MagicLinkVerifyResult,
  SetPasswordOptions,
} from "./namespaces/auth.js";
import type {
  BlobDiagnoseEnvelope,
  BlobLsOptions,
  BlobLsResult,
  BlobPutOptions,
  BlobPutResult,
  BlobPutSource,
  BlobSignOptions,
  BlobSignResult,
  BlobWaitFreshOptions,
  BlobWaitFreshResult,
} from "./namespaces/blobs.types.js";
import type {
  ContractCallOptions,
  ContractReadOptions,
  ProvisionWalletOptions,
} from "./namespaces/contracts.js";
import type {
  CustomDomainAddResult,
  CustomDomainListResult,
  CustomDomainStatusResult,
} from "./namespaces/domains.js";
import type {
  CreateMailboxResult,
  DeleteMailboxResult,
  EmailDetail,
  EmailSummary,
  ListEmailsOptions,
  MailboxInfo,
  MailboxWebhookSummary,
  MailboxWebhooksResult,
  RawEmailResult,
  RegisterWebhookOptions,
  SendEmailOptions,
  SendEmailResult,
  UpdateWebhookOptions,
} from "./namespaces/email.js";
import type {
  FunctionDeployOptions,
  FunctionDeployResult,
  FunctionInvokeOptions,
  FunctionInvokeResult,
  FunctionListResult,
  FunctionLogsOptions,
  FunctionLogsResult,
  FunctionUpdateOptions,
  FunctionUpdateResult,
} from "./namespaces/functions.types.js";
import type { SecretListResult } from "./namespaces/secrets.js";
import type {
  InboundEnableResult,
  SenderDomainRegisterResult,
  SenderDomainStatusResult,
} from "./namespaces/sender-domain.js";
import type {
  SubdomainClaimOptions,
  SubdomainClaimResult,
  SubdomainSummary,
} from "./namespaces/subdomains.js";
import type {
  ApplyOptions,
  DeployEvent,
  DeployListResponse,
  DeployOperation,
  DeployResult,
  OperationSnapshot,
  PlanResponse,
  ReleaseSpec,
  StartOptions,
} from "./namespaces/deploy.types.js";
import type { ByteReader } from "./namespaces/deploy.js";

class ScopedProjects {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  delete(): Promise<void> {
    return this.parent.projects.delete(this.projectId);
  }
  getUsage(): Promise<UsageReport> {
    return this.parent.projects.getUsage(this.projectId);
  }
  getSchema(): Promise<SchemaReport> {
    return this.parent.projects.getSchema(this.projectId);
  }
  pin(): Promise<PinResult> {
    return this.parent.projects.pin(this.projectId);
  }
  info(): Promise<ProjectInfo> {
    return this.parent.projects.info(this.projectId);
  }
  keys(): Promise<ProjectKeys> {
    return this.parent.projects.keys(this.projectId);
  }
  // Pass-through for non-id-bearing methods.
  list(wallet?: string): Promise<ListProjectsResult> {
    return this.parent.projects.list(wallet);
  }
  getQuote(): Promise<QuoteResult> {
    return this.parent.projects.getQuote();
  }
  active(): Promise<string | null> {
    return this.parent.projects.active();
  }
}

class ScopedApps {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  bundleDeploy(opts?: BundleDeployOptions): Promise<BundleDeployResult> {
    return this.parent.apps.bundleDeploy(this.projectId, opts);
  }
  publish(opts?: PublishAppOptions): Promise<PublishedVersion> {
    return this.parent.apps.publish(this.projectId, opts);
  }
  listVersions(): Promise<ListVersionsResult> {
    return this.parent.apps.listVersions(this.projectId);
  }
  updateVersion(versionId: string, opts: UpdateVersionOptions): Promise<void> {
    return this.parent.apps.updateVersion(this.projectId, versionId, opts);
  }
  deleteVersion(versionId: string): Promise<void> {
    return this.parent.apps.deleteVersion(this.projectId, versionId);
  }
  // Pass-through.
  browse(tags?: string[]): Promise<BrowseAppsResult> {
    return this.parent.apps.browse(tags);
  }
  fork(opts: ForkAppOptions): Promise<ForkAppResult> {
    return this.parent.apps.fork(opts);
  }
  getApp(versionId: string): Promise<AppDetails> {
    return this.parent.apps.getApp(versionId);
  }
}

class ScopedAi {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  translate(opts: TranslateOptions): Promise<TranslateResult> {
    return this.parent.ai.translate(this.projectId, opts);
  }
  moderate(text: string): Promise<ModerateResult> {
    return this.parent.ai.moderate(this.projectId, text);
  }
  usage(): Promise<AiUsageResult> {
    return this.parent.ai.usage(this.projectId);
  }
  // Pass-through.
  generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    return this.parent.ai.generateImage(opts);
  }
}

class ScopedAuth {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  requestMagicLink(opts: MagicLinkOptions): Promise<void> {
    return this.parent.auth.requestMagicLink(this.projectId, opts);
  }
  verifyMagicLink(token: string): Promise<MagicLinkVerifyResult> {
    return this.parent.auth.verifyMagicLink(this.projectId, token);
  }
  setUserPassword(opts: SetPasswordOptions): Promise<void> {
    return this.parent.auth.setUserPassword(this.projectId, opts);
  }
  settings(settings: AuthSettings): Promise<void> {
    return this.parent.auth.settings(this.projectId, settings);
  }
  promote(email: string): Promise<void> {
    return this.parent.auth.promote(this.projectId, email);
  }
  demote(email: string): Promise<void> {
    return this.parent.auth.demote(this.projectId, email);
  }
}

class ScopedBlobs {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  put(key: string, source: BlobPutSource, opts?: BlobPutOptions): Promise<BlobPutResult> {
    return this.parent.blobs.put(this.projectId, key, source, opts);
  }
  diagnoseUrl(url: string): Promise<BlobDiagnoseEnvelope> {
    return this.parent.blobs.diagnoseUrl(this.projectId, url);
  }
  waitFresh(opts: BlobWaitFreshOptions): Promise<BlobWaitFreshResult> {
    return this.parent.blobs.waitFresh(this.projectId, opts);
  }
  get(key: string): Promise<Response> {
    return this.parent.blobs.get(this.projectId, key);
  }
  ls(opts?: BlobLsOptions): Promise<BlobLsResult> {
    return this.parent.blobs.ls(this.projectId, opts);
  }
  rm(key: string): Promise<void> {
    return this.parent.blobs.rm(this.projectId, key);
  }
  sign(key: string, opts?: BlobSignOptions): Promise<BlobSignResult> {
    return this.parent.blobs.sign(this.projectId, key, opts);
  }
}

class ScopedContracts {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  provisionWallet(opts: ProvisionWalletOptions): Promise<unknown> {
    return this.parent.contracts.provisionWallet(this.projectId, opts);
  }
  getWallet(walletId: string): Promise<unknown> {
    return this.parent.contracts.getWallet(this.projectId, walletId);
  }
  listWallets(): Promise<unknown> {
    return this.parent.contracts.listWallets(this.projectId);
  }
  setRecovery(walletId: string, recoveryAddress: string | null): Promise<void> {
    return this.parent.contracts.setRecovery(this.projectId, walletId, recoveryAddress);
  }
  setLowBalanceAlert(walletId: string, thresholdWei: string): Promise<void> {
    return this.parent.contracts.setLowBalanceAlert(this.projectId, walletId, thresholdWei);
  }
  call(opts: ContractCallOptions): Promise<unknown> {
    return this.parent.contracts.call(this.projectId, opts);
  }
  callStatus(callId: string): Promise<unknown> {
    return this.parent.contracts.callStatus(this.projectId, callId);
  }
  drain(walletId: string, destinationAddress: string): Promise<unknown> {
    return this.parent.contracts.drain(this.projectId, walletId, destinationAddress);
  }
  deleteWallet(walletId: string): Promise<unknown> {
    return this.parent.contracts.deleteWallet(this.projectId, walletId);
  }
  // `read` is not project-scoped — pass through.
  read(opts: ContractReadOptions): Promise<unknown> {
    return this.parent.contracts.read(opts);
  }
}

class ScopedDeploy {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  apply(spec: Omit<ReleaseSpec, "project"> & { project?: string }, opts?: ApplyOptions): Promise<DeployResult> {
    return this.parent.deploy.apply(this.bindProject(spec), opts);
  }
  start(spec: Omit<ReleaseSpec, "project"> & { project?: string }, opts?: StartOptions): Promise<DeployOperation> {
    return this.parent.deploy.start(this.bindProject(spec), opts);
  }
  plan(
    spec: Omit<ReleaseSpec, "project"> & { project?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
    return this.parent.deploy.plan(this.bindProject(spec), opts);
  }
  upload(
    plan: PlanResponse,
    opts: {
      project?: string;
      byteReaders: Map<string, ByteReader>;
      onEvent?: (event: DeployEvent) => void;
    },
  ): Promise<void> {
    return this.parent.deploy.upload(plan, {
      ...opts,
      project: opts.project ?? this.projectId,
    });
  }
  commit(
    planId: string,
    opts: {
      onEvent?: (event: DeployEvent) => void;
      idempotencyKey?: string;
      project?: string;
    } = {},
  ): Promise<DeployResult> {
    return this.parent.deploy.commit(planId, {
      ...opts,
      project: opts.project ?? this.projectId,
    });
  }
  resume(
    operationId: string,
    opts: { onEvent?: (event: DeployEvent) => void; project?: string } = {},
  ): Promise<DeployResult> {
    return this.parent.deploy.resume(operationId, {
      ...opts,
      project: opts.project ?? this.projectId,
    });
  }
  status(
    operationId: string,
    opts: { project?: string } = {},
  ): Promise<OperationSnapshot> {
    return this.parent.deploy.status(operationId, {
      ...opts,
      project: opts.project ?? this.projectId,
    });
  }
  list(opts: { project?: string; limit?: number } = {}): Promise<DeployListResponse> {
    return this.parent.deploy.list({
      project: opts.project ?? this.projectId,
      limit: opts.limit,
    });
  }
  events(operationId: string, opts: { project?: string } = {}) {
    return this.parent.deploy.events(operationId, {
      project: opts.project ?? this.projectId,
    });
  }
  // Pass-through (not project-scoped).
  getRelease(releaseId: string): Promise<unknown> {
    return this.parent.deploy.getRelease(releaseId);
  }
  diff(opts: { from: string; to: string }): Promise<unknown> {
    return this.parent.deploy.diff(opts);
  }

  private bindProject(spec: Omit<ReleaseSpec, "project"> & { project?: string }): ReleaseSpec {
    return { ...spec, project: spec.project ?? this.projectId } as ReleaseSpec;
  }
}

class ScopedDomains {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  add(domain: string, subdomainName: string): Promise<CustomDomainAddResult> {
    return this.parent.domains.add(this.projectId, domain, subdomainName);
  }
  list(): Promise<CustomDomainListResult> {
    return this.parent.domains.list(this.projectId);
  }
  status(domain: string): Promise<CustomDomainStatusResult> {
    return this.parent.domains.status(this.projectId, domain);
  }
  remove(domain: string, opts: { projectId?: string } = {}): Promise<void> {
    return this.parent.domains.remove(domain, { projectId: opts.projectId ?? this.projectId });
  }
}

class ScopedEmailWebhooks {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  register(opts: RegisterWebhookOptions): Promise<MailboxWebhookSummary> {
    return this.parent.email.webhooks.register(this.projectId, opts);
  }
  list(): Promise<MailboxWebhooksResult> {
    return this.parent.email.webhooks.list(this.projectId);
  }
  get(webhookId: string): Promise<MailboxWebhookSummary> {
    return this.parent.email.webhooks.get(this.projectId, webhookId);
  }
  update(webhookId: string, opts: UpdateWebhookOptions): Promise<MailboxWebhookSummary> {
    return this.parent.email.webhooks.update(this.projectId, webhookId, opts);
  }
  delete(webhookId: string): Promise<void> {
    return this.parent.email.webhooks.delete(this.projectId, webhookId);
  }
}

class ScopedEmail {
  readonly webhooks: ScopedEmailWebhooks;

  constructor(private readonly parent: Run402, private readonly projectId: string) {
    this.webhooks = new ScopedEmailWebhooks(parent, projectId);
  }

  createMailbox(slug: string): Promise<CreateMailboxResult> {
    return this.parent.email.createMailbox(this.projectId, slug);
  }
  send(opts: SendEmailOptions): Promise<SendEmailResult> {
    return this.parent.email.send(this.projectId, opts);
  }
  list(opts?: ListEmailsOptions): Promise<EmailSummary[]> {
    return this.parent.email.list(this.projectId, opts);
  }
  get(messageId: string): Promise<EmailDetail> {
    return this.parent.email.get(this.projectId, messageId);
  }
  getRaw(messageId: string): Promise<RawEmailResult> {
    return this.parent.email.getRaw(this.projectId, messageId);
  }
  getMailbox(): Promise<MailboxInfo> {
    return this.parent.email.getMailbox(this.projectId);
  }
  deleteMailbox(mailboxId?: string): Promise<DeleteMailboxResult> {
    return this.parent.email.deleteMailbox(this.projectId, mailboxId);
  }
}

class ScopedFunctions {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  deploy(opts: FunctionDeployOptions): Promise<FunctionDeployResult> {
    return this.parent.functions.deploy(this.projectId, opts);
  }
  invoke(name: string, opts?: FunctionInvokeOptions): Promise<FunctionInvokeResult> {
    return this.parent.functions.invoke(this.projectId, name, opts);
  }
  logs(name: string, opts?: FunctionLogsOptions): Promise<FunctionLogsResult> {
    return this.parent.functions.logs(this.projectId, name, opts);
  }
  list(): Promise<FunctionListResult> {
    return this.parent.functions.list(this.projectId);
  }
  delete(name: string): Promise<void> {
    return this.parent.functions.delete(this.projectId, name);
  }
  update(name: string, opts: FunctionUpdateOptions): Promise<FunctionUpdateResult> {
    return this.parent.functions.update(this.projectId, name, opts);
  }
}

class ScopedSecrets {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  set(key: string, value: string): Promise<void> {
    return this.parent.secrets.set(this.projectId, key, value);
  }
  list(): Promise<SecretListResult> {
    return this.parent.secrets.list(this.projectId);
  }
  delete(key: string): Promise<void> {
    return this.parent.secrets.delete(this.projectId, key);
  }
}

class ScopedSenderDomain {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  register(domain: string): Promise<SenderDomainRegisterResult> {
    return this.parent.senderDomain.register(this.projectId, domain);
  }
  status(): Promise<SenderDomainStatusResult> {
    return this.parent.senderDomain.status(this.projectId);
  }
  remove(): Promise<void> {
    return this.parent.senderDomain.remove(this.projectId);
  }
  enableInbound(domain: string): Promise<InboundEnableResult> {
    return this.parent.senderDomain.enableInbound(this.projectId, domain);
  }
  disableInbound(domain: string): Promise<void> {
    return this.parent.senderDomain.disableInbound(this.projectId, domain);
  }
}

class ScopedSubdomains {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  list(): Promise<SubdomainSummary[]> {
    return this.parent.subdomains.list(this.projectId);
  }
  claim(name: string, deploymentId: string, opts: SubdomainClaimOptions = {}): Promise<SubdomainClaimResult> {
    return this.parent.subdomains.claim(name, deploymentId, {
      ...opts,
      projectId: opts.projectId ?? this.projectId,
    });
  }
  delete(name: string, opts: SubdomainClaimOptions = {}): Promise<void> {
    return this.parent.subdomains.delete(name, {
      ...opts,
      projectId: opts.projectId ?? this.projectId,
    });
  }
}

export class ScopedRun402 {
  /** Resolved project id this client is bound to. Read-only. */
  readonly projectId: string;

  readonly projects: ScopedProjects;
  readonly apps: ScopedApps;
  readonly ai: ScopedAi;
  readonly auth: ScopedAuth;
  readonly blobs: ScopedBlobs;
  readonly contracts: ScopedContracts;
  readonly deploy: ScopedDeploy;
  readonly domains: ScopedDomains;
  readonly email: ScopedEmail;
  readonly functions: ScopedFunctions;
  readonly secrets: ScopedSecrets;
  readonly senderDomain: ScopedSenderDomain;
  readonly subdomains: ScopedSubdomains;

  constructor(parent: Run402, _client: Client, projectId: string) {
    this.projectId = projectId;
    this.projects = new ScopedProjects(parent, projectId);
    this.apps = new ScopedApps(parent, projectId);
    this.ai = new ScopedAi(parent, projectId);
    this.auth = new ScopedAuth(parent, projectId);
    this.blobs = new ScopedBlobs(parent, projectId);
    this.contracts = new ScopedContracts(parent, projectId);
    this.deploy = new ScopedDeploy(parent, projectId);
    this.domains = new ScopedDomains(parent, projectId);
    this.email = new ScopedEmail(parent, projectId);
    this.functions = new ScopedFunctions(parent, projectId);
    this.secrets = new ScopedSecrets(parent, projectId);
    this.senderDomain = new ScopedSenderDomain(parent, projectId);
    this.subdomains = new ScopedSubdomains(parent, projectId);
  }
}
