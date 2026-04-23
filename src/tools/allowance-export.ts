import { getSdk } from "../sdk.js";

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
          text: "No agent allowance found. Use `allowance_create` to create one.",
        },
      ],
      isError: true,
    };
  }
}
