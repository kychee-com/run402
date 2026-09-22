import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getQuoteSchema = {};

export async function handleGetQuote(_args: Record<string, never>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const body = await getSdk().projects.getQuote();

    const lines = [
      `## Run402 Pricing`,
      ``,
      `| Tier | Price (USDC) | Lease | Storage | Vault | API Calls |`,
      `|------|-------------|-------|---------|-------|-----------|`,
    ];

    for (const [name, tier] of Object.entries(body.tiers)) {
      lines.push(
        `| ${name} | $${tier.price} | ${tier.lease_days === null ? "none (free tier)" : `${tier.lease_days}d`} | ${tier.storage} | ${tier.source} | ${(tier.api_calls / 1000).toFixed(0)}k |`,
      );
    }

    lines.push(``);
    lines.push(`Use \`provision_postgres_project\` to create a project, then \`deploy\` to ship releases.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "getting quote");
  }
}
