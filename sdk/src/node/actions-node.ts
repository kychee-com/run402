import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
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
import { LocalError } from "../errors.js";
import type { Run402 } from "../index.js";
import type { DeployEvent, ReleaseSpec } from "../namespaces/deploy.types.js";
import type { ProvisionResult } from "../namespaces/projects.types.js";
import type { TierName, TierSetResult } from "../namespaces/tier.js";
import { loadDeployManifest } from "./deploy-manifest.js";

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
  manifestPath: string;
  releaseSpec: ReleaseSpec;
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
  "run402.deploy.json",
  "app.json",
];
const TIER_RANK: Record<TierName, number> = {
  prototype: 1,
  hobby: 2,
  team: 3,
};

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
    const workspaceDir = resolvePath(this.opts.cwd ?? process.cwd(), input.dir ?? ".");
    const manifest = await this.#discoverAndValidateManifest(input, workspaceDir, run);

    if (this.#targetKind() !== "core") {
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
    if (resolved.shouldWriteLink) {
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
      description: "Apply deploy manifest",
      mutation: true,
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
    const deploy = await scoped.apply(releaseSpec, {
      idempotencyKey: normalized.idempotencyKey ?? manifest.idempotencyKey ?? run.childKey("deploy.apply"),
      allowWarnings: input.allowWarnings,
      allowWarningCodes: input.allowWarningCodes,
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
      throw run.error(
        "No deploy manifest found. Add run402.deploy.json or app.json, or pass --manifest.",
        "UP_MANIFEST_REQUIRED",
        { dir: workspaceDir, candidates: MANIFEST_CANDIDATES },
      );
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
      manifestPath,
      releaseSpec: loaded.spec,
      idempotencyKey: loaded.idempotencyKey,
      manifestProjectId: loaded.spec.project === "prj_up_preflight_placeholder"
        ? undefined
        : loaded.spec.project,
    };
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

    if (input.name && link?.name && input.name !== link.name) {
      throw run.error(
        "--name is only used when creating/linking a project and conflicts with the workspace link name.",
        "RUN402_NAME_PROJECT_CONFLICT",
        { name: input.name, linked_name: link.name, link_path: linkPath },
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
  readonly autoPrerequisites: boolean;
  readonly approval: Run402ActionApproval;

  constructor(
    readonly input: Run402ActionInput,
    readonly options: Run402ActionRunOptions,
    readonly target: NodeActionTargetKind,
  ) {
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
      dry_run: this.dryRun,
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

function assertNever(value: never): never {
  throw new LocalError(
    `Unknown Run402 action ${(value as { type?: unknown }).type}`,
    "running Run402 action",
    { code: "RUN402_ACTION_UNKNOWN" },
  );
}
