import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const allowanceCreateSchema = {};

export async function handleAllowanceCreate(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().allowance.create();

    const lines = [
      `## Agent Allowance Created`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| address | \`${result.address}\` |`,
      `| saved to | \`${result.path ?? "(local path unknown)"}\` |`,
      ``,
      `Use \`request_faucet\` to fund it with testnet USDC, or send USDC on any supported chain.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    // "Allowance already exists" is a user-facing condition, not a system error.
    const msg = (err as Error)?.message ?? "";
    if (/already exists/i.test(msg)) {
      return {
        content: [
          {
            type: "text",
            text: msg + "\n\nUse `allowance_status` to check details.",
          },
        ],
        isError: true,
      };
    }
    return mapSdkError(err, "creating allowance");
  }
}
