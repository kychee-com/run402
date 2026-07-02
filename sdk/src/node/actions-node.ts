import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  Run402ActionApproval,
  Run402ActionInput,
  Run402ActionMutation,
  Run402ActionResult,
  Run402ActionRunOptions,
  Run402Actions,
  Run402ActionStep,
  Run402ActionStepState,
  Run402ProjectsProvisionActionInput,
  Run402TierSetActionInput,
  Run402UpActionInput,
  Run402UpResult,
} from "../actions.js";
import { Run402Action } from "../actions.js";
import {
  RUN402_APP_MANIFEST_FILENAME,
  compileRun402AppInstallGraph,
  createRun402AppUpResult,
  type Run402AppInstallGraph,
  type Run402AppMailboxSpec,
  type Run402AppReleaseSpec,
  type Run402AppSourceMetadata,
  type Run402AppSpec,
  type Run402AppUpResultEnvelope,
  type Run402AppUpDiagnostic,
  type Run402AppUpNextAction,
} from "../app-up.js";
import type { Run402ExecutionMode, Run402ReviewedPlanRequirement } from "../config.js";
import { LocalError } from "../errors.js";
import type { Run402 } from "../index.js";
import type { DeployEvent, PlanResponse, ReleaseSpec } from "../namespaces/deploy.types.js";
import type { ProvisionResult } from "../namespaces/projects.types.js";
import type { TierName, TierSetResult } from "../namespaces/tier.js";
import { loadDeployManifest, normalizeDeployManifest } from "./deploy-manifest.js";

export type NodeActionTargetKind = "cloud" | "core" | "unknown";

export interface NodeActionsOptions {
  targetKind?: NodeActionTargetKind;
  cwd?: string;
}

interface WorkspaceProjectLink {
  schema_version: "run402.workspace-project.v1";
  project_id: string;
  name?: string;
  target?: {
    kind?: NodeActionTargetKind;
    api_base?: string;
  };
  created_at: string;
  updated_at?: string;
}

interface DiscoveredManifest {
  manifestKind: "app" | "release";
  manifestPath: string;
  releaseSpec: ReleaseSpec | null;
  appGraph?: Run402AppInstallGraph;
  appSpec?: Run402AppSpec;
  source?: Run402AppSourceMetadata;
  idempotencyKey?: string;
  manifestProjectId?: string;
}

interface ResolveProjectResult {
  projectId: string;
  source: "explicit" | "workspace_link" | "manifest" | "created" | "active";
  link?: WorkspaceProjectLink | null;
  linkPath: string;
  shouldWriteLink: boolean;
}

const DEFAULT_BOOTSTRAP_TIER: TierName = "prototype";
const MANIFEST_CANDIDATES = [
  RUN402_APP_MANIFEST_FILENAME,
  "run402.deploy.json",
  "app.json",
];
const EXECUTABLE_MANIFEST_CANDIDATES = [
  "run402.deploy.ts",
  "run402.deploy.mts",
  "run402.deploy.cts",
  "run402.deploy.js",
  "run402.deploy.mjs",
  "run402.deploy.cjs",
];
const TIER_RANK: Record<TierName, number> = {
  prototype: 1,
  hobby: 2,
  team: 3,
};
const execFileAsync = promisify(execFile);

interface ResolvedUpSource {
  workspaceDir: string;
  metadata: Run402AppSourceMetadata;
  cleanupDir?: string;
}

interface AppMailboxState {
  id: string;
  slug: string;
  address: string;
  managed_address?: string;
}

interface AppWebhookState {
  id: string;
  mailbox: string;
  url: string;
  events: string[];
  created: boolean;
}

interface AppResourceState {
  mailboxes: Record<string, AppMailboxState>;
  webhooks: Record<string, AppWebhookState>;
  env: Record<string, string>;
}

/**
 * Node implementation of the action runner. The public CLI should treat this
 * as the orchestration kernel and stay a flag parser / renderer.
 */
export class NodeActions implements Run402Actions {
  constructor(
    private readonly sdk: Run402,
    private readonly opts: NodeActionsOptions = {},
  ) {}

  async run(
    input: Run402ProjectsProvisionActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402ActionResult<ProvisionResult>>;
  async run(
    input: Run402TierSetActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402ActionResult<TierSetResult>>;
  async run(
    input: Run402UpActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402ActionResult<Run402UpResult>>;
  async run(
    input: Run402ActionInput,
    opts: Run402ActionRunOptions = {},
  ): Promise<Run402ActionResult> {
    const run = new ActionRun(input, opts, this.#targetKind());
    try {
      switch (input.type) {
        case Run402Action.ProjectsProvision:
          return await this.#runProjectsProvision(input, run);
        case Run402Action.TierSet:
          return await this.#runTierSet(input, run);
        case Run402Action.Up:
          return await this.#runUp(input, run);
        default:
          assertNever(input);
      }
    } catch (err) {
      run.failLast(err);
      if (err instanceof LocalError) throw err;
      throw withActionDetails(
        new LocalError(
          err instanceof Error ? err.message : String(err),
          "running Run402 action",
          {
            cause: err,
            code: "RUN402_ACTION_FAILED",
            details: { action: input.type, steps: run.steps },
          },
        ),
        run,
      );
    }
  }

  async up(
    input: Omit<Run402UpActionInput, "type"> = {},
    opts?: Run402ActionRunOptions,
  ): Promise<Run402ActionResult<Run402UpResult>> {
    return this.run({ type: Run402Action.Up, ...input }, opts);
  }

  #targetKind(): NodeActionTargetKind {
    return this.opts.targetKind ?? "unknown";
  }

  async #runProjectsProvision(
    input: Run402ProjectsProvisionActionInput,
    run: ActionRun,
  ): Promise<Run402ActionResult<ProvisionResult>> {
    if (this.#targetKind() === "core") {
      throw run.error(
        "Project provisioning through the Cloud gateway is unavailable for a Run402 Core target.",
        "RUN402_CLOUD_ACTION_UNAVAILABLE",
        { action: input.type, target: this.#targetKind() },
      );
    }
    const tier = input.tier ?? DEFAULT_BOOTSTRAP_TIER;
    if (run.autoPrerequisites) {
      await this.#ensureCloudTier(run, tier);
    }
    const idempotencyKey = input.idempotencyKey ?? run.rootIdempotencyKey;
    const step = run.addStep({
      action: Run402Action.ProjectsProvision,
      description: "Provision Run402 project",
      mutation: true,
      auto: false,
      details: {
        tier,
        name: input.name ?? null,
        org_id: input.orgId ?? null,
        idempotency_key: idempotencyKey ?? null,
      },
    });
    await run.approve(step, ["projects.provision"], "Provision a new Run402 Cloud project.");
    if (run.dryRun) {
      run.setState(step, "planned");
      return run.result({} as ProvisionResult);
    }
    run.setState(step, "running");
    const result = await this.sdk.projects.provision({
      tier,
      name: input.name,
      orgId: input.orgId,
      idempotencyKey,
    });
    run.setState(step, "succeeded", { project_id: result.project_id });
    return run.result(result);
  }

  async #runTierSet(
    input: Run402TierSetActionInput,
    run: ActionRun,
  ): Promise<Run402ActionResult<TierSetResult>> {
    if (this.#targetKind() === "core") {
      throw run.error(
        "Tier subscriptions are a Run402 Cloud capability and are skipped on Run402 Core targets.",
        "RUN402_CLOUD_ACTION_UNAVAILABLE",
        { action: input.type, target: this.#targetKind() },
      );
    }
    if (run.autoPrerequisites) {
      await this.#ensureAllowance(run);
    }
    const idempotencyKey = input.idempotencyKey ?? run.rootIdempotencyKey;
    const step = run.addStep({
      action: Run402Action.TierSet,
      description: `Set Run402 tier to ${input.tier}`,
      mutation: true,
      auto: false,
      details: { tier: input.tier, idempotency_key: idempotencyKey ?? null },
    });
    await run.approve(step, ["tier.set"], `Subscribe, renew, or upgrade the ${input.tier} tier.`);
    if (run.dryRun) {
      run.setState(step, "planned");
      return run.result({} as TierSetResult);
    }
    run.setState(step, "running");
    const result = await this.sdk.tier.set(input.tier, idempotencyKey ? { idempotencyKey } : {});
    run.setState(step, "succeeded", { tier: result.tier, action: result.action });
    return run.result(result);
  }

  async #runUp(
    input: Run402UpActionInput,
    run: ActionRun,
  ): Promise<Run402ActionResult<Run402UpResult>> {
    if (input.source && input.dir) {
      throw run.error(
        "Pass either an app source positional/repo URL or --dir, not both.",
        "RUN402_SOURCE_CONFLICT",
        { source: input.source, dir: input.dir },
      );
    }
    const startedAt = new Date().toISOString();
    const source = await this.#resolveUpSource(input, run);
    const workspaceDir = source.workspaceDir;
    const manifest = await this.#discoverAndValidateManifest(input, workspaceDir, source.metadata, run);

    if (manifest.manifestKind === "app") {
      const block = this.#firstAppUpBlock(input, manifest, run);
      const appResult = this.#planAppUpResult(input, manifest, run, {
        startedAt,
        status: block ? "blocked" : "planned",
        dryRun: run.dryRun || run.executionMode === "check" || run.executionMode === "printSpec",
        projectId: input.projectId ?? (run.dryRun ? "prj_planned" : null),
        diagnostics: block?.diagnostics,
        nextActions: block?.nextActions,
        blockedNodeId: block?.nodeId,
      });
      if (run.executionMode === "check" || run.executionMode === "printSpec" || run.dryRun) {
        return run.result({
          project_id: input.projectId ?? "prj_planned",
          manifest_path: manifest.manifestPath,
          app_graph: manifest.appGraph,
          app_result: appResult,
        });
      }
      if (block) {
        return run.result({
          project_id: input.projectId ?? "prj_planned",
          manifest_path: manifest.manifestPath,
          app_graph: manifest.appGraph,
          app_result: appResult,
        });
      }
      return this.#applyAppManifest(input, manifest, workspaceDir, run, startedAt);
    }

    if (run.executionMode === "check" || run.executionMode === "printSpec") {
      if (!manifest.releaseSpec) {
        throw run.error("Internal error: release manifest did not produce a ReleaseSpec.", "RUN402_ACTION_INTERNAL");
      }
      return run.result({
        project_id: manifest.releaseSpec.project,
        manifest_path: manifest.manifestPath,
        ...(run.executionMode === "printSpec" ? { spec: manifest.releaseSpec } : {}),
      });
    }

    if (run.executionMode === "plan") {
      run.skipStep({
        action: Run402Action.TierSet,
        description: "Skip recursive tier bootstrap for reviewed-plan mode",
        mutation: false,
        auto: true,
        details: { mode: "plan" },
      });
    } else if (this.#targetKind() !== "core") {
      await this.#ensureCloudTier(run, input.tier ?? DEFAULT_BOOTSTRAP_TIER);
    } else {
      run.skipStep({
        action: Run402Action.TierSet,
        description: "Skip Cloud allowance and tier prerequisites for Run402 Core",
        mutation: false,
        auto: true,
        details: { target: this.#targetKind() },
      });
    }

    const resolved = await this.#resolveProject(input, manifest, workspaceDir, run);
    const normalized = await loadDeployManifest(manifest.manifestPath, {
      project: resolved.projectId,
    });
    if (!hasDeployableContent(normalized.spec)) {
      throw run.error(
        "Deploy manifest contains no deployable sections.",
        "MANIFEST_EMPTY",
        { manifest_path: manifest.manifestPath },
      );
    }
    const releaseSpec = normalized.spec;
    if (resolved.shouldWriteLink && run.executionMode !== "plan") {
      await this.#writeWorkspaceProjectLink(
        resolved.linkPath,
        {
          schema_version: "run402.workspace-project.v1",
          project_id: resolved.projectId,
          ...(input.name ? { name: input.name } : {}),
          target: { kind: this.#targetKind() },
          created_at: resolved.link?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        resolved.link,
        run,
      );
    }

    const deployStep = run.addStep({
      action: "deploy.apply",
      description: run.executionMode === "plan" ? "Create reviewed deploy plan" : "Apply deploy manifest",
      mutation: run.executionMode !== "plan",
      auto: false,
      details: {
        project_id: resolved.projectId,
        manifest_path: manifest.manifestPath,
      },
    });
    if (run.dryRun) {
      run.setState(deployStep, "planned");
      return run.result({
        project_id: resolved.projectId,
        manifest_path: manifest.manifestPath,
        ...(resolved.shouldWriteLink ? { workspace_link_path: resolved.linkPath } : {}),
      });
    }

    run.setState(deployStep, "running");
    await this.#assertLocalProjectKeys(resolved.projectId, run);
    const scoped = await this.sdk.project(resolved.projectId);
    const explicitDeployIdempotencyKey = input.idempotencyKey ?? normalized.idempotencyKey ?? manifest.idempotencyKey;
    if (run.executionMode === "plan") {
      const planned = await scoped.apply.plan(releaseSpec, {
        mode: "reviewedPlan",
        idempotencyKey: explicitDeployIdempotencyKey,
      });
      const plan = withUpReviewedPlanNextAction(planned.plan, manifest.manifestPath);
      run.setState(deployStep, "succeeded", {
        plan_id: plan.plan_id,
        plan_fingerprint: plan.plan_fingerprint ?? null,
        plan_expires_at: plan.plan_expires_at ?? null,
      });
      return run.result({
        project_id: resolved.projectId,
        manifest_path: manifest.manifestPath,
        plan,
      });
    }
    const requiredPlan = reviewedPlanRequirement(run.executionMode);
    const deploy = await scoped.apply(releaseSpec, {
      idempotencyKey: explicitDeployIdempotencyKey,
      allowWarnings: input.allowWarnings,
      allowWarningCodes: input.allowWarningCodes,
      ...(requiredPlan ? { requiredPlan } : {}),
      target: this.#targetKind() === "core" ? "core" : "cloud",
      onEvent: (event: DeployEvent) => {
        run.options.onEvent?.({
          type: "action.step",
          action: Run402Action.Up,
          step: {
            ...deployStep,
            details: { ...deployStep.details, deploy_event: event.type },
          },
        });
      },
    });
    run.setState(deployStep, "succeeded", {
      release_id: deploy.release_id,
      operation_id: deploy.operation_id,
    });
    return run.result({
      project_id: resolved.projectId,
      manifest_path: manifest.manifestPath,
      ...(resolved.shouldWriteLink ? { workspace_link_path: resolved.linkPath } : {}),
      deploy,
    });
  }

  async #discoverAndValidateManifest(
    input: Run402UpActionInput,
    workspaceDir: string,
    source: Run402AppSourceMetadata,
    run: ActionRun,
  ): Promise<DiscoveredManifest> {
    const step = run.addStep({
      action: "deploy.discover",
      description: "Discover and validate deploy manifest",
      mutation: false,
      auto: true,
      details: { dir: workspaceDir, manifest: input.manifest ?? null },
    });
    run.setState(step, "running");
    const manifestPath = input.manifest
      ? resolveMaybe(workspaceDir, input.manifest)
      : await findManifest(workspaceDir);
    if (!manifestPath) {
      const executablePath = input.manifest ? null : await findExecutableManifest(workspaceDir);
      if (executablePath) {
        throw run.error(
          "Executable deploy configs are trusted code and must be passed explicitly with --manifest.",
          "EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST",
          {
            dir: workspaceDir,
            manifest_path: executablePath,
            next_actions: [{
              type: "retry",
              command: `run402 up --manifest ${shellArg(shortPath(executablePath))} --check`,
              argv: ["run402", "up", "--manifest", executablePath, "--check"],
            }],
          },
        );
      }
      throw run.error(
        "No deploy manifest found. Add run402.deploy.json or app.json, or pass --manifest for executable configs.",
        "UP_MANIFEST_REQUIRED",
        { dir: workspaceDir, candidates: MANIFEST_CANDIDATES, executable_candidates: EXECUTABLE_MANIFEST_CANDIDATES },
      );
    }

    if (basename(manifestPath) === RUN402_APP_MANIFEST_FILENAME) {
      const loadedAppSpec = await loadRun402AppManifest(manifestPath);
      const appSpec = input.buildMode
        ? {
            ...loadedAppSpec,
            build: {
              ...(loadedAppSpec.build ?? {}),
              mode: input.buildMode,
            },
          }
        : loadedAppSpec;
      const appGraph = await compileRun402AppInstallGraph(appSpec, {
        source,
        ...(input.name ? { name: input.name } : {}),
        ...(input.idempotencyKey ?? run.rootIdempotencyKey
          ? { root_idempotency_key: input.idempotencyKey ?? run.rootIdempotencyKey }
          : {}),
      });
      run.setState(step, "succeeded", {
        manifest_kind: "app",
        manifest_path: manifestPath,
        app_id: appSpec.app.id,
        graph_digest: appGraph.graph_digest,
      });
      return {
        manifestKind: "app",
        manifestPath,
        releaseSpec: null,
        appGraph,
        appSpec,
        source,
      };
    }
    const loaded = await loadDeployManifest(manifestPath, {
      ...(input.projectId
        ? { project: input.projectId }
        : { defaultProject: "prj_up_preflight_placeholder" }),
    });
    if (!hasDeployableContent(loaded.spec)) {
      throw run.error(
        "Deploy manifest contains no deployable sections.",
        "MANIFEST_EMPTY",
        { manifest_path: manifestPath },
      );
    }
    run.setState(step, "succeeded", {
      manifest_path: manifestPath,
      project_id: loaded.spec.project,
      idempotency_key: loaded.idempotencyKey ?? null,
    });
    return {
      manifestKind: "release",
      manifestPath,
      releaseSpec: loaded.spec,
      idempotencyKey: loaded.idempotencyKey,
      manifestProjectId: loaded.spec.project === "prj_up_preflight_placeholder"
        ? undefined
        : loaded.spec.project,
    };
  }

  async #resolveUpSource(input: Run402UpActionInput, run: ActionRun): Promise<ResolvedUpSource> {
    const baseDir = resolvePath(this.opts.cwd ?? process.cwd());
    const rawSource = input.source ?? input.dir ?? ".";
    const step = run.addStep({
      action: "app.source.resolve",
      description: "Resolve app source",
      mutation: false,
      auto: true,
      details: { source: rawSource },
    });
    run.setState(step, "running");

    if (isRepositoryUrl(rawSource)) {
      const root = await mkdtemp(join(tmpdir(), "run402-app-source-"));
      const checkout = join(root, "repo");
      try {
        await execFileAsync("git", ["clone", "--depth", "1", rawSource, checkout], {
          maxBuffer: 1024 * 1024 * 8,
        });
        const commit = await gitCommit(checkout);
        run.setState(step, "succeeded", {
          kind: "repo",
          repo_url: rawSource,
          commit: commit ?? null,
          checkout,
        });
        return {
          workspaceDir: checkout,
          metadata: {
            kind: "repo",
            repo_url: rawSource,
            ...(commit ? { commit } : {}),
          },
          cleanupDir: root,
        };
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw run.error(
          `Failed to resolve repository source ${rawSource}.`,
          "RUN402_SOURCE_RESOLVE_FAILED",
          { source: rawSource, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    const workspaceDir = resolveMaybe(baseDir, rawSource);
    const stat = await lstat(workspaceDir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw run.error(
        "App source must be an existing directory or repository URL.",
        "RUN402_SOURCE_INVALID",
        { source: rawSource, resolved_path: workspaceDir },
      );
    }
    const commit = await gitCommit(workspaceDir);
    run.setState(step, "succeeded", {
      kind: "local",
      path: workspaceDir,
      commit: commit ?? null,
    });
    return {
      workspaceDir,
      metadata: {
        kind: "local",
        path: workspaceDir,
        ...(commit ? { commit } : {}),
      },
    };
  }

  #planAppUpResult(
    input: Run402UpActionInput,
    manifest: DiscoveredManifest,
    run: ActionRun,
    opts: {
      startedAt: string;
      status: "planned" | "blocked";
      dryRun: boolean;
      projectId?: string | null;
      diagnostics?: Run402AppUpDiagnostic[];
      nextActions?: Run402AppUpNextAction[];
      blockedNodeId?: string;
    },
  ) {
    if (!manifest.appGraph) {
      throw run.error("Internal error: app manifest did not produce an install graph.", "RUN402_ACTION_INTERNAL");
    }
    return createRun402AppUpResult({
      graph: manifest.appGraph,
      manifest_path: manifest.manifestPath,
      status: opts.status,
      started_at: opts.startedAt,
      dry_run: opts.dryRun,
      project_id: opts.projectId,
      project_name: input.name ?? manifest.appSpec?.project.name ?? null,
      public_origin: appPublicOrigin(input, manifest.appSpec),
      approval_policy: {
        yes: run.approval === "yes",
        allow_prune: input.allowPrune === true,
        max_spend_usd: input.maxSpendUsd ?? null,
        build_mode: input.buildMode ?? manifest.appSpec?.build?.mode ?? null,
        shell_build_approved: input.allowShellBuild === true,
      },
      diagnostics: opts.diagnostics,
      next_actions: opts.nextActions,
      blocked_node_id: opts.blockedNodeId,
    });
  }

  #blockedAppUpResult(
    input: Run402UpActionInput,
    manifest: DiscoveredManifest,
    run: ActionRun,
    startedAt: string,
  ) {
    const block = this.#firstAppUpBlock(input, manifest, run);
    if (!block) {
      throw run.error("Internal error: app manifest was marked blocked without a blocking condition.", "RUN402_ACTION_INTERNAL");
    }
    return this.#planAppUpResult(input, manifest, run, {
      startedAt,
      status: "blocked",
      dryRun: false,
      projectId: input.projectId ?? null,
      diagnostics: block.diagnostics,
      nextActions: block.nextActions,
      blockedNodeId: block.nodeId,
    });
  }

  #firstAppUpBlock(
    input: Run402UpActionInput,
    manifest: DiscoveredManifest,
    run: ActionRun,
  ): { nodeId: string; diagnostics: Run402AppUpDiagnostic[]; nextActions: Run402AppUpNextAction[] } | null {
    const nameBlock = missingRequiredName(input, manifest);
    if (nameBlock) return nameBlock;

    const missingSecrets = missingRequiredSecrets(manifest.appSpec);
    if (missingSecrets.length > 0) {
      return {
        nodeId: "secrets.ensure",
        diagnostics: missingSecrets.map((secret) => ({
          code: "MISSING_SECRET",
          severity: "error",
          node_id: "secrets.ensure",
          field_path: `secrets.${secret.name}`,
          message: [
            `Required user secret ${secret.name} is missing from approved env source ${secret.sourceEnv}.`,
            secret.description ? `Usage: ${secret.description}` : "",
          ].filter(Boolean).join(" "),
          details: {
            source_env: secret.sourceEnv,
            ...(secret.description ? { usage: secret.description } : {}),
          },
        })),
        nextActions: missingSecrets.map((secret) => ({
          type: "set_user_secret",
          code: "MISSING_SECRET",
          node_id: "secrets.ensure",
          field_path: `secrets.${secret.name}`,
          message: [
            `Provide ${secret.sourceEnv} in the environment before retrying.`,
            secret.description ? `Usage: ${secret.description}` : "",
          ].filter(Boolean).join(" "),
          command: `${secret.sourceEnv}="<value>" run402 up --name <name> --yes`,
          argv: ["run402", "secrets", "set", "<project_id>", secret.name, "--env", secret.sourceEnv],
        })),
      };
    }

    if (run.executionMode !== "check" && run.executionMode !== "printSpec" && !run.dryRun) {
      const spendBlock = spendApprovalBlock(input, run);
      if (spendBlock) return spendBlock;
    }

    const buildBlock = appBuildBlock(input, manifest);
    if (buildBlock) return buildBlock;

    return null;
  }

  async #applyAppManifest(
    input: Run402UpActionInput,
    manifest: DiscoveredManifest,
    workspaceDir: string,
    run: ActionRun,
    startedAt: string,
  ): Promise<Run402ActionResult<Run402UpResult>> {
    if (!manifest.appSpec || !manifest.appGraph) {
      throw run.error("Internal error: app manifest did not produce an install graph.", "RUN402_ACTION_INTERNAL");
    }
    const block = this.#firstAppUpBlock(input, manifest, run);
    if (block) {
      const blocked = this.#planAppUpResult(input, manifest, run, {
        startedAt,
        status: "blocked",
        dryRun: false,
        projectId: input.projectId ?? null,
        diagnostics: block.diagnostics,
        nextActions: block.nextActions,
        blockedNodeId: block.nodeId,
      });
      return run.result({
        project_id: input.projectId ?? "prj_planned",
        manifest_path: manifest.manifestPath,
        app_graph: manifest.appGraph,
        app_result: blocked,
      });
    }
    if (this.#targetKind() === "core") {
      const blocked = this.#planAppUpResult(input, manifest, run, {
        startedAt,
        status: "blocked",
        dryRun: false,
        projectId: input.projectId ?? null,
        diagnostics: [{
          code: "UNSUPPORTED_RESOURCE_KIND",
          severity: "error",
          node_id: "project.ensure",
          message: "App-aware up currently targets Run402 Cloud because it provisions Cloud projects, mailboxes, secrets, and managed subdomains.",
        }],
        nextActions: [{
          type: "choose_cloud_target",
          code: "UNSUPPORTED_RESOURCE_KIND",
          node_id: "project.ensure",
          message: "Select the Run402 Cloud target, then retry.",
          argv: ["run402", "init", "--api-base", "https://api.run402.com"],
        }],
        blockedNodeId: "project.ensure",
      });
      return run.result({
        project_id: input.projectId ?? "prj_planned",
        manifest_path: manifest.manifestPath,
        app_graph: manifest.appGraph,
        app_result: blocked,
      });
    }

    await this.#ensureCloudTier(run, input.tier ?? DEFAULT_BOOTSTRAP_TIER);
    const resolved = await this.#resolveProject(input, manifest, workspaceDir, run);
    await this.#recordAppInstallState({
      projectId: resolved.projectId,
      manifest,
      status: "applying",
      run,
    });
    if (resolved.shouldWriteLink && run.executionMode !== "plan") {
      await this.#writeWorkspaceProjectLink(
        resolved.linkPath,
        {
          schema_version: "run402.workspace-project.v1",
          project_id: resolved.projectId,
          ...(input.name ? { name: input.name } : {}),
          target: { kind: this.#targetKind() },
          created_at: resolved.link?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        resolved.link,
        run,
      );
    }

    try {
      const projectKeys = await this.sdk.projects.keys(resolved.projectId);
      const publicOrigin = appPublicOrigin(input, manifest.appSpec) ?? projectKeys.site_url ?? null;
      const resources = await this.#ensureAppMailboxes(resolved.projectId, manifest.appSpec, run);
      const env = {
        ...this.#generatedAppEnv(resolved.projectId, projectKeys, publicOrigin, resources),
        ...this.#userSecretEnv(manifest.appSpec),
      };
      resources.env = env;
      await this.#ensureAppSecrets(resolved.projectId, manifest.appSpec, env, run);
      await this.#runAppBuild(workspaceDir, manifest.appSpec, env, run);

      const releaseInput = materializeTemplates(manifest.appSpec.release, {
        ...env,
        "input.name": input.name ?? manifest.appSpec.project.name ?? "",
      }) as Run402AppReleaseSpec;
      const normalized = await normalizeDeployManifest(releaseInput, {
        project: resolved.projectId,
        baseDir: dirname(manifest.manifestPath),
      });
      if (!hasDeployableContent(normalized.spec)) {
        throw run.error(
          "App release contains no deployable sections.",
          "MANIFEST_EMPTY",
          { manifest_path: manifest.manifestPath },
        );
      }

      const deployStep = run.addStep({
        action: "deploy.apply",
        description: "Apply app release",
        mutation: true,
        auto: false,
        details: {
          project_id: resolved.projectId,
          manifest_path: manifest.manifestPath,
        },
      });
      run.setState(deployStep, "running");
      const scoped = await this.sdk.project(resolved.projectId);
      const deploy = await scoped.apply(normalized.spec, {
        idempotencyKey: input.idempotencyKey ?? normalized.idempotencyKey,
        allowWarnings: input.allowWarnings,
        allowWarningCodes: input.allowWarningCodes,
        target: "cloud",
        onEvent: (event: DeployEvent) => {
          run.options.onEvent?.({
            type: "action.step",
            action: Run402Action.Up,
            step: {
              ...deployStep,
              details: { ...deployStep.details, deploy_event: event.type },
            },
          });
        },
      });
      run.setState(deployStep, "succeeded", {
        release_id: deploy.release_id,
        operation_id: deploy.operation_id,
      });

      const webhooks = await this.#ensureAppWebhooks(resolved.projectId, manifest.appSpec, resources, run);
      resources.webhooks = webhooks;
      const verification = await this.#verifyAppHttp(manifest.appSpec, publicOrigin, run);
      markAppGraphNodes(manifest.appGraph, verification.ok ? "succeeded" : "failed");
      const appResult = createRun402AppUpResult({
        graph: manifest.appGraph,
        manifest_path: manifest.manifestPath,
        status: verification.ok ? "succeeded" : "deployed_unverified",
        started_at: startedAt,
        dry_run: false,
        project_id: resolved.projectId,
        project_name: input.name ?? manifest.appSpec.project.name ?? null,
        public_origin: publicOrigin,
        operation_id: deploy.operation_id ?? null,
        diagnostics: verification.diagnostics,
        approval_policy: {
          yes: run.approval === "yes",
          allow_prune: input.allowPrune === true,
          max_spend_usd: input.maxSpendUsd ?? null,
          build_mode: input.buildMode ?? manifest.appSpec.build?.mode ?? null,
          shell_build_approved: input.allowShellBuild === true,
        },
      });
      applyResourceStateToAppResult(appResult, resources);
      appResult.release.operation_id = deploy.operation_id ?? null;
      appResult.release.release_id = deploy.release_id ?? null;
      appResult.release.spec = normalized.manifest as Run402AppReleaseSpec;
      for (const check of appResult.verification.http) {
        const actual = verification.results.get(check.id);
        if (actual !== undefined) {
          check.actual_status = actual;
          check.status = actual === check.expected_status ? "succeeded" : "failed";
        }
      }
      await this.#recordAppInstallState({
        projectId: resolved.projectId,
        manifest,
        status: verification.ok ? "active" : "failed",
        run,
        resources,
        lastOperationId: deploy.operation_id ?? null,
        error: verification.ok ? null : { code: "VERIFY_FAILED", diagnostics: verification.diagnostics },
      });

      return run.result({
        project_id: resolved.projectId,
        manifest_path: manifest.manifestPath,
        ...(resolved.shouldWriteLink ? { workspace_link_path: resolved.linkPath } : {}),
        app_graph: manifest.appGraph,
        deploy,
        app_result: appResult,
      });
    } catch (err) {
      await this.#recordAppInstallState({
        projectId: resolved.projectId,
        manifest,
        status: "failed",
        run,
        error: actionErrorDetails(err),
      });
      throw err;
    }
  }

  async #recordAppInstallState(input: {
    projectId: string;
    manifest: DiscoveredManifest;
    status: "applying" | "active" | "failed";
    run: ActionRun;
    resources?: AppResourceState;
    lastOperationId?: string | null;
    error?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!input.manifest.appSpec || !input.manifest.appGraph) return;
    const step = input.run.addStep({
      action: "app.install",
      description: input.status === "applying"
        ? "Record app install state"
        : "Record app install result",
      mutation: true,
      auto: true,
      details: {
        project_id: input.projectId,
        app_key: input.manifest.appSpec.app.id,
        status: input.status,
      },
    });
    input.run.setState(step, "running");
    try {
      await this.sdk.apps.upsertInstallState({
        project_id: input.projectId,
        app_key: input.manifest.appSpec.app.id,
        status: input.status,
        manifest_digest: `sha256:${sha256Hex(stableJson(input.manifest.appSpec))}`,
        graph_digest: input.manifest.appGraph.graph_digest,
        source: input.manifest.source as Record<string, unknown> | undefined,
        manifest: input.manifest.appSpec as unknown as Record<string, unknown>,
        resources: input.resources
          ? {
              mailboxes: input.resources.mailboxes,
              webhooks: input.resources.webhooks,
            }
          : {},
        bindings: input.resources
          ? { env: Object.keys(input.resources.env).sort() }
          : {},
        last_operation_id: input.lastOperationId ?? null,
        error: input.error ?? null,
      });
      input.run.setState(step, "succeeded");
    } catch (err) {
      input.run.setState(step, "skipped", {
        reason: "app_install_state_unavailable",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #ensureAppMailboxes(
    projectId: string,
    spec: Run402AppSpec,
    run: ActionRun,
  ): Promise<AppResourceState> {
    const state: AppResourceState = { mailboxes: {}, webhooks: {}, env: {} };
    const entries = Object.entries(spec.resources?.mailboxes ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return state;

    const step = run.addStep({
      action: "app.mailbox.ensure",
      description: "Ensure app mailboxes",
      mutation: true,
      auto: true,
      details: { project_id: projectId, count: entries.length },
    });
    await run.approve(step, ["app.mailbox.ensure"], "Create or reuse app mailboxes.");
    run.setState(step, "running");

    let envelope = await this.sdk.email.listMailboxes(projectId);
    for (const [logicalName, mailboxSpec] of entries) {
      const slug = appMailboxSlug(logicalName, mailboxSpec);
      let mailbox = envelope.mailboxes.find((candidate: { slug?: string }) => candidate.slug === slug);
      if (!mailbox) {
        mailbox = await this.sdk.email.createMailbox(projectId, slug);
        envelope = await this.sdk.email.listMailboxes(projectId);
      }
      state.mailboxes[logicalName] = {
        id: mailbox.mailbox_id,
        slug: mailbox.slug,
        address: mailbox.address,
        ...(mailbox.managed_address ? { managed_address: mailbox.managed_address } : {}),
      };
    }

    const defaults: { default_outbound_mailbox_id?: string; auth_sender_mailbox_id?: string } = {};
    for (const [logicalName, mailboxSpec] of entries) {
      const mailbox = state.mailboxes[logicalName];
      if (!mailbox) continue;
      if (mailboxSpec.roles?.includes("default_outbound")) defaults.default_outbound_mailbox_id = mailbox.id;
      if (mailboxSpec.roles?.includes("auth_sender")) defaults.auth_sender_mailbox_id = mailbox.id;
    }
    if (
      (defaults.default_outbound_mailbox_id && envelope.mailbox_settings?.default_outbound_mailbox_id !== defaults.default_outbound_mailbox_id) ||
      (defaults.auth_sender_mailbox_id && envelope.mailbox_settings?.auth_sender_mailbox_id !== defaults.auth_sender_mailbox_id)
    ) {
      await this.sdk.email.setMailboxDefaults(projectId, defaults);
    }

    run.setState(step, "succeeded", {
      mailboxes: Object.fromEntries(Object.entries(state.mailboxes).map(([name, mailbox]) => [
        name,
        { mailbox_id: mailbox.id, slug: mailbox.slug, address: mailbox.address },
      ])),
    });
    return state;
  }

  #generatedAppEnv(
    projectId: string,
    projectKeys: { anon_key: string; service_key: string },
    publicOrigin: string | null,
    resources: AppResourceState,
  ): Record<string, string> {
    const env: Record<string, string> = {
      RUN402_PROJECT_ID: projectId,
      RUN402_ANON_KEY: projectKeys.anon_key,
      RUN402_SERVICE_KEY: projectKeys.service_key,
      RUN402_API_BASE: this.sdk.apiBase,
      RUN402_API_BASE_URL: this.sdk.apiBase,
    };
    if (publicOrigin) env.RUN402_PUBLIC_ORIGIN = publicOrigin;
    for (const [logicalName, mailbox] of Object.entries(resources.mailboxes)) {
      const suffix = logicalName.toUpperCase();
      env[`RUN402_MAILBOX_${suffix}_ID`] = mailbox.id;
      env[`RUN402_MAILBOX_${suffix}_ADDRESS`] = mailbox.address;
      if (mailbox.managed_address) env[`RUN402_MAILBOX_${suffix}_MANAGED_ADDRESS`] = mailbox.managed_address;
    }
    return env;
  }

  #userSecretEnv(spec: Run402AppSpec): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, secret] of Object.entries(spec.secrets ?? {})) {
      const sourceEnv = secret.source_env ?? name;
      const value = process.env[sourceEnv];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  async #ensureAppSecrets(
    projectId: string,
    spec: Run402AppSpec,
    env: Record<string, string>,
    run: ActionRun,
  ): Promise<void> {
    const required = new Set<string>();
    for (const [name, secret] of Object.entries(spec.secrets ?? {})) {
      if (secret.required === true || process.env[secret.source_env ?? name] !== undefined) required.add(name);
    }
    for (const name of releaseRequiredSecretNames(spec.release)) required.add(name);
    const names = [...required].sort();
    if (names.length === 0) return;

    const step = run.addStep({
      action: "app.secret.ensure",
      description: "Ensure app runtime secrets",
      mutation: true,
      auto: true,
      details: { project_id: projectId, keys: names },
    });
    await run.approve(step, ["app.secret.ensure"], "Set generated and user-provided app runtime secrets.");
    run.setState(step, "running");
    for (const name of names) {
      const value = env[name];
      if (value === undefined) {
        throw run.error(
          `App secret ${name} is required by the release but no generated or user-provided value is available.`,
          "MISSING_SECRET",
          { key: name },
        );
      }
      await this.sdk.secrets.set(projectId, name, { value });
    }
    run.setState(step, "succeeded", { keys: names });
  }

  async #runAppBuild(
    workspaceDir: string,
    spec: Run402AppSpec,
    env: Record<string, string>,
    run: ActionRun,
  ): Promise<void> {
    const commands = spec.build?.commands ?? [];
    if (commands.length === 0) return;
    const mode = spec.build?.mode ?? "local";
    if (mode !== "local") {
      throw run.error(
        `${mode} build mode is not executable by this SDK build.`,
        "REMOTE_BUILD_UNSUPPORTED",
        { mode },
      );
    }
    const step = run.addStep({
      action: "app.build",
      description: "Run app build commands",
      mutation: true,
      auto: false,
      details: { mode, commands: commands.map((command) => command.id) },
    });
    run.setState(step, "running");
    for (const command of commands) {
      const cwd = resolveMaybe(workspaceDir, command.cwd ?? ".");
      if (command.argv && command.argv.length > 0) {
        const [file, ...args] = command.argv;
        await execFileAsync(file, args, {
          cwd,
          env: { ...process.env, ...env },
          maxBuffer: 1024 * 1024 * 16,
        });
      } else if (command.shell) {
        await execFileAsync("/bin/sh", ["-c", command.shell], {
          cwd,
          env: { ...process.env, ...env },
          maxBuffer: 1024 * 1024 * 16,
        });
      } else {
        throw run.error(
          `Build command ${command.id} must define argv or shell.`,
          "APP_SPEC_INVALID",
          { command_id: command.id },
        );
      }
    }
    run.setState(step, "succeeded");
  }

  async #ensureAppWebhooks(
    projectId: string,
    spec: Run402AppSpec,
    resources: AppResourceState,
    run: ActionRun,
  ): Promise<Record<string, AppWebhookState>> {
    const entries = Object.entries(spec.resources?.webhooks ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const webhooks: Record<string, AppWebhookState> = {};
    if (entries.length === 0) return webhooks;
    const step = run.addStep({
      action: "app.webhook.ensure",
      description: "Ensure app mailbox webhooks",
      mutation: true,
      auto: true,
      details: { project_id: projectId, count: entries.length },
    });
    await run.approve(step, ["app.webhook.ensure"], "Create or reuse app mailbox webhooks.");
    run.setState(step, "running");
    for (const [logicalName, webhook] of entries) {
      const mailbox = resources.mailboxes[webhook.mailbox];
      if (!mailbox) {
        throw run.error(
          `Webhook ${logicalName} references unknown mailbox ${webhook.mailbox}.`,
          "APP_SPEC_INVALID",
          { webhook: logicalName, mailbox: webhook.mailbox },
        );
      }
      const url = materializeTemplates(webhook.url, resources.env) as string;
      const events = [...webhook.events].sort();
      const current = await this.sdk.email.webhooks.list(projectId, { mailbox: mailbox.id });
      const existing = current.webhooks.find((candidate: { url?: string; events?: string[] }) =>
        candidate.url === url && sameStringSet(candidate.events ?? [], events)
      );
      const summary = existing ?? await this.sdk.email.webhooks.register(projectId, {
        mailbox: mailbox.id,
        url,
        events,
      });
      webhooks[logicalName] = {
        id: summary.webhook_id,
        mailbox: webhook.mailbox,
        url,
        events,
        created: existing === undefined,
      };
    }
    run.setState(step, "succeeded", { webhooks });
    return webhooks;
  }

  async #verifyAppHttp(
    spec: Run402AppSpec,
    publicOrigin: string | null,
    run: ActionRun,
  ): Promise<{
    ok: boolean;
    results: Map<string, number | null>;
    diagnostics: Run402AppUpDiagnostic[];
  }> {
    const checks = spec.verify?.http ?? [];
    const results = new Map<string, number | null>();
    const diagnostics: Run402AppUpDiagnostic[] = [];
    if (checks.length === 0) return { ok: true, results, diagnostics };
    const step = run.addStep({
      action: "app.verify",
      description: "Verify app HTTP checks",
      mutation: false,
      auto: true,
      details: { count: checks.length },
    });
    run.setState(step, "running");
    for (const check of checks) {
      const url = check.url ?? (publicOrigin && check.path ? new URL(check.path, publicOrigin).toString() : null);
      if (!url) {
        results.set(check.id, null);
        diagnostics.push({
          code: "VERIFY_FAILED",
          severity: "error",
          node_id: `verify.http.${check.id}`,
          message: `HTTP verification ${check.id} needs either url or project public origin + path.`,
        });
        continue;
      }
      const retries = Math.max(1, check.retries ?? 1);
      let status: number | null = null;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const res = await fetch(url, { method: "GET" });
          status = res.status;
          if (status === check.expect.status) break;
        } catch {
          status = null;
        }
        if (attempt + 1 < retries) await delay(1_000);
      }
      results.set(check.id, status);
      if (status !== check.expect.status) {
        diagnostics.push({
          code: "VERIFY_FAILED",
          severity: "error",
          node_id: `verify.http.${check.id}`,
          message: `HTTP verification ${check.id} expected ${check.expect.status}, got ${status ?? "network_error"}.`,
          details: { url, expected_status: check.expect.status, actual_status: status },
        });
      }
    }
    run.setState(step, diagnostics.length === 0 ? "succeeded" : "failed", {
      checks: Object.fromEntries(results),
    });
    return { ok: diagnostics.length === 0, results, diagnostics };
  }

  async #ensureAllowance(run: ActionRun, opts: { fund: boolean } = { fund: false }): Promise<void> {
    const status = await this.sdk.allowance.status();
    if (status.configured) {
      run.skipStep({
        action: "allowance.create",
        description: "Local allowance already exists",
        mutation: false,
        auto: true,
        details: { address: status.address, path: status.path ?? null },
      });
      if (!opts.fund) return;
      if (status.faucet_used) {
        run.skipStep({
          action: "allowance.faucet",
          description: "Allowance faucet marker already present",
          mutation: false,
          auto: true,
          details: { address: status.address, last_faucet: status.lastFaucet ?? null },
        });
        return;
      }
    } else {
      const createStep = run.addStep({
        action: "allowance.create",
        description: "Create local allowance",
        mutation: true,
        auto: true,
      });
      await run.approve(createStep, ["allowance.create"], "Create a local allowance wallet.");
      if (run.dryRun) {
        run.setState(createStep, "planned");
        return;
      }
      run.setState(createStep, "running");
      const created = await this.sdk.allowance.create();
      run.setState(createStep, "succeeded", {
        address: created.address,
        path: created.path ?? null,
      });
      if (!opts.fund) return;
    }

    const faucetStep = run.addStep({
      action: "allowance.faucet",
      description: "Request testnet faucet funds for allowance",
      mutation: true,
      auto: true,
      details: { idempotency_key: run.childKey("allowance.faucet") },
    });
    await run.approve(faucetStep, ["allowance.faucet"], "Request testnet USDC for the local allowance.");
    if (run.dryRun) {
      run.setState(faucetStep, "planned");
      return;
    }
    run.setState(faucetStep, "running");
    const faucet = await this.sdk.allowance.faucet({
      idempotencyKey: run.childKey("allowance.faucet"),
    });
    run.setState(faucetStep, "succeeded", {
      transaction_hash: faucet.transactionHash,
      amount: faucet.amount,
      network: faucet.network,
    });
  }

  async #ensureCloudTier(run: ActionRun, desiredTier: TierName): Promise<void> {
    await this.#ensureAllowance(run, { fund: false });
    if (run.dryRun) {
      const faucetStep = run.addStep({
        action: "allowance.faucet",
        description: "Request testnet faucet funds if tier payment is needed",
        mutation: true,
        auto: true,
      });
      await run.approve(faucetStep, ["allowance.faucet"], "Request testnet USDC if tier bootstrap needs payment.");
      run.setState(faucetStep, "planned");
      const step = run.addStep({
        action: Run402Action.TierSet,
        description: `Ensure active ${desiredTier} tier`,
        mutation: true,
        auto: true,
        details: {
          tier: desiredTier,
          idempotency_key: run.childKey("tier.set"),
          reason: "dry_run",
        },
      });
      await run.approve(step, ["tier.set"], `Subscribe to ${desiredTier} if no active tier exists.`);
      run.setState(step, "planned");
      return;
    }

    let status;
    try {
      status = await this.sdk.tier.status();
    } catch {
      status = null;
    }
    const current = normalizeTier(status?.tier);
    if (status?.active && current && TIER_RANK[current] >= TIER_RANK[desiredTier]) {
      run.skipStep({
        action: Run402Action.TierSet,
        description: "Active tier already satisfies bootstrap requirement",
        mutation: false,
        auto: true,
        details: { current_tier: current, desired_tier: desiredTier },
      });
      return;
    }
    if (status?.active && current && TIER_RANK[current] > TIER_RANK[desiredTier]) {
      run.skipStep({
        action: Run402Action.TierSet,
        description: "Existing active tier is higher than bootstrap default",
        mutation: false,
        auto: true,
        details: { current_tier: current, desired_tier: desiredTier },
      });
      return;
    }

    const idempotencyKey = run.childKey("tier.set");
    await this.#ensureAllowance(run, { fund: true });
    const step = run.addStep({
      action: Run402Action.TierSet,
      description: `Ensure active ${desiredTier} tier`,
      mutation: true,
      auto: true,
      details: {
        tier: desiredTier,
        current_tier: current ?? null,
        active: status?.active ?? null,
        idempotency_key: idempotencyKey,
      },
    });
    await run.approve(step, ["tier.set"], `Subscribe, renew, or upgrade to ${desiredTier}.`);
    run.setState(step, "running");
    const result = await this.sdk.tier.set(desiredTier, { idempotencyKey });
    run.setState(step, "succeeded", { tier: result.tier, action: result.action });
  }

  async #resolveProject(
    input: Run402UpActionInput,
    manifest: DiscoveredManifest,
    workspaceDir: string,
    run: ActionRun,
  ): Promise<ResolveProjectResult> {
    const linkPath = join(workspaceDir, ".run402", "project.json");
    const link = await readWorkspaceProjectLink(linkPath);
    const step = run.addStep({
      action: "project.resolve",
      description: "Resolve project for workspace",
      mutation: false,
      auto: true,
      details: {
        explicit_project_id: input.projectId ?? null,
        linked_project_id: link?.project_id ?? null,
        manifest_project_id: manifest.manifestProjectId ?? null,
      },
    });
    run.setState(step, "running");

    const linkConflict = workspaceLinkConflict(link, input, this.#targetKind(), linkPath);
    if (linkConflict && !input.projectId) {
      throw run.error(
        linkConflict.message,
        "RUN402_WORKSPACE_LINK_CONFLICT",
        linkConflict.details,
      );
    }

    let projectId: string | null = null;
    let source: ResolveProjectResult["source"] | null = null;
    let shouldWriteLink = false;
    if (input.projectId) {
      projectId = input.projectId;
      source = "explicit";
      shouldWriteLink = !link || link.project_id !== projectId;
    } else if (link?.project_id) {
      projectId = link.project_id;
      source = "workspace_link";
    } else if (manifest.manifestProjectId) {
      projectId = manifest.manifestProjectId;
      source = "manifest";
    }

    if (projectId && manifest.manifestProjectId && manifest.manifestProjectId !== projectId) {
      throw run.error(
        `Project conflict: resolved ${projectId} from ${source}, but manifest declares ${manifest.manifestProjectId}.`,
        "RUN402_PROJECT_CONFLICT",
        {
          resolved_project_id: projectId,
          resolved_source: source,
          manifest_project_id: manifest.manifestProjectId,
        },
      );
    }

    if (projectId) {
      run.setState(step, "succeeded", { project_id: projectId, source, link_path: linkPath });
      return { projectId, source: source ?? "explicit", link, linkPath, shouldWriteLink };
    }

    if (input.name) {
      if (run.executionMode === "plan") {
        throw run.error(
          "`up --plan` does not provision projects. Pass --project, add project_id/project to the manifest, or run `run402 up --name ...` first.",
          "RUN402_PROJECT_REQUIRED",
          { link_path: linkPath, manifest_path: manifest.manifestPath, mode: "plan" },
        );
      }
      if (this.#targetKind() === "core") {
        throw run.error(
          "Run402 Core cannot provision a Cloud project during `up`. Pass --project or add project_id to the manifest.",
          "RUN402_CORE_PROJECT_REQUIRED",
          { target: this.#targetKind() },
        );
      }
      const idempotencyKey = run.childKey("projects.provision");
      const provisionStep = run.addStep({
        action: Run402Action.ProjectsProvision,
        description: "Provision project for workspace",
        mutation: true,
        auto: true,
        details: {
          name: input.name,
          tier: input.tier ?? DEFAULT_BOOTSTRAP_TIER,
          org_id: input.orgId ?? null,
          idempotency_key: idempotencyKey,
        },
      });
      await run.approve(provisionStep, ["projects.provision"], `Provision project '${input.name}'.`);
      if (run.dryRun) {
        run.setState(provisionStep, "planned");
        run.setState(step, "planned", { source: "created", link_path: linkPath });
        return {
          projectId: "prj_planned",
          source: "created",
          link,
          linkPath,
          shouldWriteLink: true,
        };
      }
      run.setState(provisionStep, "running");
      const provisioned = await this.sdk.projects.provision({
        name: input.name,
        tier: input.tier ?? DEFAULT_BOOTSTRAP_TIER,
        orgId: input.orgId,
        idempotencyKey,
      });
      run.setState(provisionStep, "succeeded", { project_id: provisioned.project_id });
      run.setState(step, "succeeded", {
        project_id: provisioned.project_id,
        source: "created",
        link_path: linkPath,
      });
      return {
        projectId: provisioned.project_id,
        source: "created",
        link,
        linkPath,
        shouldWriteLink: true,
      };
    }

    const active = await this.sdk.projects.active();
    if (active) {
      const activeStep = run.addStep({
        action: "project.resolve",
        description: "Use active project for this workspace",
        mutation: false,
        auto: true,
        details: { active_project_id: active },
      });
      await run.approve(
        activeStep,
        [],
        `Use active project ${active} and link this workspace to it.`,
      );
      run.setState(activeStep, run.dryRun ? "planned" : "succeeded", {
        project_id: active,
        source: "active",
      });
      run.setState(step, run.dryRun ? "planned" : "succeeded", {
        project_id: active,
        source: "active",
        link_path: linkPath,
      });
      return {
        projectId: active,
        source: "active",
        link,
        linkPath,
        shouldWriteLink: true,
      };
    }

    throw run.error(
      "No project is configured for this workspace. Pass --project, add project_id to the manifest, or pass --name to create one.",
      "RUN402_PROJECT_REQUIRED",
      { link_path: linkPath, manifest_path: manifest.manifestPath },
    );
  }

  async #writeWorkspaceProjectLink(
    path: string,
    link: WorkspaceProjectLink,
    expectedExisting: WorkspaceProjectLink | null | undefined,
    run: ActionRun,
  ): Promise<void> {
    const step = run.addStep({
      action: "workspace.link.write",
      description: "Write workspace project link",
      mutation: true,
      auto: true,
      details: { path, project_id: link.project_id, name: link.name ?? null },
    });
    await run.approve(step, ["workspace.link.write"], `Write ${shortPath(path)}.`);
    if (run.dryRun) {
      run.setState(step, "planned");
      return;
    }
    run.setState(step, "running");
    await assertNotSymlinkPath(path);
    const current = await readWorkspaceProjectLink(path);
    if (!workspaceProjectLinksEqual(current, expectedExisting ?? null)) {
      throw run.error(
        "Workspace project link changed while `up` was running; refusing to overwrite it.",
        "RUN402_WORKSPACE_LINK_CONFLICT",
        {
          path,
          expected_project_id: expectedExisting?.project_id ?? null,
          current_project_id: current?.project_id ?? null,
        },
      );
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    run.setState(step, "succeeded", { path });
  }

  async #assertLocalProjectKeys(projectId: string, run: ActionRun): Promise<void> {
    try {
      await this.sdk.projects.keys(projectId);
    } catch (err) {
      throw withActionDetails(
        new LocalError(
          `Project ${projectId} is selected, but its keys are not available locally. Use a project in the local keystore or provision/link from this machine.`,
          "resolving project keys for up",
          {
            cause: err,
            code: "RUN402_PROJECT_KEYS_REQUIRED",
            details: { project_id: projectId, steps: run.steps },
          },
        ),
        run,
      );
    }
  }
}

class ActionRun {
  readonly steps: Run402ActionStep[] = [];
  readonly dryRun: boolean;
  readonly executionMode: Run402ExecutionMode | "legacyDryRun";
  readonly autoPrerequisites: boolean;
  readonly approval: Run402ActionApproval;

  constructor(
    readonly input: Run402ActionInput,
    readonly options: Run402ActionRunOptions,
    readonly target: NodeActionTargetKind,
  ) {
    this.executionMode = options.mode ?? (options.dryRun === true ? "legacyDryRun" : "apply");
    this.dryRun = options.dryRun === true;
    this.autoPrerequisites = options.autoPrerequisites ?? input.type === Run402Action.Up;
    this.approval = options.approval ?? "never";
  }

  get rootIdempotencyKey(): string | undefined {
    return this.input.idempotencyKey ?? this.options.idempotencyKey;
  }

  childKey(scope: string): string {
    const root = this.rootIdempotencyKey ?? deriveStableRootKey(this.input);
    if (!root) {
      throw this.error(
        `Cannot derive an idempotency key for recursive mutation ${scope}.`,
        "RUN402_IDEMPOTENCY_REQUIRED",
        { scope, action: this.input.type },
      );
    }
    return `action:${root}:${scope}`;
  }

  addStep(init: {
    action: Run402ActionStep["action"];
    description: string;
    mutation: boolean;
    auto: boolean;
    details?: Record<string, unknown>;
  }): Run402ActionStep {
    const step: Run402ActionStep = {
      id: `step_${String(this.steps.length + 1).padStart(2, "0")}`,
      action: init.action,
      description: init.description,
      state: "planned",
      mutation: init.mutation,
      auto: init.auto,
      ...(init.details ? { details: init.details } : {}),
    };
    this.steps.push(step);
    this.emit(step);
    return step;
  }

  skipStep(init: Omit<Parameters<ActionRun["addStep"]>[0], "mutation"> & { mutation?: boolean }): Run402ActionStep {
    const step = this.addStep({
      ...init,
      mutation: init.mutation ?? false,
    });
    this.setState(step, "skipped", init.details);
    return step;
  }

  setState(
    step: Run402ActionStep,
    state: Run402ActionStepState,
    details?: Record<string, unknown>,
  ): void {
    step.state = state;
    if (details) step.details = { ...(step.details ?? {}), ...details };
    this.emit(step);
  }

  failLast(err: unknown): void {
    const step = [...this.steps].reverse().find((candidate) =>
      candidate.state === "running" || candidate.state === "planned"
    );
    if (!step) return;
    this.setState(step, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  async approve(
    step: Run402ActionStep,
    mutations: Run402ActionMutation[],
    message: string,
  ): Promise<void> {
    if (!step.auto) return;
    if (this.dryRun) return;
    if (!step.mutation && mutations.length === 0) {
      if (this.approval === "never" && step.action === "project.resolve") {
        throw this.error(
          "Using the active project for `up` requires approval. Pass --project, create a workspace link, or run with -y / an interactive prompt.",
          "RUN402_APPROVAL_REQUIRED",
          { step, mutations },
        );
      }
      return;
    }
    if (this.approval === "yes") return;
    if (this.approval !== "never") {
      const approved = await this.approval.approve({
        action: this.input.type,
        step,
        message,
        mutations,
      });
      if (approved) return;
    }
    this.setState(step, "blocked", { approval_required: true, mutations });
    throw this.error(
      `${message} Approval is required before this action can continue.`,
      "RUN402_APPROVAL_REQUIRED",
      { step, mutations },
    );
  }

  result<T>(result: T): Run402ActionResult<T> {
    return {
      action: this.input.type,
      mode: this.executionMode,
      dry_run: this.dryRun || this.executionMode === "check" || this.executionMode === "printSpec" || this.executionMode === "plan",
      target: this.target,
      steps: this.steps,
      result,
    };
  }

  error(message: string, code: string, details?: Record<string, unknown>): LocalError {
    return withActionDetails(
      new LocalError(message, "running Run402 action", {
        code,
        details: { action: this.input.type, ...(details ?? {}), steps: this.steps },
      }),
      this,
    );
  }

  private emit(step: Run402ActionStep): void {
    this.options.onEvent?.({
      type: "action.step",
      action: this.input.type,
      step: { ...step, details: step.details ? { ...step.details } : undefined },
    });
  }
}

function withActionDetails(err: LocalError, run: ActionRun): LocalError {
  Object.defineProperty(err, "steps", {
    value: run.steps,
    enumerable: true,
    configurable: true,
  });
  return err;
}

function isRepositoryUrl(value: string): boolean {
  return /^https?:\/\/.+/.test(value) || /^git@[^:]+:.+/.test(value) || /^ssh:\/\/.+/.test(value) || /^file:\/\/.+/.test(value);
}

async function gitCommit(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    const commit = String(stdout).trim();
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

function appPublicOrigin(input: Run402UpActionInput, spec: Run402AppSpec | undefined): string | null {
  const template = spec?.project.origin?.subdomain;
  if (!template) return null;
  const name = input.name ?? spec?.project.name ?? null;
  const subdomain = template.replace(/\$\{input\.name\}/g, name ?? "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return null;
  return `https://${subdomain}.run402.com`;
}

function materializeTemplates(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => values[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => materializeTemplates(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        materializeTemplates(nested, values),
      ]),
    );
  }
  return value;
}

function appMailboxSlug(logicalName: string, spec: Run402AppMailboxSpec): string {
  return spec.slug ?? logicalName.replace(/_/g, "-");
}

function releaseRequiredSecretNames(release: Run402AppReleaseSpec): string[] {
  const secrets = release.secrets;
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) return [];
  const required = (secrets as { require?: unknown }).require;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function markAppGraphNodes(graph: Run402AppInstallGraph, status: "succeeded" | "failed"): void {
  for (const node of graph.nodes) {
    node.status = status;
  }
}

function applyResourceStateToAppResult(appResult: Run402AppUpResultEnvelope, resources: AppResourceState): void {
  for (const [name, mailbox] of Object.entries(resources.mailboxes)) {
    if (!appResult.resources.mailboxes[name]) continue;
    appResult.resources.mailboxes[name].id = mailbox.id;
    appResult.resources.mailboxes[name].address = mailbox.address;
  }
  for (const [name, webhook] of Object.entries(resources.webhooks)) {
    appResult.resources.webhooks[name] = {
      id: webhook.id,
      mailbox: webhook.mailbox,
      url: webhook.url,
      events: webhook.events,
      enabled: true,
    };
  }
  appResult.resources.bindings = appResult.resources.bindings.map((binding) => {
    const value = resources.env[binding.env];
    return value === undefined
      ? binding
      : { ...binding, value, redacted: /KEY|SECRET|TOKEN/.test(binding.env) };
  });
  appResult.resources.user_secrets = Object.fromEntries(
    Object.entries(appResult.resources.user_secrets).map(([name, secret]) => [
      name,
      { ...secret, satisfied: resources.env[name] !== undefined },
    ]),
  );
}

function spendApprovalBlock(
  input: Run402UpActionInput,
  run: ActionRun,
): { nodeId: string; diagnostics: Run402AppUpDiagnostic[]; nextActions: Run402AppUpNextAction[] } | null {
  const expectedPrototypeSpendUsd = 0.10;
  if (input.maxSpendUsd !== undefined && input.maxSpendUsd < expectedPrototypeSpendUsd) {
    return {
      nodeId: "account.ensure",
      diagnostics: [{
        code: "SPEND_APPROVAL_REQUIRED",
        severity: "error",
        node_id: "account.ensure",
        message: `The app install may need up to $${expectedPrototypeSpendUsd.toFixed(2)} for tier readiness, above --max-spend-usd ${input.maxSpendUsd}.`,
      }],
      nextActions: [{
        type: "approve_spend",
        code: "SPEND_APPROVAL_REQUIRED",
        node_id: "account.ensure",
        message: "Raise --max-spend-usd or preconfigure an active tier, then retry with approval.",
        spend: {
          amount_usd_micros: 100_000,
          currency: "USD",
          description: "prototype tier readiness",
        },
      }],
    };
  }
  if (run.approval !== "yes") {
    return {
      nodeId: "account.ensure",
      diagnostics: [{
        code: "SPEND_APPROVAL_REQUIRED",
        severity: "error",
        node_id: "account.ensure",
        message: "App-aware up needs explicit approval before it can perform spend-impacting readiness steps.",
      }],
      nextActions: [{
        type: "approve_spend",
        code: "SPEND_APPROVAL_REQUIRED",
        node_id: "account.ensure",
        message: "Retry with --yes and an appropriate --max-spend-usd cap, or run --dry-run to inspect the plan.",
        argv: ["run402", "up", "--yes", "--max-spend-usd", String(expectedPrototypeSpendUsd)],
        spend: {
          amount_usd_micros: 100_000,
          currency: "USD",
          description: "prototype tier readiness",
        },
      }],
    };
  }
  return null;
}

function missingRequiredName(
  input: Run402UpActionInput,
  manifest: DiscoveredManifest,
): { nodeId: string; diagnostics: Run402AppUpDiagnostic[]; nextActions: Run402AppUpNextAction[] } | null {
  const spec = manifest.appSpec;
  if (!spec || input.name || input.projectId || spec.project.id) return null;
  const needsName = spec.project.name?.includes("${input.name}") === true ||
    spec.project.origin?.subdomain?.includes("${input.name}") === true;
  if (!needsName) return null;
  return {
    nodeId: "project.ensure",
    diagnostics: [{
      code: "PROJECT_REQUIRED",
      severity: "error",
      node_id: "project.ensure",
      field_path: "project.name",
      message: "This app needs an instance name so Run402 can create the project, public subdomain, and project-scoped mail host.",
      details: {
        manifest_path: manifest.manifestPath,
        template: "${input.name}",
      },
    }],
    nextActions: [{
      type: "set_project_name",
      code: "PROJECT_REQUIRED",
      node_id: "project.ensure",
      field_path: "project.name",
      message: "Retry with --name, for example: run402 up --name kysigned3 --yes.",
      command: "run402 up --name kysigned3 --yes",
      argv: ["run402", "up", "--name", "kysigned3", "--yes"],
    }],
  };
}

function missingRequiredSecrets(spec: Run402AppSpec | undefined): Array<{ name: string; sourceEnv: string; description?: string }> {
  const missing: Array<{ name: string; sourceEnv: string; description?: string }> = [];
  for (const [name, secret] of Object.entries(spec?.secrets ?? {})) {
    if (secret.required !== true) continue;
    const sourceEnv = secret.source_env ?? name;
    if (process.env[sourceEnv]) continue;
    missing.push({
      name,
      sourceEnv,
      ...(secret.description ? { description: secret.description } : {}),
    });
  }
  return missing;
}

function appBuildBlock(
  input: Run402UpActionInput,
  manifest: DiscoveredManifest,
): { nodeId: string; diagnostics: Run402AppUpDiagnostic[]; nextActions: Run402AppUpNextAction[] } | null {
  const build = manifest.appSpec?.build;
  if (!build) return null;
  const mode = input.buildMode ?? build.mode ?? "local";
  const nodeId = `build.${mode}`;
  const shellCommand = build.commands?.find((command) => command.shell);
  if (shellCommand && input.allowShellBuild !== true) {
    return {
      nodeId,
      diagnostics: [{
        code: "BUILD_APPROVAL_REQUIRED",
        severity: "error",
        node_id: nodeId,
        field_path: `build.commands.${shellCommand.id}.shell`,
        message: "Shell-string build commands require explicit shell build approval.",
      }],
      nextActions: [{
        type: "approve_shell_build",
        code: "BUILD_APPROVAL_REQUIRED",
        node_id: nodeId,
        field_path: `build.commands.${shellCommand.id}.shell`,
        message: "Review the shell command, then retry with --allow-shell-build or convert it to argv.",
      }],
    };
  }
  if (mode === "remote" || mode === "sandbox") {
    return {
      nodeId,
      diagnostics: [{
        code: "REMOTE_BUILD_UNSUPPORTED",
        severity: "error",
        node_id: nodeId,
        message: `${mode} build mode is planned but not available in this SDK build yet.`,
      }],
      nextActions: [{
        type: "choose_build_mode",
        code: "REMOTE_BUILD_UNSUPPORTED",
        node_id: nodeId,
        message: "Retry with --build-mode local after preparing the local toolchain, or wait for Run402 remote build support.",
        argv: ["run402", "up", "--build-mode", "local", "--yes"],
      }],
    };
  }
  return null;
}

async function findManifest(workspaceDir: string): Promise<string | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = join(workspaceDir, candidate);
    try {
      await lstat(path);
      return path;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function findExecutableManifest(workspaceDir: string): Promise<string | null> {
  for (const candidate of EXECUTABLE_MANIFEST_CANDIDATES) {
    const path = join(workspaceDir, candidate);
    try {
      await lstat(path);
      return path;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function loadRun402AppManifest(path: string): Promise<Run402AppSpec> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new LocalError(
      `Failed to read Run402 app manifest '${path}': ${(err as Error).message}`,
      "loading Run402 app manifest",
      err,
    );
  }

  try {
    return JSON.parse(raw) as Run402AppSpec;
  } catch (err) {
    throw new LocalError(
      `Run402 app manifest is not valid JSON: ${(err as Error).message}`,
      "parsing Run402 app manifest",
      {
        code: "APP_SPEC_INVALID",
        details: { path },
      },
    );
  }
}

function reviewedPlanRequirement(
  mode: Run402ExecutionMode | "legacyDryRun",
): Run402ReviewedPlanRequirement | undefined {
  return typeof mode === "object" && mode.kind === "applyReviewed"
    ? { planId: mode.planId, ...(mode.planFingerprint ? { planFingerprint: mode.planFingerprint } : {}) }
    : undefined;
}

function withUpReviewedPlanNextAction(plan: PlanResponse, manifestPath: string): PlanResponse {
  if (!plan.plan_id) return plan;
  const commandManifest = shortPath(manifestPath);
  const argv = ["run402", "up", "--manifest", manifestPath, "--require-plan", plan.plan_id];
  const commandParts = ["run402", "up", "--manifest", shellArg(commandManifest), "--require-plan", shellArg(plan.plan_id)];
  if (plan.plan_fingerprint) {
    argv.push("--plan-fingerprint", plan.plan_fingerprint);
    commandParts.push("--plan-fingerprint", shellArg(plan.plan_fingerprint));
  }
  return {
    ...plan,
    next_actions: [{
      type: "retry",
      command: commandParts.join(" "),
      argv,
      why: "Apply exactly this reviewed plan from the same repo surface before it expires.",
    }],
  };
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readWorkspaceProjectLink(path: string): Promise<WorkspaceProjectLink | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalError(
      `Workspace project link is not valid JSON: ${(err as Error).message}`,
      "reading workspace project link",
      { code: "RUN402_WORKSPACE_LINK_INVALID", details: { path } },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalError(
      "Workspace project link must be a JSON object.",
      "reading workspace project link",
      { code: "RUN402_WORKSPACE_LINK_INVALID", details: { path } },
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schema_version !== "run402.workspace-project.v1" ||
    typeof record.project_id !== "string" ||
    !record.project_id
  ) {
    throw new LocalError(
      "Workspace project link must contain schema_version=run402.workspace-project.v1 and project_id.",
      "reading workspace project link",
      { code: "RUN402_WORKSPACE_LINK_INVALID", details: { path } },
    );
  }
  return record as unknown as WorkspaceProjectLink;
}

async function assertNotSymlinkPath(path: string): Promise<void> {
  const parts = path.split(/[\\/]+/);
  let cursor = isAbsolute(path) ? "/" : process.cwd();
  for (const part of parts) {
    if (!part || part === ".") continue;
    cursor = cursor === "/" ? `/${part}` : join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new LocalError(
          `Refusing to write workspace project link through symlink: ${cursor}`,
          "writing workspace project link",
          { code: "RUN402_WORKSPACE_LINK_SYMLINK", details: { path, symlink: cursor } },
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(dirname(cursor));
        } catch {
          // parent also absent; mkdir will create it later
        }
      } else {
        throw err;
      }
    }
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function resolveMaybe(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolvePath(baseDir, path);
}

function shortPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function normalizeTier(tier: unknown): TierName | null {
  return tier === "prototype" || tier === "hobby" || tier === "team" ? tier : null;
}

function workspaceProjectLinksEqual(a: WorkspaceProjectLink | null, b: WorkspaceProjectLink | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.schema_version === b.schema_version &&
    a.project_id === b.project_id &&
    (a.name ?? null) === (b.name ?? null) &&
    (a.target?.kind ?? null) === (b.target?.kind ?? null) &&
    (a.target?.api_base ?? null) === (b.target?.api_base ?? null)
  );
}

function workspaceLinkConflict(
  link: WorkspaceProjectLink | null,
  input: Run402UpActionInput,
  targetKind: NodeActionTargetKind,
  linkPath: string,
): { message: string; details: Record<string, unknown> } | null {
  if (!link) return null;
  const linkedTarget = link.target?.kind;
  if (linkedTarget && targetKind !== "unknown" && linkedTarget !== targetKind) {
    return {
      message: "Workspace project link was created for a different Run402 target.",
      details: {
        reason: "target_mismatch",
        linked_project_id: link.project_id,
        linked_target: linkedTarget,
        target: targetKind,
        link_path: linkPath,
      },
    };
  }
  if (!input.name) return null;
  if (!link.name) {
    return {
      message: "--name was supplied, but this workspace is already linked to a project without a recorded name.",
      details: {
        reason: "name_missing",
        linked_project_id: link.project_id,
        name: input.name,
        link_path: linkPath,
      },
    };
  }
  if (input.name !== link.name) {
    return {
      message: "--name conflicts with the existing workspace project link.",
      details: {
        reason: "name_mismatch",
        linked_project_id: link.project_id,
        linked_name: link.name,
        name: input.name,
        link_path: linkPath,
      },
    };
  }
  return null;
}

function deriveStableRootKey(input: Run402ActionInput): string | null {
  if (input.type === Run402Action.ProjectsProvision && input.name) {
    return `projects.provision:${input.name}`;
  }
  if (input.type === Run402Action.Up) {
    const stable = JSON.stringify({
      type: input.type,
      dir: input.dir ?? ".",
      manifest: input.manifest ?? null,
      projectId: input.projectId ?? null,
      name: input.name ?? null,
      tier: input.tier ?? DEFAULT_BOOTSTRAP_TIER,
      orgId: input.orgId ?? null,
    });
    return `up:${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
  }
  return null;
}

function hasDeployableContent(spec: ReleaseSpec): boolean {
  const meaningful = ["database", "site", "functions", "secrets", "subdomains", "routes", "checks", "i18n", "assets"] as const;
  return meaningful.some((key) => hasContent(spec[key]));
}

function hasContent(value: unknown): boolean {
  if (value === null) return true;
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasContent);
  }
  if (typeof value === "string") return value.length > 0;
  return true;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function actionErrorDetails(err: unknown): Record<string, unknown> {
  const maybe = err as { code?: unknown; details?: unknown };
  return {
    message: err instanceof Error ? err.message : String(err),
    ...(typeof maybe.code === "string" ? { code: maybe.code } : {}),
    ...(maybe.details && typeof maybe.details === "object" ? { details: maybe.details } : {}),
  };
}

function assertNever(value: never): never {
  throw new LocalError(
    `Unknown Run402 action ${(value as { type?: unknown }).type}`,
    "running Run402 action",
    { code: "RUN402_ACTION_UNKNOWN" },
  );
}
