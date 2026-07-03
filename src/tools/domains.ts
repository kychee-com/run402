import { z } from "zod";

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const desiredSchema = z
  .record(z.unknown())
  .describe("Desired ProjectDomain state: web, email.send, email.receive, mailbox_addresses, and activation.");

export const domainsEnsureSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
  desired: desiredSchema,
};

export const domainsGetSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export const domainsListSchema = {
  project_id: z.string().describe("The project ID"),
};

export const domainsCheckSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export const domainsApplySchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export const domainsRepairSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export const domainsTestReceiveSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
  to: z.string().describe("Local part or address to send the receive test to, e.g. info or info@kysigned.com"),
};

export const domainsActivateSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export const domainsDisconnectSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The DNS domain, e.g. kysigned.com"),
};

export async function handleDomainsEnsure(args: {
  project_id: string;
  domain: string;
  desired: Record<string, unknown>;
}): Promise<ToolResult> {
  try {
    const result = await getSdk().domains.ensure(args.project_id, args.domain, {
      desired: args.desired,
    });
    return jsonToolResult("Project Domain Ensured", result);
  } catch (err) {
    return mapSdkError(err, "ensuring project domain");
  }
}

export async function handleDomainsGet(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domain", await getSdk().domains.get(args.project_id, args.domain));
  } catch (err) {
    return mapSdkError(err, "getting project domain");
  }
}

export async function handleDomainsList(args: { project_id: string }): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domains", await getSdk().domains.list(args.project_id));
  } catch (err) {
    return mapSdkError(err, "listing project domains");
  }
}

export async function handleDomainsCheck(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domain Check", await getSdk().domains.check(args.project_id, args.domain));
  } catch (err) {
    return mapSdkError(err, "checking project domain");
  }
}

export async function handleDomainsApply(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domain Apply", await getSdk().domains.apply(args.project_id, args.domain));
  } catch (err) {
    return mapSdkError(err, "applying project domain");
  }
}

export async function handleDomainsRepair(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domain Repair", await getSdk().domains.repair(args.project_id, args.domain));
  } catch (err) {
    return mapSdkError(err, "repairing project domain");
  }
}

export async function handleDomainsTestReceive(args: {
  project_id: string;
  domain: string;
  to: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult(
      "Project Domain Receive Test",
      await getSdk().domains.testReceive(args.project_id, args.domain, args.to),
    );
  } catch (err) {
    return mapSdkError(err, "creating project domain receive test");
  }
}

export async function handleDomainsActivate(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult(
      "Project Domain Mailbox Activation",
      await getSdk().domains.activate(args.project_id, args.domain),
    );
  } catch (err) {
    return mapSdkError(err, "activating project domain mailbox addresses");
  }
}

export async function handleDomainsDisconnect(args: {
  project_id: string;
  domain: string;
}): Promise<ToolResult> {
  try {
    return jsonToolResult("Project Domain Disconnected", await getSdk().domains.disconnect(args.project_id, args.domain));
  } catch (err) {
    return mapSdkError(err, "disconnecting project domain");
  }
}

function jsonToolResult(title: string, value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n"),
      },
    ],
  };
}
