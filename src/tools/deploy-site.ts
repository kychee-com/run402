import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { LocalError } from "../../sdk/dist/index.js";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { updateProject } from "../keystore.js";

export const deploySiteSchema = {
  project: z
    .string()
    .describe("Project ID to link this deployment to"),
  target: z
    .string()
    .optional()
    .describe("Deprecated/unsupported: unified deploy v2 does not support deployment target labels. Passing this field returns an error."),
  files: z
    .array(
      z.object({
        file: z.string().describe("File path (e.g. 'index.html', 'assets/logo.png')"),
        data: z.string().describe("File content (text or base64-encoded)"),
        encoding: z
          .enum(["utf-8", "base64"])
          .optional()
          .describe("Encoding: 'utf-8' (default) for text, 'base64' for binary files"),
      }),
    )
    .describe("Array of files to deploy. Must include at least index.html."),
};

export async function handleDeploySite(args: {
  project: string;
  target?: string;
  files: Array<{ file: string; data: string; encoding?: string }>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (args.target !== undefined) {
    return mapSdkError(
      new LocalError(
        "`target` is unsupported by unified deploy v2 and would otherwise be ignored.",
        "deploying site",
      ),
      "deploying site",
    );
  }

  const auth = requireAllowanceAuth("/deploy/v2/plans");
  if ("error" in auth) return auth.error;

  // The SDK's inline-bytes overload is removed in v1.32 — every deploy goes
  // through the plan/commit transport, which reads from a directory. Stage
  // the inline files in a temp dir, run deployDir, then clean up.
  const stage = mkdtempSync(join(tmpdir(), "run402-deploy-stage-"));
  try {
    for (const f of args.files) {
      const target = join(stage, f.file);
      mkdirSync(dirname(target), { recursive: true });
      const buf = (f.encoding ?? "utf-8") === "base64"
        ? Buffer.from(f.data, "base64")
        : Buffer.from(f.data, "utf-8");
      writeFileSync(target, buf);
    }

    const body = await getSdk().sites.deployDir({
      project: args.project,
      dir: stage,
      target: args.target,
    });

    updateProject(args.project, { last_deployment_id: body.deployment_id });

    const lines = [
      `## Site Deployed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| deployment_id | \`${body.deployment_id}\` |`,
      `| url | ${body.url} |`,
      ``,
      `The site is live at **${body.url}**`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "deploying site");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
