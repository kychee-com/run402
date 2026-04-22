import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, loadKeyStore, saveKeyStore } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteMailboxSchema = {
  project_id: z.string().describe("The project ID"),
  mailbox_id: z
    .string()
    .optional()
    .describe(
      "Mailbox ID to delete (mbx_...). If omitted, resolves the project's mailbox from the keystore or via GET /mailboxes/v1.",
    ),
  confirm: z
    .boolean()
    .describe(
      "Must be true. Destructive: deleting a mailbox drops all messages and webhook subscriptions and is irreversible.",
    ),
};

export async function handleDeleteMailbox(args: {
  project_id: string;
  mailbox_id?: string;
  confirm: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  if (args.confirm !== true) {
    return {
      content: [
        {
          type: "text",
          text: "Error: `confirm` must be `true` to delete a mailbox. Deletion is irreversible (drops all messages and webhook subscriptions).",
        },
      ],
      isError: true,
    };
  }

  let mailboxId = args.mailbox_id;

  if (!mailboxId) {
    const cached = (project as unknown as Record<string, unknown>).mailbox_id;
    if (typeof cached === "string" && cached.length > 0) {
      mailboxId = cached;
    } else {
      const mbRes = await apiRequest(`/mailboxes/v1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${project.service_key}` },
      });
      if (!mbRes.ok) return formatApiError(mbRes, "looking up mailbox");
      const raw = mbRes.body as
        | { mailboxes?: Array<{ mailbox_id: string }> }
        | Array<{ mailbox_id: string }>;
      const list = Array.isArray(raw) ? raw : (raw.mailboxes || []);
      if (list.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No mailbox found for this project — nothing to delete.",
            },
          ],
          isError: true,
        };
      }
      mailboxId = list[0]!.mailbox_id;
    }
  }

  const res = await apiRequest(`/mailboxes/v1/${mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!res.ok && res.status !== 204) return formatApiError(res, "deleting mailbox");

  // Clear the cached mailbox_id/address so future email tools re-discover
  // (or fail-fast with "no mailbox found") instead of hitting a stale ID.
  const store = loadKeyStore();
  const proj = store.projects[args.project_id] as unknown as Record<string, unknown> | undefined;
  if (proj) {
    delete proj.mailbox_id;
    delete proj.mailbox_address;
    saveKeyStore(store);
  }

  return {
    content: [{ type: "text", text: `Mailbox \`${mailboxId}\` deleted.` }],
  };
}
