import { z } from "zod";
import { getAllowancePath } from "../config.js";
import { readAllowance } from "../allowance.js";

export const allowanceStatusSchema = {};

export async function handleAllowanceStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const allowancePath = getAllowancePath();
  const allowance = readAllowance();

  if (!allowance) {
    return {
      content: [
        {
          type: "text",
          text: "No agent allowance found. Use `allowance_create` to create one.",
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
    `| funded | ${allowance.funded ? "yes" : "no"} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
