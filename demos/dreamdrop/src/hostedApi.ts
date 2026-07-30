import type {
  CreateDreamDropInput,
  DreamDrop,
  DreamDropFeed,
  EmailDreamDropResult,
} from "./shared";

export const IS_RUN402_HOSTED = import.meta.env.REACT_APP_RUN402_HOSTED === "true";

export async function getHostedFeed(): Promise<DreamDropFeed> {
  return request<DreamDropFeed>("/api/dreamdrops");
}

export async function createHostedDrop(input: CreateDreamDropInput): Promise<DreamDrop> {
  const result = await request<{ artifact: DreamDrop }>("/api/dreamdrops/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.artifact;
}

export async function remixHostedDrop(id: string): Promise<DreamDrop> {
  const result = await request<{ artifact: DreamDrop }>("/api/dreamdrops/remix", {
    method: "POST",
    body: JSON.stringify({ mode: "remix", parentId: id }),
  });
  return result.artifact;
}

export async function emailHostedDrop(id: string, email: string): Promise<EmailDreamDropResult> {
  return request<EmailDreamDropResult>("/api/dreamdrops/email", {
    method: "POST",
    body: JSON.stringify({ mode: "email", id, email }),
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(body?.error ?? `DreamDrop API returned HTTP ${response.status}.`);
  if (!body) throw new Error("DreamDrop API returned an empty response.");
  return body;
}
