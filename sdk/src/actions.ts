import type { DeployResult } from "./namespaces/deploy.types.js";
import type { ProvisionResult } from "./namespaces/projects.types.js";
import type { TierName, TierSetResult } from "./namespaces/tier.js";

/**
 * Stable action identifiers for the SDK action runner. Use these constants
 * instead of hand-typed strings so TypeScript narrows action inputs cleanly.
 */
export const Run402Action = {
  ProjectsProvision: "projects.provision",
  TierSet: "tier.set",
  Up: "up",
} as const;

export type Run402ActionType =
  typeof Run402Action[keyof typeof Run402Action];

export type Run402BootstrapTier = TierName;

export type Run402ActionInput =
  | Run402ProjectsProvisionActionInput
  | Run402TierSetActionInput
  | Run402UpActionInput;

export interface Run402ProjectsProvisionActionInput {
  type: typeof Run402Action.ProjectsProvision;
  name?: string;
  tier?: Run402BootstrapTier;
  orgId?: string;
  idempotencyKey?: string;
}

export interface Run402TierSetActionInput {
  type: typeof Run402Action.TierSet;
  tier: Run402BootstrapTier;
  idempotencyKey?: string;
}

export interface Run402UpActionInput {
  type: typeof Run402Action.Up;
  /** Workspace directory to inspect. Defaults to `process.cwd()` in the Node SDK. */
  dir?: string;
  /** Explicit deploy manifest path. Defaults to manifest discovery inside `dir`. */
  manifest?: string;
  /** Explicit project. Highest-priority project selector. */
  projectId?: string;
  /**
   * Display name used only when `up` needs to create and link a new project.
   * This is not a deploy-manifest field and never renames an existing project.
   */
  name?: string;
  /** Bootstrap tier when no active Cloud tier exists. Defaults to `prototype`. */
  tier?: Run402BootstrapTier;
  /** Existing org to provision into when `up` needs to create a project. */
  orgId?: string;
  /** Root idempotency key. Child mutation keys are derived from this value. */
  idempotencyKey?: string;
  /** Continue past deploy-plan warnings, forwarded to `apply()`. */
  allowWarnings?: boolean;
  /** Continue past selected deploy-plan warnings, forwarded to `apply()`. */
  allowWarningCodes?: string[];
}

export type Run402ActionApproval =
  | "never"
  | "yes"
  | Run402InteractiveActionApproval;

export interface Run402InteractiveActionApproval {
  mode: "interactive";
  approve(request: Run402ActionApprovalRequest): boolean | Promise<boolean>;
}

export interface Run402ActionApprovalRequest {
  action: Run402ActionType;
  step: Run402ActionStep;
  message: string;
  mutations: Run402ActionMutation[];
}

export type Run402ActionMutation =
  | "allowance.create"
  | "allowance.faucet"
  | "tier.set"
  | "projects.provision"
  | "workspace.link.write"
  | "deploy.apply";

export interface Run402ActionRunOptions {
  /**
   * Plan only. No gateway mutations, uploads, or local writes are performed.
   */
  dryRun?: boolean;
  /**
   * Permit recursive prerequisites. Defaults to `false` for direct actions and
   * `true` for `up`.
   */
  autoPrerequisites?: boolean;
  /**
   * Approval gate for recursive mutations. Defaults to `never`; CLI maps
   * `-y/--yes` to `yes` and TTY prompts to `interactive`.
   */
  approval?: Run402ActionApproval;
  /** Root idempotency key. Action input wins when both are supplied. */
  idempotencyKey?: string;
  /** Observe action-runner progress. */
  onEvent?: (event: Run402ActionEvent) => void;
}

export type Run402ActionStepState =
  | "planned"
  | "running"
  | "succeeded"
  | "skipped"
  | "blocked"
  | "failed";

export interface Run402ActionStep {
  id: string;
  action: Run402ActionType | Run402ActionMutation | "deploy.discover" | "project.resolve";
  description: string;
  state: Run402ActionStepState;
  mutation: boolean;
  auto: boolean;
  details?: Record<string, unknown>;
}

export interface Run402ActionEvent {
  type: "action.step";
  action: Run402ActionType;
  step: Run402ActionStep;
}

export interface Run402ActionResult<T = unknown> {
  action: Run402ActionType;
  dry_run: boolean;
  target: "cloud" | "core" | "unknown";
  steps: Run402ActionStep[];
  result?: T;
}

export interface Run402UpResult {
  project_id: string;
  manifest_path: string;
  workspace_link_path?: string;
  deploy?: DeployResult;
}

export type Run402ProjectsProvisionActionResult =
  Run402ActionResult<ProvisionResult>;

export type Run402TierSetActionResult =
  Run402ActionResult<TierSetResult>;

export type Run402UpActionResult =
  Run402ActionResult<Run402UpResult>;

export interface Run402Actions {
  run(
    input: Run402ProjectsProvisionActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402ProjectsProvisionActionResult>;
  run(
    input: Run402TierSetActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402TierSetActionResult>;
  run(
    input: Run402UpActionInput,
    opts?: Run402ActionRunOptions,
  ): Promise<Run402UpActionResult>;
  run(input: Run402ActionInput, opts?: Run402ActionRunOptions): Promise<Run402ActionResult>;
}
