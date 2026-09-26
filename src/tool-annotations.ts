import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations for the eight tools, the hints a host reads before a
 * call: `title`, `readOnlyHint`, `destructiveHint` (and `idempotentHint` /
 * `openWorldHint` where they carry information). The Anthropic directory
 * policy requires all applicable annotations; `sync.test.ts` pins that every
 * tool in `MCP_TOOLS` has a complete entry here.
 *
 * `up`, `deploy` and `run` can replace a live release, delete files, secrets
 * or resources, and pay for a tier or a paid call, so they are destructive
 * and never read-only.
 */
export const TOOL_ANNOTATIONS = {
  up: {
    title: "Set up and deploy an app",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  deploy: {
    title: "Deploy a release",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  status: {
    title: "Show organization status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  whoami: {
    title: "Show remote identity",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  doctor: {
    title: "Run diagnostics",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  docs: {
    title: "Read the SDK reference",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: {
    title: "Run an SDK snippet",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  expand_result: {
    title: "Page through a stored result",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} satisfies Record<string, ToolAnnotations & { title: string; readOnlyHint: boolean; destructiveHint: boolean }>;
