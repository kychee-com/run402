import { getSdk } from "../sdk.js";
import { noAllowanceHint } from "../tool-profiles.js";

export const allowanceExportSchema = {};

export async function handleAllowanceExport(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const address = await getSdk().allowance.export();
    return { content: [{ type: "text", text: address }] };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: noAllowanceHint(),
        },
      ],
      isError: true,
    };
  }
}
