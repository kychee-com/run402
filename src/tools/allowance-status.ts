import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { noAllowanceHint } from "../tool-profiles.js";

export const allowanceStatusSchema = {};

export async function handleAllowanceStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const allowance = await getSdk().allowance.status();

    if (!allowance.configured) {
      return {
        content: [
          {
            type: "text",
            text: noAllowanceHint(),
          },
        ],
      };
    }

    const lines = [
      `## Agent Allowance Status`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| address | \`${allowance.address}\` |`,
      `| created | ${allowance.created || "unknown"} |`,
      `| faucet_used | ${allowance.faucet_used ? "yes" : "no"} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading allowance status");
  }
}
