import type { ProjectKeys } from "./credentials.js";
import type { Client } from "./kernel.js";
import { ProjectCredentialNotFound } from "./errors.js";

export async function requireProjectCredentials(
  client: Client,
  projectId: string,
  context: string,
): Promise<ProjectKeys> {
  const project = await client.getProjectCredentials(projectId);
  if (project) return project;
  const info = client.credentials.getProjectCredentialCacheInfo?.();
  throw new ProjectCredentialNotFound(projectId, context, (info ?? {}) as unknown as Record<string, unknown>);
}
