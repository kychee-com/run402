import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { BuzzEventRoute, BuzzEventRouteDetail } from "../../sdk/dist/index.js";

/**
 * Read-only status for Buzz project-event routes.
 *
 * One tool covers both reads (the get_escalation precedent): pass
 * buzz_project_event_route_id for one route's honest health, omit it (with
 * org_id) to list the organization's routes. Every mutation stays on the
 * CLI/SDK boundary — the formatter hands back the exact command instead.
 */
export const getBuzzRouteSchema = {
  buzz_project_event_route_id: z
    .string()
    .optional()
    .describe("The route (buzzper_…) to inspect. Omit to list the organization's routes instead."),
  org_id: z
    .string()
    .optional()
    .describe("Organization (bare dashed UUID). Required when listing; ignored when a route id is given."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function filterLine(route: BuzzEventRoute): string {
  const types = route.event_types === null ? "every registered type" : route.event_types.join(", ");
  const classes = route.event_classes === null ? "every non-forbidden class" : route.event_classes.join(", ");
  return `Filters: types = ${types}; classes = ${classes}`;
}

function detailLines(route: BuzzEventRouteDetail): string[] {
  const lines = [
    `${route.buzz_project_event_route_id} — ${route.route_name}`,
    `Health: ${route.health} (status ${route.status}${route.pause_reason ? `, pause_reason ${route.pause_reason}` : ""})`,
    `Channel: ${route.buzz_channel_id} on installation ${route.buzz_community_installation_id}`,
    `Projects: ${route.project_ids.join(", ")}`,
    filterLine(route),
    `Signing: generation ${route.signing_generation}, notification_pubkey ${route.notification_pubkey} (public by design; the signing secret never leaves the gateway)`,
    `Revision: ${route.revision} (echo as expected_revision on update)`,
  ];

  const counts = Object.entries(route.delivery_counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status} ${n}`);
  lines.push(`Deliveries: ${counts.length > 0 ? counts.join(", ") : "none yet"}`);
  if (route.oldest_pending_created_at) {
    lines.push(`Oldest pending since ${route.oldest_pending_created_at} — the publisher tick runs ~every 60s; silence is cadence, not failure.`);
  }

  lines.push("");
  if (route.health === "pending_authorization") {
    lines.push(
      "PENDING BUZZ AUTHORIZATION — a Buzz community owner or admin must add the notification_pubkey above as a relay member (their own Buzz key lives in Buzz Desktop → Settings → Profile → Identity).",
      `Then verify it landed: run402 buzz notifications test ${route.buzz_project_event_route_id} --wait`,
    );
  } else if (route.health === "paused" && route.pause_reason === "delivery_failures") {
    lines.push(
      `Auto-paused after ${route.consecutive_hard_failures} consecutive hard failures. Inspect list_buzz_route_deliveries, fix the Buzz side, then: run402 buzz notifications resume ${route.buzz_project_event_route_id}`,
    );
  } else if (route.health === "paused") {
    lines.push(`Paused by the owner. Re-arm with: run402 buzz notifications resume ${route.buzz_project_event_route_id}`);
  } else if (route.health === "signing_unavailable") {
    lines.push(
      `Signing credential unavailable — rotate to stage a fresh one: run402 buzz notifications rotate ${route.buzz_project_event_route_id}`,
    );
  } else if (route.health === "revoked") {
    lines.push(`Revoked ${route.revoked_at} — sanitized history stays readable; only mutations reject it.`);
  }
  lines.push(
    "Mutations are CLI-only: run402 buzz notifications configure|pause|resume|rotate|revoke … (owner auth + step-up; zero spend impact).",
  );
  return lines;
}

export async function handleGetBuzzRoute(args: {
  buzz_project_event_route_id?: string;
  org_id?: string;
}): Promise<McpResult> {
  try {
    const sdk = getSdk();

    if (!args.buzz_project_event_route_id) {
      if (!args.org_id) {
        return {
          content: [
            {
              type: "text",
              text: "Pass buzz_project_event_route_id for one route, or org_id (bare dashed UUID) to list the organization's routes.",
            },
          ],
          isError: true,
        };
      }
      const routes = await sdk.buzz.notifications.list(args.org_id);
      if (routes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No Buzz event routes. Create one on the CLI: run402 buzz notifications configure --org <uuid> --installation <buzzci_id> --name <route_name> --channel <nip29-channel-id> --project <id>",
            },
          ],
        };
      }
      const lines = routes.map(
        (r) =>
          `${r.buzz_project_event_route_id}  ${r.status.padEnd(22)} ${r.route_name} → channel ${r.buzz_channel_id} (${r.project_ids.length} project${r.project_ids.length === 1 ? "" : "s"})`,
      );
      lines.push("", "Pass buzz_project_event_route_id for a route's honest health and delivery counts.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const route = await sdk.buzz.notifications.get(args.buzz_project_event_route_id);
    return { content: [{ type: "text", text: detailLines(route).join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading a Buzz event route");
  }
}
