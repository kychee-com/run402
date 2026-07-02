import { LocalError } from "./errors.js";
import type { ReleaseSpec } from "./namespaces/deploy.types.js";

export const RUN402_APP_SCHEMA_ID = "https://run402.com/schemas/run402-app.v1.schema.json" as const;
export const RUN402_APP_MANIFEST_FILENAME = "run402.json" as const;
export const RUN402_RELEASE_MANIFEST_FILENAME = "run402.release.json" as const;
export const RUN402_APP_SPEC_VERSION = 1 as const;
export const RUN402_APP_INSTALL_GRAPH_VERSION = "run402.app_install_graph.v1" as const;
export const RUN402_APP_UP_RESULT_KIND = "run402.up.result" as const;
export const RUN402_APP_UP_RESULT_SCHEMA_VERSION = "run402.up.result.v1" as const;
export const RUN402_APP_UP_RESULT_SCHEMA_URL = "https://run402.com/schemas/run402-up-result.v1.schema.json" as const;

export const RUN402_BINDING_CLASSES = [
  "generated_config_binding",
  "generated_secret_binding",
  "user_secret",
] as const;
export const RUN402_BINDING_SCOPES = [
  "build",
  "runtime",
  "client",
  "verify",
  "template",
] as const;

export interface Run402AppSpec {
  $schema: typeof RUN402_APP_SCHEMA_ID;
  spec_version: typeof RUN402_APP_SPEC_VERSION;
  app: {
    id: string;
    display_name?: string;
    description?: string;
  };
  project: {
    name?: string;
    id?: string;
    origin?: {
      subdomain?: string;
    };
  };
  resources?: {
    mailboxes?: Record<string, Run402AppMailboxSpec>;
    webhooks?: Record<string, Run402AppWebhookSpec>;
  };
  secrets?: Record<string, Run402AppSecretSpec>;
  build?: Run402AppBuildSpec;
  release: Run402AppReleaseSpec;
  lifecycle?: {
    project?: "per_app" | "shared";
    prune?: "approval_required" | "disabled";
  };
  verify?: {
    http?: Run402AppHttpVerifySpec[];
  };
}

export interface Run402AppMailboxSpec {
  slug?: string;
  roles?: ("default_outbound" | "auth_sender")[];
  description?: string;
}

export interface Run402AppWebhookSpec {
  mailbox: string;
  url: string;
  events: string[];
  enabled?: boolean;
  signing?: {
    required?: boolean;
  };
}

export interface Run402AppSecretSpec {
  required?: boolean;
  source_env?: string;
  description?: string;
}

export interface Run402AppBuildSpec {
  mode?: "local" | "remote" | "sandbox";
  commands?: Run402AppBuildCommand[];
}

export interface Run402AppBuildCommand {
  id: string;
  argv?: string[];
  shell?: string;
  cwd?: string;
}

export type Run402AppReleaseSpec = Omit<Partial<ReleaseSpec>, "project"> & {
  project?: never;
};

export interface Run402AppHttpVerifySpec {
  id: string;
  path?: string;
  url?: string;
  expect: {
    status: number;
  };
  retries?: number;
}

export type Run402AppSourceMetadata =
  | { kind: "local"; path: string; commit?: string }
  | { kind: "repo"; repo_url: string; commit?: string };

export interface CompileRun402AppInstallGraphOptions {
  source?: Run402AppSourceMetadata;
  name?: string;
  root_idempotency_key?: string;
}

export type Run402AppInstallNodeStatus = "planned" | "running" | "succeeded" | "blocked" | "failed" | "skipped";
export type Run402AppInstallMutation = "none" | "local" | "remote" | "destructive";
export type Run402AppUpStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed"
  | "partial"
  | "deployed_unverified";
export type Run402AppUpErrorCode =
  | "APP_SPEC_INVALID"
  | "PROJECT_REQUIRED"
  | "PROJECT_CONFLICT"
  | "TIER_REQUIRED"
  | "SPEND_APPROVAL_REQUIRED"
  | "BUILD_APPROVAL_REQUIRED"
  | "BUILD_FAILED"
  | "MISSING_SECRET"
  | "RESOURCE_CONFLICT"
  | "RESOURCE_PRUNE_REQUIRES_APPROVAL"
  | "UNSUPPORTED_RESOURCE_KIND"
  | "RELEASE_APPLY_FAILED"
  | "VERIFY_FAILED"
  | "CONCURRENT_UP_IN_PROGRESS"
  | "APP_INSTALL_STATE_UNAVAILABLE"
  | "REMOTE_BUILD_UNSUPPORTED";
export type Run402BindingClass = typeof RUN402_BINDING_CLASSES[number];
export type Run402BindingScope = typeof RUN402_BINDING_SCOPES[number];

export interface Run402AppUpSpendImpact {
  amount_usd_micros?: number;
  currency?: "USD";
  description?: string;
}

export interface Run402AppUpNextAction {
  type: string;
  code?: Run402AppUpErrorCode;
  message?: string;
  command?: string;
  argv?: string[];
  field_path?: string;
  node_id?: string;
  spend?: Run402AppUpSpendImpact;
  docs_url?: string;
}

export interface Run402AppUpDiagnostic {
  code: Run402AppUpErrorCode;
  message: string;
  severity: "info" | "warning" | "error";
  node_id?: string;
  field_path?: string;
  details?: Record<string, unknown>;
}

export interface Run402AppBinding {
  env: string;
  binding_class: Run402BindingClass;
  scopes: Run402BindingScope[];
  source: string;
  value?: string;
  redacted?: boolean;
}

export interface Run402AppUpApprovalPolicy {
  yes: boolean;
  allow_prune: boolean;
  max_spend_usd: number | null;
  build_mode: "local" | "remote" | "sandbox" | null;
  shell_build_approved: boolean;
}

export interface Run402AppUpStep {
  id: string;
  kind: string;
  status: Run402AppInstallNodeStatus;
  mutation: Run402AppInstallMutation;
  destructive: boolean;
  spend: boolean;
  idempotent: boolean;
  ensure_key?: string;
  input_digest: `sha256:${string}`;
  depends_on: string[];
  diagnostics?: Run402AppUpDiagnostic[];
  next_actions?: Run402AppUpNextAction[];
}

export interface Run402AppUpResourceSummary {
  mailboxes: Record<string, {
    id: string | null;
    address: string | null;
    bindings: Run402AppBinding[];
  }>;
  webhooks: Record<string, {
    id: string | null;
    mailbox: string;
    url: string;
    events: string[];
    enabled: boolean;
  }>;
  bindings: Run402AppBinding[];
  user_secrets: Record<string, {
    required: boolean;
    source_env: string | null;
    satisfied: boolean;
  }>;
}

export interface Run402AppUpResultEnvelope {
  kind: typeof RUN402_APP_UP_RESULT_KIND;
  schema_version: typeof RUN402_APP_UP_RESULT_SCHEMA_VERSION;
  schema_url: typeof RUN402_APP_UP_RESULT_SCHEMA_URL;
  status: Run402AppUpStatus;
  operation_id: string | null;
  install_id: string | null;
  spec_digest: `sha256:${string}`;
  graph_digest: `sha256:${string}`;
  source: Run402AppSourceMetadata | null;
  manifest_path: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  approval_policy: Run402AppUpApprovalPolicy;
  dry_run: boolean;
  project: {
    id: string | null;
    name: string | null;
    public_origin: string | null;
  };
  steps: Run402AppUpStep[];
  resources: Run402AppUpResourceSummary;
  release: {
    operation_id: string | null;
    release_id: string | null;
    spec: Run402AppReleaseSpec;
  };
  verification: {
    http: Array<{
      id: string;
      status: Run402AppInstallNodeStatus;
      path?: string;
      url?: string;
      expected_status: number;
      actual_status?: number | null;
    }>;
  };
  diagnostics: Run402AppUpDiagnostic[];
  next_actions: Run402AppUpNextAction[];
  graph: Run402AppInstallGraph;
}

export interface Run402AppInstallGraphNode {
  id: string;
  kind: string;
  depends_on: string[];
  input_digest: `sha256:${string}`;
  status: Run402AppInstallNodeStatus;
  mutation: Run402AppInstallMutation;
  idempotent: boolean;
  ensure_key?: string;
  destructive: boolean;
  spend: boolean;
  details?: Record<string, unknown>;
}

export interface Run402GeneratedMailboxBindings {
  id: string;
  address: string;
}

export interface Run402AppInstallBindings {
  mailboxes: Record<string, Run402GeneratedMailboxBindings>;
}

export interface Run402AppInstallGraph {
  schema_version: typeof RUN402_APP_INSTALL_GRAPH_VERSION;
  app_id: string;
  source: Run402AppSourceMetadata | null;
  spec_digest: `sha256:${string}`;
  graph_digest: `sha256:${string}`;
  nodes: Run402AppInstallGraphNode[];
  release_spec: Run402AppReleaseSpec;
  bindings: Run402AppInstallBindings;
}

const LOGICAL_RESOURCE_NAME = /^[a-z][a-z0-9_]*$/;
const TEMPLATE_REF = /\$\{([^}]+)\}/g;
const APP_SPEC_ERROR_CONTEXT = "compiling Run402 app manifest";

export async function compileRun402AppInstallGraph(
  spec: Run402AppSpec,
  opts: CompileRun402AppInstallGraphOptions = {},
): Promise<Run402AppInstallGraph> {
  const specDigest = await sha256Canonical(spec);
  const bindings = compileBindings(spec);
  validateReleaseEmailTriggerMailboxRefs(spec.release, appInstallBindingNames(bindings));
  const nodes: Run402AppInstallGraphNode[] = [];

  await addNode(nodes, opts, {
    id: "discover",
    kind: "discover",
    mutation: "none",
    depends_on: [],
    intent: {
      source: opts.source ?? null,
      app_id: spec.app.id,
      spec_digest: specDigest,
    },
  });

  await addNode(nodes, opts, {
    id: "account.ensure",
    kind: "account.ensure",
    mutation: "remote",
    depends_on: ["discover"],
    spend: true,
    intent: { tier: "ready" },
  });

  await addNode(nodes, opts, {
    id: "project.ensure",
    kind: "project.ensure",
    mutation: "remote",
    depends_on: ["account.ensure"],
    intent: {
      name: opts.name ?? spec.project.name ?? null,
      project_id: spec.project.id ?? null,
      app_id: spec.app.id,
    },
  });

  const projectReadyNode = spec.project.origin ? "origin.ensure" : "project.ensure";
  if (spec.project.origin) {
    await addNode(nodes, opts, {
      id: "origin.ensure",
      kind: "origin.ensure",
      mutation: "remote",
      depends_on: ["project.ensure"],
      intent: spec.project.origin,
    });
  }

  const mailboxNames = sortedKeys(spec.resources?.mailboxes);
  for (const name of mailboxNames) {
    assertLogicalResourceName(name);
    await addNode(nodes, opts, {
      id: `mailbox.${name}.ensure`,
      kind: "mailbox.ensure",
      mutation: "remote",
      depends_on: ["project.ensure"],
      intent: {
        logical_name: name,
        bindings: mailboxRuntimeBindings(name),
        ...spec.resources?.mailboxes?.[name],
      },
    });
  }

  const bindingDeps = mailboxNames.length > 0
    ? mailboxNames.map((name) => `mailbox.${name}.ensure`)
    : [projectReadyNode];
  await addNode(nodes, opts, {
    id: "bindings.resolve",
    kind: "bindings.resolve",
    mutation: "none",
    depends_on: bindingDeps,
    intent: bindings,
  });

  const secretNames = sortedKeys(spec.secrets);
  if (secretNames.length > 0) {
    await addNode(nodes, opts, {
      id: "secrets.ensure",
      kind: "secrets.ensure",
      mutation: "remote",
      depends_on: ["project.ensure"],
      intent: Object.fromEntries(secretNames.map((name) => [
        name,
        {
          required: spec.secrets?.[name]?.required ?? false,
          source_env: spec.secrets?.[name]?.source_env ?? name,
        },
      ])),
    });
  }

  const buildMode = spec.build?.mode ?? "local";
  if (spec.build) {
    await addNode(nodes, opts, {
      id: `build.${buildMode}`,
      kind: "build",
      mutation: buildMode === "local" ? "local" : "remote",
      depends_on: [
        "bindings.resolve",
        ...(secretNames.length > 0 ? ["secrets.ensure"] : []),
      ],
      intent: spec.build,
    });
  }

  await addNode(nodes, opts, {
    id: "release.apply",
    kind: "release.apply",
    mutation: "remote",
    depends_on: [
      spec.build ? `build.${buildMode}` : "bindings.resolve",
      ...(secretNames.length > 0 && !spec.build ? ["secrets.ensure"] : []),
    ],
    intent: spec.release,
  });

  const webhookNames = sortedKeys(spec.resources?.webhooks);
  for (const name of webhookNames) {
    assertLogicalResourceName(name);
    const webhook = spec.resources?.webhooks?.[name];
    await addNode(nodes, opts, {
      id: `webhook.${name}.ensure`,
      kind: "webhook.ensure",
      mutation: "remote",
      depends_on: [
        "release.apply",
        `mailbox.${webhook?.mailbox}.ensure`,
      ],
      intent: {
        logical_name: name,
        ...webhook,
      },
    });
  }

  for (const check of spec.verify?.http ?? []) {
    await addNode(nodes, opts, {
      id: `verify.http.${check.id}`,
      kind: "verify.http",
      mutation: "none",
      depends_on: webhookNames.length > 0
        ? webhookNames.map((name) => `webhook.${name}.ensure`)
        : ["release.apply"],
      intent: check,
    });
  }

  const graphDigest = await sha256Canonical(nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    depends_on: node.depends_on,
    input_digest: node.input_digest,
    mutation: node.mutation,
    destructive: node.destructive,
    spend: node.spend,
  })));

  return {
    schema_version: RUN402_APP_INSTALL_GRAPH_VERSION,
    app_id: spec.app.id,
    source: opts.source ?? null,
    spec_digest: specDigest,
    graph_digest: graphDigest,
    nodes,
    release_spec: spec.release,
    bindings,
  };
}

export function generatedMailboxBindings(logicalName: string): Run402GeneratedMailboxBindings {
  assertLogicalResourceName(logicalName);
  const suffix = logicalName.toUpperCase();
  return {
    id: `RUN402_MAILBOX_${suffix}_ID`,
    address: `RUN402_MAILBOX_${suffix}_ADDRESS`,
  };
}

export function mailboxRuntimeBindings(logicalName: string): Run402AppBinding[] {
  const names = generatedMailboxBindings(logicalName);
  return [
    {
      env: names.id,
      binding_class: "generated_config_binding",
      scopes: ["runtime", "template"],
      source: `resources.mailboxes.${logicalName}.id`,
    },
    {
      env: names.address,
      binding_class: "generated_config_binding",
      scopes: ["runtime", "template"],
      source: `resources.mailboxes.${logicalName}.address`,
    },
  ];
}

export function platformMetadataBindings(opts: { publicOriginKnown?: boolean } = {}): Run402AppBinding[] {
  const bindings: Run402AppBinding[] = [
    {
      env: "RUN402_PROJECT_ID",
      binding_class: "generated_config_binding",
      scopes: ["runtime", "verify", "template"],
      source: "project.id",
    },
    {
      env: "RUN402_API_BASE_URL",
      binding_class: "generated_config_binding",
      scopes: ["runtime", "verify", "template"],
      source: "platform.api_base_url",
    },
    {
      env: "RUN402_RELEASE_ID",
      binding_class: "generated_config_binding",
      scopes: ["runtime", "verify", "template"],
      source: "release.id",
    },
    {
      env: "RUN402_DEPLOYMENT_ID",
      binding_class: "generated_config_binding",
      scopes: ["runtime", "verify", "template"],
      source: "deployment.id",
    },
  ];
  if (opts.publicOriginKnown !== false) {
    bindings.push({
      env: "RUN402_PUBLIC_ORIGIN",
      binding_class: "generated_config_binding",
      scopes: ["runtime", "verify", "template"],
      source: "project.public_origin",
    });
  }
  return bindings;
}

export function createRun402AppUpResult(input: {
  graph: Run402AppInstallGraph;
  manifest_path: string;
  status: Run402AppUpStatus;
  started_at: string;
  ended_at?: string;
  dry_run: boolean;
  project_id?: string | null;
  project_name?: string | null;
  public_origin?: string | null;
  approval_policy?: Partial<Run402AppUpApprovalPolicy>;
  operation_id?: string | null;
  install_id?: string | null;
  diagnostics?: Run402AppUpDiagnostic[];
  next_actions?: Run402AppUpNextAction[];
  blocked_node_id?: string;
}): Run402AppUpResultEnvelope {
  const endedAt = input.ended_at ?? new Date().toISOString();
  const started = Date.parse(input.started_at);
  const ended = Date.parse(endedAt);
  const diagnostics = input.diagnostics ?? [];
  const nextActions = input.next_actions ?? [];
  const steps = input.graph.nodes.map((node): Run402AppUpStep => {
    const nodeDiagnostics = diagnostics.filter((diagnostic) => diagnostic.node_id === node.id);
    const nodeNextActions = nextActions.filter((action) => action.node_id === node.id);
    const status = input.blocked_node_id === node.id
      ? "blocked"
      : node.status;
    return {
      id: node.id,
      kind: node.kind,
      status,
      mutation: node.mutation,
      destructive: node.destructive,
      spend: node.spend,
      idempotent: node.idempotent,
      ...(node.ensure_key ? { ensure_key: node.ensure_key } : {}),
      input_digest: node.input_digest,
      depends_on: node.depends_on,
      ...(nodeDiagnostics.length > 0 ? { diagnostics: nodeDiagnostics } : {}),
      ...(nodeNextActions.length > 0 ? { next_actions: nodeNextActions } : {}),
    };
  });
  return {
    kind: RUN402_APP_UP_RESULT_KIND,
    schema_version: RUN402_APP_UP_RESULT_SCHEMA_VERSION,
    schema_url: RUN402_APP_UP_RESULT_SCHEMA_URL,
    status: input.status,
    operation_id: input.operation_id ?? null,
    install_id: input.install_id ?? null,
    spec_digest: input.graph.spec_digest,
    graph_digest: input.graph.graph_digest,
    source: input.graph.source,
    manifest_path: input.manifest_path,
    started_at: input.started_at,
    ended_at: endedAt,
    duration_ms: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    approval_policy: {
      yes: input.approval_policy?.yes ?? false,
      allow_prune: input.approval_policy?.allow_prune ?? false,
      max_spend_usd: input.approval_policy?.max_spend_usd ?? null,
      build_mode: input.approval_policy?.build_mode ?? null,
      shell_build_approved: input.approval_policy?.shell_build_approved ?? false,
    },
    dry_run: input.dry_run,
    project: {
      id: input.project_id ?? null,
      name: input.project_name ?? null,
      public_origin: input.public_origin ?? null,
    },
    steps,
    resources: appResourceSummary(input.graph),
    release: {
      operation_id: null,
      release_id: null,
      spec: input.graph.release_spec,
    },
    verification: {
      http: verificationSummary(input.graph),
    },
    diagnostics,
    next_actions: nextActions,
    graph: input.graph,
  };
}

function compileBindings(spec: Run402AppSpec): Run402AppInstallBindings {
  const mailboxes: Record<string, Run402GeneratedMailboxBindings> = {};
  for (const name of sortedKeys(spec.resources?.mailboxes)) {
    mailboxes[name] = generatedMailboxBindings(name);
  }
  return { mailboxes };
}

function appInstallBindingNames(bindings: Run402AppInstallBindings): Set<string> {
  const names = new Set<string>();
  for (const binding of Object.values(bindings.mailboxes)) {
    names.add(binding.id);
    names.add(binding.address);
  }
  return names;
}

function validateReleaseEmailTriggerMailboxRefs(release: Run402AppReleaseSpec, bindings: Set<string>): void {
  for (const [name, fn] of Object.entries(release.functions?.replace ?? {})) {
    validateFunctionEmailTriggerMailboxRefs(fn, `release.functions.replace.${name}`, bindings);
  }
  for (const [name, fn] of Object.entries(release.functions?.patch?.set ?? {})) {
    validateFunctionEmailTriggerMailboxRefs(fn, `release.functions.patch.set.${name}`, bindings);
  }
}

function validateFunctionEmailTriggerMailboxRefs(fn: unknown, resource: string, bindings: Set<string>): void {
  if (!isPlainRecord(fn) || !Array.isArray(fn.triggers)) return;
  for (let i = 0; i < fn.triggers.length; i++) {
    const trigger = fn.triggers[i];
    if (!isPlainRecord(trigger) || trigger.type !== "email") continue;
    validateTemplateRefsInString(
      typeof trigger.mailbox === "string" ? trigger.mailbox : undefined,
      `${resource}.triggers.${i}.mailbox`,
      bindings,
    );
  }
}

function validateTemplateRefsInString(value: string | undefined, resource: string, allowed: Set<string>): void {
  if (value === undefined) return;
  for (const match of value.matchAll(TEMPLATE_REF)) {
    const ref = match[1];
    if (!ref || !allowed.has(ref)) {
      throw appSpecInvalid(`${resource} has unresolved template reference '${ref ?? ""}'`, {
        field_path: resource,
        reference: ref ?? "",
      });
    }
  }
}

function appResourceSummary(graph: Run402AppInstallGraph): Run402AppUpResourceSummary {
  const mailboxes: Run402AppUpResourceSummary["mailboxes"] = {};
  const webhooks: Run402AppUpResourceSummary["webhooks"] = {};
  const allBindings = platformMetadataBindings();
  for (const name of sortedKeys(graph.bindings.mailboxes)) {
    const bindings = mailboxRuntimeBindings(name);
    mailboxes[name] = {
      id: null,
      address: null,
      bindings,
    };
    allBindings.push(...bindings);
  }
  for (const node of graph.nodes) {
    if (node.kind !== "webhook.ensure" || !isPlainRecord(node.details)) continue;
    const logicalName = String(node.details.logical_name ?? "");
    if (!logicalName) continue;
    webhooks[logicalName] = {
      id: null,
      mailbox: String(node.details.mailbox ?? ""),
      url: String(node.details.url ?? ""),
      events: Array.isArray(node.details.events)
        ? node.details.events.map((event) => String(event))
        : [],
      enabled: node.details.enabled !== false,
    };
  }
  const userSecrets: Run402AppUpResourceSummary["user_secrets"] = {};
  const secretsNode = graph.nodes.find((node) => node.id === "secrets.ensure");
  if (secretsNode && isPlainRecord(secretsNode.details)) {
    for (const name of sortedKeys(secretsNode.details)) {
      const entry = secretsNode.details[name];
      userSecrets[name] = {
        required: isPlainRecord(entry) ? entry.required === true : false,
        source_env: isPlainRecord(entry) && typeof entry.source_env === "string"
          ? entry.source_env
          : null,
        satisfied: false,
      };
    }
  }
  return {
    mailboxes,
    webhooks,
    bindings: allBindings,
    user_secrets: userSecrets,
  };
}

function verificationSummary(graph: Run402AppInstallGraph): Run402AppUpResultEnvelope["verification"]["http"] {
  return graph.nodes
    .filter((node) => node.kind === "verify.http")
    .map((node) => {
      const details = isPlainRecord(node.details) ? node.details : {};
      const expect = isPlainRecord(details.expect) ? details.expect : {};
      return {
        id: String(details.id ?? node.id.replace(/^verify\.http\./, "")),
        status: node.status,
        ...(typeof details.path === "string" ? { path: details.path } : {}),
        ...(typeof details.url === "string" ? { url: details.url } : {}),
        expected_status: typeof expect.status === "number" ? expect.status : 200,
      };
    });
}

async function addNode(
  nodes: Run402AppInstallGraphNode[],
  opts: CompileRun402AppInstallGraphOptions,
  input: {
    id: string;
    kind: string;
    depends_on: string[];
    mutation: Run402AppInstallMutation;
    intent: unknown;
    destructive?: boolean;
    spend?: boolean;
  },
): Promise<void> {
  const inputDigest = await sha256Canonical({
    id: input.id,
    kind: input.kind,
    intent: input.intent,
  });
  const idempotent = input.mutation === "remote";
  nodes.push({
    id: input.id,
    kind: input.kind,
    depends_on: input.depends_on,
    input_digest: inputDigest,
    status: "planned",
    mutation: input.mutation,
    idempotent,
    ...(idempotent ? { ensure_key: ensureKey(opts, input.id, inputDigest) } : {}),
    destructive: input.destructive ?? false,
    spend: input.spend ?? false,
    details: isPlainRecord(input.intent) ? input.intent : { value: input.intent },
  });
}

function ensureKey(opts: CompileRun402AppInstallGraphOptions, nodeId: string, inputDigest: string): string {
  const root = opts.root_idempotency_key ?? opts.name ?? "run402-app-up";
  return `appup:${root}:${nodeId}:${inputDigest.slice("sha256:".length, "sha256:".length + 16)}`;
}

async function sha256Canonical(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalizeJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw appSpecInvalid("canonicalizeJson: unsupported non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  throw appSpecInvalid("canonicalizeJson: unsupported value type");
}

function sortedKeys(value: Record<string, unknown> | undefined): string[] {
  return Object.keys(value ?? {}).sort();
}

function assertLogicalResourceName(value: string): void {
  if (!LOGICAL_RESOURCE_NAME.test(value)) {
    throw appSpecInvalid(`logical resource name must match [a-z][a-z0-9_]*: ${value}`, {
      value,
    });
  }
}

function appSpecInvalid(message: string, details?: Record<string, unknown>): LocalError {
  return new LocalError(message, APP_SPEC_ERROR_CONTEXT, {
    code: "APP_SPEC_INVALID",
    details,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
