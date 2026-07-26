import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const requestMagicLinkSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address to authenticate"),
  delivery: z.enum(["link", "code", "both"]).optional().describe("Email credential mode. Defaults to link."),
  redirect_url: z.string().optional().describe("Allowed redirect URL. Required for link/both; optional for code."),
  intent: z.enum(["signin", "invite", "claim", "recovery"]).optional().describe("Magic-link intent. invite requires the service key and creates trusted invite state."),
  client_state: z.any().optional().describe("Optional opaque app state preserved through token verification"),
};

export async function handleRequestMagicLink(args: {
  project_id: string;
  email: string;
  delivery?: "link" | "code" | "both";
  redirect_url?: string;
  intent?: "signin" | "invite" | "claim" | "recovery";
  client_state?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const delivery = args.delivery ?? "link";
    if (delivery !== "code" && !args.redirect_url) {
      throw new Error("redirect_url is required for link or both delivery");
    }
    const common = {
      email: args.email,
      intent: args.intent,
      clientState: args.client_state,
    };
    const result = delivery === "code"
      ? await getSdk().auth.requestMagicLink(args.project_id, {
        ...common,
        delivery,
        redirectUrl: args.redirect_url,
      })
      : await getSdk().auth.requestMagicLink(args.project_id, {
        ...common,
        delivery,
        redirectUrl: args.redirect_url!,
      });
    return {
      content: [
        {
          type: "text",
          text: [
            "## Email Authentication Request Accepted",
            "",
            `- **Email:** ${args.email}`,
            `- **Delivery:** ${delivery}`,
            ...(args.redirect_url ? [`- **Redirect:** ${args.redirect_url}`] : []),
            ...(result.challengeId ? [`- **Challenge ID:** \`${result.challengeId}\``] : []),
            "",
            result.message || "Run402 accepted the request.",
            "Acceptance does not prove delivery or disclose whether an account exists.",
            ...(result.warnings?.length
              ? ["", "### Warnings", ...result.warnings.map((warning) => `- **${warning.code}:** ${warning.message}`)]
              : []),
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "requesting magic link");
  }
}
