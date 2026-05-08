import { z } from "zod";
import { mapSdkError } from "../errors.js";
import { getSdk } from "../sdk.js";

const routeScopesSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Optional route delegation scopes, normalized by the SDK. Use exact paths like /admin or final wildcard prefixes like /api/*. Omit or pass [] for no CI route authority.",
  );

export const ciCreateBindingSchema = {
  project_id: z.string().describe("Project ID the CI binding may deploy to."),
  provider: z
    .literal("github-actions")
    .optional()
    .describe("CI provider. V1 supports only github-actions; omitted defaults to github-actions."),
  subject_match: z
    .string()
    .describe("GitHub Actions OIDC subject match, e.g. repo:owner/repo:ref:refs/heads/main."),
  allowed_actions: z
    .array(z.literal("deploy"))
    .describe("Allowed CI actions. V1 supports only deploy."),
  allowed_events: z
    .array(z.string())
    .min(1)
    .describe("Allowed GitHub event names, typically push and workflow_dispatch."),
  route_scopes: routeScopesSchema,
  github_repository_id: z
    .string()
    .nullable()
    .optional()
    .describe("Numeric GitHub repository id to pin the binding to, or null if absent."),
  expires_at: z
    .string()
    .nullable()
    .optional()
    .describe("Optional ISO timestamp when this binding expires."),
  nonce: z
    .string()
    .describe("Lowercase hex nonce included in the signed delegation."),
  signed_delegation: z
    .string()
    .describe(
      "Base64 SIGN-IN-WITH-X delegation signed locally by the allowance wallet. This MCP tool does not sign; it only sends the signed delegation to the SDK.",
    ),
};

export const ciListBindingsSchema = {
  project_id: z.string().describe("Project ID whose CI bindings should be listed."),
};

export const ciGetBindingSchema = {
  binding_id: z.string().describe("CI binding id, e.g. cib_..."),
};

export const ciRevokeBindingSchema = {
  binding_id: z.string().describe("CI binding id to revoke. Revocation stops future CI requests only."),
};

type ToolResult = Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

type CiBinding = {
  id: string;
  project_id?: string;
  provider?: string;
  subject_match?: string;
  allowed_events?: string[];
  allowed_actions?: string[];
  route_scopes?: string[];
  github_repository_id?: string | null;
  revoked_at?: string | null;
};

export async function handleCiCreateBinding(args: {
  project_id: string;
  provider?: "github-actions";
  subject_match: string;
  allowed_actions: Array<"deploy">;
  allowed_events: string[];
  route_scopes?: string[];
  github_repository_id?: string | null;
  expires_at?: string | null;
  nonce: string;
  signed_delegation: string;
}): ToolResult {
  try {
    const binding = await getSdk().ci.createBinding({
      project_id: args.project_id,
      provider: args.provider ?? "github-actions",
      subject_match: args.subject_match,
      allowed_actions: args.allowed_actions,
      allowed_events: args.allowed_events,
      route_scopes: args.route_scopes,
      github_repository_id: args.github_repository_id ?? null,
      expires_at: args.expires_at ?? null,
      nonce: args.nonce,
      signed_delegation: args.signed_delegation,
    });
    return bindingResult("CI Binding Created", binding);
  } catch (err) {
    return mapSdkError(err, "creating CI binding");
  }
}

export async function handleCiListBindings(args: { project_id: string }): ToolResult {
  try {
    const result = await getSdk().ci.listBindings({ project: args.project_id });
    const lines = [
      "## CI Bindings",
      "",
      `Project: \`${args.project_id}\``,
      `Returned: ${result.bindings.length}`,
      "",
    ];
    if (result.bindings.length === 0) {
      lines.push("No CI bindings found.");
    } else {
      lines.push(
        "| Binding | Subject | Route scopes | Revoked |",
        "|---------|---------|--------------|---------|",
      );
      for (const binding of result.bindings as CiBinding[]) {
        lines.push(
          `| \`${binding.id}\` | ${binding.subject_match ?? "(unknown)"} | ${formatRouteScopes(binding.route_scopes)} | ${binding.revoked_at ?? "no"} |`,
        );
      }
    }
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: rawJson("Raw bindings", result) },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "listing CI bindings");
  }
}

export async function handleCiGetBinding(args: { binding_id: string }): ToolResult {
  try {
    const binding = await getSdk().ci.getBinding(args.binding_id);
    return bindingResult("CI Binding", binding);
  } catch (err) {
    return mapSdkError(err, "getting CI binding");
  }
}

export async function handleCiRevokeBinding(args: { binding_id: string }): ToolResult {
  try {
    const binding = await getSdk().ci.revokeBinding(args.binding_id);
    return bindingResult("CI Binding Revoked", binding);
  } catch (err) {
    return mapSdkError(err, "revoking CI binding");
  }
}

function bindingResult(title: string, binding: CiBinding): {
  content: Array<{ type: "text"; text: string }>;
} {
  const lines = [
    `## ${title}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| binding_id | \`${binding.id}\` |`,
    `| project_id | ${binding.project_id ? `\`${binding.project_id}\`` : "(unknown)"} |`,
    `| provider | ${binding.provider ?? "github-actions"} |`,
    `| subject_match | ${binding.subject_match ?? "(unknown)"} |`,
    `| allowed_actions | ${(binding.allowed_actions ?? []).join(", ") || "(none)"} |`,
    `| allowed_events | ${(binding.allowed_events ?? []).join(", ") || "(none)"} |`,
    `| route_scopes | ${formatRouteScopes(binding.route_scopes)} |`,
    `| github_repository_id | ${binding.github_repository_id ?? "(none)"} |`,
    `| revoked_at | ${binding.revoked_at ?? "(active)"} |`,
  ];
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "text", text: rawJson("Raw binding", binding) },
    ],
  };
}

function formatRouteScopes(routeScopes: string[] | undefined): string {
  return routeScopes && routeScopes.length > 0
    ? routeScopes.map((scope) => `\`${scope}\``).join(", ")
    : "(none)";
}

function rawJson(title: string, value: unknown): string {
  return [`### ${title}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}
