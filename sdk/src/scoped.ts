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
import { deprecatePositional } from "./deprecate.js";
import type {
  ExposeManifestValidationInput,
  ExposeManifestValidationResult,
  ListProjectsOptions,
  ListProjectsResult,
  ProjectDetail,
  ProjectInfo,
  ProjectRestOptions,
  ProjectRestResponse,
  QuoteResult,
  RenameProjectResult,
  SchemaReport,
  UsageReport,
  ValidateExposeOptions,
} from "./namespaces/projects.types.js";
import type {
  AppDetails,
  BrowseAppsResult,
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
  AuthSettingsResult,
  AuthSessionResult,
  AuthUserAdminResult,
  CreateAuthUserOptions,
  MagicLinkOptions,
  MagicLinkVerifyResult,
  PasskeyDeleteOptions,
  PasskeyListOptions,
  PasskeyLoginOptions,
  PasskeyLoginVerifyOptions,
  PasskeyOptionsResult,
  PasskeyRecord,
  PasskeyRegistrationOptions,
  PasskeyRegistrationVerifyOptions,
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
  BlobUploadCompleteOptions,
  BlobUploadCompleteResult,
  BlobUploadInitOptions,
  BlobUploadInitResult,
  BlobUploadStatusResult,
  BlobWaitFreshOptions,
  BlobWaitFreshResult,
} from "./namespaces/assets.types.js";
import type {
  ContractCallOptions,
  ContractDeployOptions,
  ContractReadOptions,
  ProvisionSignerOptions,
} from "./namespaces/contracts.js";
import type {
  CustomDomainAddResult,
  CustomDomainListResult,
  CustomDomainRemoveResult,
  CustomDomainStatusResult,
  DomainAddOptions,
} from "./namespaces/domains.js";
import type {
  CreateMailboxResult,
  DeleteMailboxResult,
  EmailDetail,
  EmailSummary,
  ListDeliveriesOptions,
  ListEmailsOptions,
  MailboxInfo,
  MailboxListResult,
  MailboxWebhookSummary,
  MailboxWebhooksResult,
  RawEmailResult,
  RedriveDeliveryResult,
  RegisterWebhookOptions,
  SendEmailOptions,
  SendEmailResult,
  SetMailboxDefaultsOptions,
  SetMailboxDefaultsResult,
  UpdateMailboxOptions,
  UpdateMailboxResult,
  UpdateWebhookOptions,
  WebhookDeliveriesResult,
} from "./namespaces/email.js";
import type {
  DeleteFunctionResult,
  FunctionDeployOptions,
  FunctionDeployResult,
  FunctionInvokeOptions,
  FunctionInvokeResult,
  FunctionListResult,
  FunctionLogsOptions,
  FunctionLogsResult,
  FunctionRebuildBatchResult,
  FunctionRebuildResult,
  FunctionUpdateOptions,
  FunctionUpdateResult,
} from "./namespaces/functions.types.js";
import type {
  ManagedJobLogsOptions,
  ManagedJobLogsResponse,
  ManagedJobPurgeResponse,
  ManagedJobResponse,
  ManagedJobSubmitRequest,
} from "./namespaces/jobs.js";
import type { DeleteSecretResult, SecretListResult, SecretSetOptions } from "./namespaces/secrets.js";
import type {
  CreateGrantInput,
  GrantCreateResult,
  GrantRevokeResult,
} from "./namespaces/grants.types.js";
import type {
  ProjectArchiveCreateOptions,
  ProjectArchiveDownload,
  ProjectArchiveDto,
  ProjectArchiveExportOptions,
  ProjectArchiveExportResult,
  ProjectArchiveWaitOptions,
} from "./namespaces/archives.types.js";
import type {
  DisableInboundResult,
  InboundEnableResult,
  SenderDomainRegisterResult,
  SenderDomainStatusResult,
} from "./namespaces/sender-domain.js";
import type {
  SubdomainClaimInput,
  SubdomainClaimOptions,
  SubdomainClaimResult,
  SubdomainDeleteResult,
  SubdomainSummary,
} from "./namespaces/subdomains.js";
import type {
  ApplyOptions,
  ActiveReleaseInventory,
  DeployEvent,
  DeployEventsResponse,
  ExposeManifest,
  DeployListOptions,
  DeployListResponse,
  DeployOperation,
  DeployResolveResponse,
  DeployResult,
  OperationSnapshot,
  PlanResponse,
  PromoteOptions,
  PromoteResult,
  ReleaseDiffOptions,
  ReleaseInventory,
  ReleaseInventoryOptions,
  ReleaseSpec,
  ReleaseToReleaseDiff,
  ScopedDeployResolveOptions,
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
  sql(sql: string, params?: unknown[]): Promise<unknown> {
    return this.parent.projects.sql(this.projectId, sql, params);
  }
  rest<T = unknown>(table: string, queryOrOptions?: string | ProjectRestOptions): Promise<T> {
    return this.parent.projects.rest<T>(this.projectId, table, queryOrOptions);
  }
  restResponse<T = unknown>(
    table: string,
    queryOrOptions?: string | ProjectRestOptions,
  ): Promise<ProjectRestResponse<T>> {
    return this.parent.projects.restResponse<T>(this.projectId, table, queryOrOptions);
  }
  applyExpose(manifest: ExposeManifest): Promise<unknown> {
    return this.parent.projects.applyExpose(this.projectId, manifest);
  }
  validateExpose(
    manifest: ExposeManifestValidationInput,
    opts: ValidateExposeOptions = {},
  ): Promise<ExposeManifestValidationResult> {
    if (opts.project !== undefined || opts.project_id !== undefined) {
      return this.parent.projects.validateExpose(manifest, opts);
    }
    return this.parent.projects.validateExpose(manifest, { ...opts, project: this.projectId });
  }
  getExpose(): Promise<ExposeManifest> {
    return this.parent.projects.getExpose(this.projectId);
  }
  rename(name: string): Promise<RenameProjectResult> {
    return this.parent.projects.rename(this.projectId, name);
  }
  promoteUser(email: string): Promise<void> {
    return this.parent.projects.promoteUser(this.projectId, email);
  }
  demoteUser(email: string): Promise<void> {
    return this.parent.projects.demoteUser(this.projectId, email);
  }
  get(): Promise<ProjectDetail> {
    return this.parent.projects.get(this.projectId);
  }
  info(): Promise<ProjectInfo> {
    return this.parent.projects.info(this.projectId);
  }
  keys(): Promise<ProjectKeys> {
    return this.parent.projects.keys(this.projectId);
  }
  // Pass-through for non-id-bearing methods.
  list(opts?: ListProjectsOptions): Promise<ListProjectsResult> {
    return this.parent.projects.list(opts);
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

class ScopedGrants {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  create(input: CreateGrantInput): Promise<GrantCreateResult> {
    return this.parent.grants.create(this.projectId, input);
  }
  revoke(grantId: string): Promise<GrantRevokeResult> {
    return this.parent.grants.revoke(this.projectId, grantId);
  }
}

class ScopedArchives {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  create(opts?: ProjectArchiveCreateOptions): Promise<ProjectArchiveDto> {
    return this.parent.archives.create(this.projectId, opts);
  }
  get(archiveId: string): Promise<ProjectArchiveDto> {
    return this.parent.archives.get(this.projectId, archiveId);
  }
  wait(archiveId: string, opts?: ProjectArchiveWaitOptions): Promise<ProjectArchiveDto> {
    return this.parent.archives.wait(this.projectId, archiveId, opts);
  }
  download(archiveId: string): Promise<ProjectArchiveDownload> {
    return this.parent.archives.download(this.projectId, archiveId);
  }
  export(opts?: ProjectArchiveExportOptions): Promise<ProjectArchiveExportResult> {
    return this.parent.archives.export(this.projectId, opts);
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
  createUser(opts: CreateAuthUserOptions): Promise<AuthUserAdminResult> {
    return this.parent.auth.createUser(this.projectId, opts);
  }
  inviteUser(opts: Omit<CreateAuthUserOptions, "sendInvite">): Promise<AuthUserAdminResult> {
    return this.parent.auth.inviteUser(this.projectId, opts);
  }
  setUserPassword(opts: SetPasswordOptions): Promise<void> {
    return this.parent.auth.setUserPassword(this.projectId, opts);
  }
  settings(settings: AuthSettings): Promise<AuthSettingsResult> {
    return this.parent.auth.settings(this.projectId, settings);
  }
  createPasskeyRegistrationOptions(opts: PasskeyRegistrationOptions): Promise<PasskeyOptionsResult> {
    return this.parent.auth.createPasskeyRegistrationOptions(this.projectId, opts);
  }
  verifyPasskeyRegistration(opts: PasskeyRegistrationVerifyOptions): Promise<PasskeyRecord> {
    return this.parent.auth.verifyPasskeyRegistration(this.projectId, opts);
  }
  createPasskeyLoginOptions(opts: PasskeyLoginOptions): Promise<PasskeyOptionsResult> {
    return this.parent.auth.createPasskeyLoginOptions(this.projectId, opts);
  }
  verifyPasskeyLogin(opts: PasskeyLoginVerifyOptions): Promise<AuthSessionResult> {
    return this.parent.auth.verifyPasskeyLogin(this.projectId, opts);
  }
  listPasskeys(opts: PasskeyListOptions): Promise<{ passkeys: PasskeyRecord[] }> {
    return this.parent.auth.listPasskeys(this.projectId, opts);
  }
  deletePasskey(opts: PasskeyDeleteOptions): Promise<void> {
    return this.parent.auth.deletePasskey(this.projectId, opts);
  }
  providers(): Promise<unknown> {
    return this.parent.auth.providers(this.projectId);
  }
  promote(email: string): Promise<void> {
    return this.parent.auth.promote(this.projectId, email);
  }
  demote(email: string): Promise<void> {
    return this.parent.auth.demote(this.projectId, email);
  }
}

class ScopedAssets {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  put(key: string, source: BlobPutSource, opts?: BlobPutOptions): Promise<BlobPutResult> {
    return this.parent.assets.put(this.projectId, key, source, opts);
  }
  diagnoseUrl(url: string): Promise<BlobDiagnoseEnvelope> {
    return this.parent.assets.diagnoseUrl(this.projectId, url);
  }
  waitFresh(opts: BlobWaitFreshOptions): Promise<BlobWaitFreshResult> {
    return this.parent.assets.waitFresh(this.projectId, opts);
  }
  get(key: string): Promise<Response> {
    return this.parent.assets.get(this.projectId, key);
  }
  ls(opts?: BlobLsOptions): Promise<BlobLsResult> {
    return this.parent.assets.ls(this.projectId, opts);
  }
  rm(key: string): Promise<void> {
    return this.parent.assets.rm(this.projectId, key);
  }
  sign(key: string, opts?: BlobSignOptions): Promise<BlobSignResult> {
    return this.parent.assets.sign(this.projectId, key, opts);
  }
  initUploadSession(opts: BlobUploadInitOptions): Promise<BlobUploadInitResult> {
    return this.parent.assets.initUploadSession(this.projectId, opts);
  }
  getUploadSession(uploadId: string): Promise<BlobUploadStatusResult> {
    return this.parent.assets.getUploadSession(this.projectId, uploadId);
  }
  completeUploadSession(
    uploadId: string,
    opts?: BlobUploadCompleteOptions,
    extra?: { contentType?: string },
  ): Promise<BlobUploadCompleteResult> {
    return this.parent.assets.completeUploadSession(this.projectId, uploadId, opts, extra);
  }
}

class ScopedContracts {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  provisionSigner(opts: ProvisionSignerOptions): Promise<unknown> {
    return this.parent.contracts.provisionSigner(this.projectId, opts);
  }
  getSigner(signerId: string): Promise<unknown> {
    return this.parent.contracts.getSigner(this.projectId, signerId);
  }
  listSigners(): Promise<unknown> {
    return this.parent.contracts.listSigners(this.projectId);
  }
  setRecovery(signerId: string, recoveryAddress: string | null): Promise<void> {
    return this.parent.contracts.setRecovery(this.projectId, signerId, recoveryAddress);
  }
  setLowBalanceAlert(signerId: string, thresholdWei: string): Promise<void> {
    return this.parent.contracts.setLowBalanceAlert(this.projectId, signerId, thresholdWei);
  }
  call(opts: ContractCallOptions): Promise<unknown> {
    return this.parent.contracts.call(this.projectId, opts);
  }
  deploy(opts: ContractDeployOptions): Promise<unknown> {
    return this.parent.contracts.deploy(this.projectId, opts);
  }
  callStatus(callId: string): Promise<unknown> {
    return this.parent.contracts.callStatus(this.projectId, callId);
  }
  drain(signerId: string, destinationAddress: string): Promise<unknown> {
    return this.parent.contracts.drain(this.projectId, signerId, destinationAddress);
  }
  deleteSigner(signerId: string): Promise<unknown> {
    return this.parent.contracts.deleteSigner(this.projectId, signerId);
  }
  // `read` is not project-scoped — pass through.
  read(opts: ContractReadOptions): Promise<unknown> {
    return this.parent.contracts.read(opts);
  }
}

/**
 * Callable hero shape for `r.project(id).apply`. The function form is the
 * documented happy path; the attached `plan`/`start`/`resume` sub-methods
 * are advanced primitives for callers building their own plan/upload/commit
 * pipelines. The same object owns release and operation reads, so the public
 * project-scoped lifecycle has one noun: apply. Per design D5 the hero is the
 * only public apply surface — no bare `r.apply`, no `r.deploy.apply`, no
 * `r.assets.apply`.
 */
export interface ScopedApplyHero {
  (
    spec: Omit<ReleaseSpec, "project"> & { project?: string },
    opts?: ApplyOptions,
  ): Promise<DeployResult>;
  plan(
    spec: Omit<ReleaseSpec, "project"> & { project?: string },
    opts?: { idempotencyKey?: string; dryRun?: boolean },
  ): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }>;
  start(
    spec: Omit<ReleaseSpec, "project"> & { project?: string },
    opts?: StartOptions,
  ): Promise<DeployOperation>;
  resume(
    operationId: string,
    opts?: { onEvent?: (event: DeployEvent) => void; project?: string },
  ): Promise<DeployResult>;
  /**
   * Operator pointer-swap: promote an existing release to be the project's
   * current live release without re-running the apply pipeline. v1.58+.
   * See `Deploy.promote` for full semantics + warning surface.
   */
  promote(
    releaseId: string,
    opts?: PromoteOptions,
  ): Promise<PromoteResult>;
  upload(
    plan: PlanResponse,
    opts: {
      project?: string;
      byteReaders: Map<string, ByteReader>;
      onEvent?: (event: DeployEvent) => void;
    },
  ): Promise<void>;
  commit(
    planId: string,
    opts?: {
      onEvent?: (event: DeployEvent) => void;
      idempotencyKey?: string;
      project?: string;
    },
  ): Promise<DeployResult>;
  status(
    operationId: string,
    opts?: { project?: string },
  ): Promise<OperationSnapshot>;
  list(
    opts?: Omit<DeployListOptions, "project"> & { project?: string },
  ): Promise<DeployListResponse>;
  events(
    operationId: string,
    opts?: { project?: string },
  ): Promise<DeployEventsResponse>;
  getRelease(
    releaseId: string,
    opts?: Partial<ReleaseInventoryOptions>,
  ): Promise<ReleaseInventory>;
  getActiveRelease(
    opts?: Partial<ReleaseInventoryOptions>,
  ): Promise<ActiveReleaseInventory>;
  diff(
    opts: Omit<ReleaseDiffOptions, "project"> & { project?: string },
  ): Promise<ReleaseToReleaseDiff>;
  resolve(opts: ScopedDeployResolveOptions): Promise<DeployResolveResponse>;
}

function createScopedApplyHero(parent: Run402, projectId: string): ScopedApplyHero {
  const bindProject = (
    spec: Omit<ReleaseSpec, "project"> & { project?: string },
  ): ReleaseSpec => ({ ...spec, project: spec.project ?? projectId } as ReleaseSpec);
  const hero = ((spec, opts) =>
    parent._applyEngine.apply(bindProject(spec), opts)) as ScopedApplyHero;
  hero.plan = (spec, opts) => parent._applyEngine.plan(bindProject(spec), opts);
  hero.start = (spec, opts) => parent._applyEngine.start(bindProject(spec), opts);
  hero.resume = (operationId, opts = {}) =>
    parent._applyEngine.resume(operationId, {
      ...opts,
      project: opts.project ?? projectId,
    });
  hero.promote = (releaseId, opts = {}) =>
    parent._applyEngine.promote(projectId, releaseId, opts);
  hero.upload = (plan, opts) =>
    parent._applyEngine.upload(plan, {
      ...opts,
      project: opts.project ?? projectId,
    });
  hero.commit = (planId, opts = {}) =>
    parent._applyEngine.commit(planId, {
      ...opts,
      project: opts.project ?? projectId,
    });
  hero.status = (operationId, opts = {}) =>
    parent._applyEngine.status(operationId, {
      ...opts,
      project: opts.project ?? projectId,
    });
  hero.list = (opts = {}) =>
    parent._applyEngine.list({
      project: opts.project ?? projectId,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  hero.events = (operationId, opts = {}) =>
    parent._applyEngine.events(operationId, {
      project: opts.project ?? projectId,
    });
  hero.getRelease = (releaseId, opts = {}) =>
    parent._applyEngine.getRelease({
      project: opts.project ?? projectId,
      releaseId,
      siteLimit: opts.siteLimit,
    });
  hero.getActiveRelease = (opts = {}) =>
    parent._applyEngine.getActiveRelease({
      project: opts.project ?? projectId,
      siteLimit: opts.siteLimit,
    });
  hero.diff = (opts) =>
    parent._applyEngine.diff({
      ...opts,
      project: opts.project ?? projectId,
    });
  hero.resolve = (opts) =>
    parent._applyEngine.resolve({
      ...opts,
      project: opts.project ?? projectId,
    } as Parameters<Run402["_applyEngine"]["resolve"]>[0]);
  return hero;
}

class ScopedDomains {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  add(opts: DomainAddOptions): Promise<CustomDomainAddResult>;
  /** @deprecated Use `add({ domain, subdomainName })`. */
  add(domain: string, subdomainName: string): Promise<CustomDomainAddResult>;
  add(domainOrOpts: string | DomainAddOptions, subdomainName?: string): Promise<CustomDomainAddResult> {
    if (typeof domainOrOpts === "object" && domainOrOpts !== null) {
      return this.parent.domains.add(this.projectId, domainOrOpts);
    }
    deprecatePositional("domains.add", "use add({ domain, subdomainName })");
    return this.parent.domains.add(this.projectId, {
      domain: domainOrOpts,
      subdomainName: subdomainName as string,
    });
  }
  list(): Promise<CustomDomainListResult> {
    return this.parent.domains.list(this.projectId);
  }
  status(domain: string): Promise<CustomDomainStatusResult> {
    return this.parent.domains.status(this.projectId, domain);
  }
  remove(domain: string, opts: { projectId?: string } = {}): Promise<CustomDomainRemoveResult> {
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
  listDeliveries(opts?: ListDeliveriesOptions): Promise<WebhookDeliveriesResult> {
    return this.parent.email.webhooks.listDeliveries(this.projectId, opts);
  }
  redriveDelivery(deliveryId: string): Promise<RedriveDeliveryResult> {
    return this.parent.email.webhooks.redriveDelivery(this.projectId, deliveryId);
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
  listMailboxes(): Promise<MailboxListResult> {
    return this.parent.email.listMailboxes(this.projectId);
  }
  setMailboxDefaults(opts: SetMailboxDefaultsOptions): Promise<SetMailboxDefaultsResult> {
    return this.parent.email.setMailboxDefaults(this.projectId, opts);
  }
  updateMailbox(opts: UpdateMailboxOptions): Promise<UpdateMailboxResult> {
    return this.parent.email.updateMailbox(this.projectId, opts);
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
  delete(name: string): Promise<DeleteFunctionResult> {
    return this.parent.functions.delete(this.projectId, name);
  }
  update(name: string, opts: FunctionUpdateOptions): Promise<FunctionUpdateResult> {
    return this.parent.functions.update(this.projectId, name, opts);
  }
  rebuild(name: string): Promise<FunctionRebuildResult> {
    return this.parent.functions.rebuild(this.projectId, name);
  }
  rebuildAll(): Promise<FunctionRebuildBatchResult> {
    return this.parent.functions.rebuildAll(this.projectId);
  }
}

class ScopedSecrets {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  set(key: string, opts: SecretSetOptions): Promise<void>;
  /** @deprecated Use `set(key, { value })`. */
  set(key: string, value: string): Promise<void>;
  set(key: string, valueOrOpts: string | SecretSetOptions): Promise<void> {
    if (typeof valueOrOpts === "object" && valueOrOpts !== null) {
      return this.parent.secrets.set(this.projectId, key, valueOrOpts);
    }
    deprecatePositional("secrets.set", "use set(key, { value })");
    return this.parent.secrets.set(this.projectId, key, { value: valueOrOpts });
  }
  list(): Promise<SecretListResult> {
    return this.parent.secrets.list(this.projectId);
  }
  delete(key: string): Promise<DeleteSecretResult> {
    return this.parent.secrets.delete(this.projectId, key);
  }
}

class ScopedJobs {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  submit(request: ManagedJobSubmitRequest): Promise<ManagedJobResponse> {
    return this.parent.jobs.submit(this.projectId, request);
  }
  get(jobId: string): Promise<ManagedJobResponse> {
    return this.parent.jobs.get(this.projectId, jobId);
  }
  logs(jobId: string, opts?: ManagedJobLogsOptions): Promise<ManagedJobLogsResponse> {
    return this.parent.jobs.logs(this.projectId, jobId, opts);
  }
  cancel(jobId: string): Promise<ManagedJobResponse> {
    return this.parent.jobs.cancel(this.projectId, jobId);
  }
  purge(): Promise<ManagedJobPurgeResponse> {
    return this.parent.jobs.purge(this.projectId);
  }
  downloadArtifact(jobId: string, filename: string): Promise<Response> {
    return this.parent.jobs.downloadArtifact(this.projectId, jobId, filename);
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
  disableInbound(domain: string): Promise<DisableInboundResult> {
    return this.parent.senderDomain.disableInbound(this.projectId, domain);
  }
}

class ScopedSubdomains {
  constructor(private readonly parent: Run402, private readonly projectId: string) {}

  list(): Promise<SubdomainSummary[]> {
    return this.parent.subdomains.list(this.projectId);
  }
  claim(input: SubdomainClaimInput): Promise<SubdomainClaimResult>;
  /** @deprecated Use `claim({ name, deploymentId, ...opts })`. */
  claim(name: string, deploymentId: string, opts?: SubdomainClaimOptions): Promise<SubdomainClaimResult>;
  claim(
    nameOrInput: string | SubdomainClaimInput,
    deploymentId?: string,
    opts: SubdomainClaimOptions = {},
  ): Promise<SubdomainClaimResult> {
    if (typeof nameOrInput === "object" && nameOrInput !== null) {
      return this.parent.subdomains.claim({
        ...nameOrInput,
        projectId: nameOrInput.projectId ?? this.projectId,
      });
    }
    deprecatePositional("subdomains.claim", "use claim({ name, deploymentId, ...opts })");
    return this.parent.subdomains.claim({
      name: nameOrInput,
      deploymentId: deploymentId as string,
      projectId: opts.projectId ?? this.projectId,
    });
  }
  delete(name: string, opts: SubdomainClaimOptions = {}): Promise<SubdomainDeleteResult> {
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
  readonly assets: ScopedAssets;
  readonly contracts: ScopedContracts;
  /**
   * Hero apply surface. Per design D5 / unified-apply: `r.project(id).apply(spec)`
   * is the documented happy path for both release-only and mixed apply.
   * Callable directly, with `.plan(spec)` / `.start(spec)` / `.resume(opId)`
   * sub-methods for advanced plan-upload-commit pipelines.
   */
  readonly apply: ScopedApplyHero;
  /**
   * No `deploy` namespace: `apply` owns both writes and lifecycle reads.
   * Use `p.apply(...)`, `p.apply.plan(...)`, `p.apply.status(...)`,
   * `p.apply.getRelease(...)`, and `p.apply.resolve(...)`.
   */
  readonly domains: ScopedDomains;
  readonly email: ScopedEmail;
  readonly functions: ScopedFunctions;
  readonly jobs: ScopedJobs;
  readonly secrets: ScopedSecrets;
  readonly senderDomain: ScopedSenderDomain;
  readonly subdomains: ScopedSubdomains;
  /** Per-project capability grants (agent/CI principals), project-id pre-bound. */
  readonly grants: ScopedGrants;
  readonly archives: ScopedArchives;

  constructor(parent: Run402, _client: Client, projectId: string) {
    this.projectId = projectId;
    this.projects = new ScopedProjects(parent, projectId);
    this.apps = new ScopedApps(parent, projectId);
    this.ai = new ScopedAi(parent, projectId);
    this.auth = new ScopedAuth(parent, projectId);
    this.assets = new ScopedAssets(parent, projectId);
    this.contracts = new ScopedContracts(parent, projectId);
    this.apply = createScopedApplyHero(parent, projectId);
    this.domains = new ScopedDomains(parent, projectId);
    this.email = new ScopedEmail(parent, projectId);
    this.functions = new ScopedFunctions(parent, projectId);
    this.jobs = new ScopedJobs(parent, projectId);
    this.secrets = new ScopedSecrets(parent, projectId);
    this.senderDomain = new ScopedSenderDomain(parent, projectId);
    this.subdomains = new ScopedSubdomains(parent, projectId);
    this.grants = new ScopedGrants(parent, projectId);
    this.archives = new ScopedArchives(parent, projectId);
  }
}
