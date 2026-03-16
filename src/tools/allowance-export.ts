import { z } from "zod";
import { readAllowance } from "../allowance.js";

export const allowanceExportSchema = {};

export async function handleAllowanceExport(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const allowance = readAllowance();

  if (!allowance) {
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

  return {
    content: [{ type: "text", text: allowance.address }],
  };
}
