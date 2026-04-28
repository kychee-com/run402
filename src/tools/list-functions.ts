import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) {
    const abs = -diff;
    if (abs < 60_000) return "in <1m";
    if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`;
    return `in ${Math.round(abs / 86_400_000)}d`;
  }
  if (diff < 60_000) return "<1m ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export const listFunctionsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListFunctions(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().functions.list(args.project_id);

    if (body.functions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Functions\n\n_No functions deployed. Use \`deploy_function\` to deploy one._`,
          },
        ],
      };
    }

    const lines = [
      `## Functions (${body.functions.length})`,
      ``,
      `| Name | URL | Runtime | Schedule | Next Run | Last Run | Runs | Status |`,
      `|------|-----|---------|----------|----------|----------|------|--------|`,
    ];

    const errors: string[] = [];

    for (const fn of body.functions) {
      const meta = fn.schedule_meta;
      const schedule = fn.schedule ? `\`${fn.schedule}\`` : "—";
      const nextRun = meta?.next_run_at ? formatRelative(meta.next_run_at) : "—";
      const lastRun = meta?.last_run_at ? formatRelative(meta.last_run_at) : "—";
      const runs = meta?.run_count != null ? String(meta.run_count) : "—";
      const status = meta?.last_status != null ? String(meta.last_status) : "—";
      lines.push(
        `| ${fn.name} | ${fn.url} | ${fn.runtime} | ${schedule} | ${nextRun} | ${lastRun} | ${runs} | ${status} |`,
      );
      if (meta?.last_error) {
        errors.push(`**${fn.name}**: ${meta.last_error}`);
      }
    }

    if (errors.length > 0) {
      lines.push(``);
      lines.push(`### Schedule Errors`);
      for (const err of errors) {
        lines.push(`- ${err}`);
      }
    }

    // "Functions runtime version" labels the bundled @run402/functions
    // version — never bare "runtime", which collides with the existing
    // runtime: "node22" field. Legacy functions (deployed before the
    // bundling-at-deploy regime) have null for both fields and are omitted
    // from this section.
    const withRuntime = body.functions.filter((fn) => fn.runtime_version != null);
    if (withRuntime.length > 0) {
      lines.push(``);
      lines.push(`### Functions runtime version & resolved deps`);
      for (const fn of withRuntime) {
        const depsCount = Object.keys(fn.deps_resolved ?? {}).length;
        const depsBit = depsCount > 0
          ? `, ${depsCount} resolved dep${depsCount === 1 ? "" : "s"}`
          : "";
        lines.push(`- **${fn.name}** — \`@run402/functions@${fn.runtime_version}\`${depsBit}`);
        if (fn.deps_resolved && depsCount > 0) {
          for (const [name, version] of Object.entries(fn.deps_resolved)) {
            lines.push(`  - \`${name}@${version}\``);
          }
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing functions");
  }
}
