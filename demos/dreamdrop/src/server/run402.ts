import { run402, type CredentialsProvider, type ProjectKeys } from "@run402/sdk";
import type { CreateDreamDropInput, DreamDrop, DreamDropFeed, EmailDreamDropResult } from "../shared";

interface DreamDropRow {
  id: string;
  parent_id: string | null;
  title: string;
  prompt: string;
  hook: string;
  vibe: DreamDrop["vibe"];
  image_url: string | null;
  art_key: string;
  palette: string[];
  remix_count: number;
  creator: string;
  payment_id: string | null;
  payment_payer: string | null;
  payment_amount_usd_micros: number | null;
  created_at: string;
}

const config = {
  apiBase: process.env.RUN402_API_BASE ?? "https://api.run402.com",
  projectId: process.env.RUN402_PROJECT_ID ?? "",
  anonKey: process.env.RUN402_ANON_KEY ?? "",
  serviceKey: process.env.RUN402_SERVICE_KEY ?? "",
  functionName: process.env.RUN402_GENERATOR_FUNCTION ?? "dreamdrop-generator",
  mailbox: process.env.RUN402_MAILBOX,
  agentEndpoint: process.env.RUN402_AGENT_ENDPOINT ?? "",
};

export const isRun402Configured = Boolean(config.projectId && config.anonKey && config.serviceKey);

let client: ReturnType<typeof run402> | null = null;

function getClient() {
  if (!isRun402Configured) throw new Error("Run402 is not configured.");
  if (client) return client;
  const keys: ProjectKeys = { anon_key: config.anonKey, service_key: config.serviceKey };
  const credentials: CredentialsProvider = {
    async getAuth() { return null; },
    async getProjectCredentials(id) { return id === config.projectId ? keys : null; },
  };
  client = run402({ apiBase: config.apiBase, credentials });
  return client;
}

export async function getRun402Feed(): Promise<DreamDropFeed> {
  const rows = await getClient().projects.rest<DreamDropRow[]>(config.projectId, "dreamdrops", {
    keyType: "service",
    query: "select=*&order=created_at.desc&limit=24",
  });
  return {
    drops: rows.map(rowToDrop),
    mode: "run402",
    statusLabel: "RUN402 CLOUD LIVE",
    agentEndpoint: config.agentEndpoint || "https://<your-subdomain>.run402.com/agent/remix",
    capabilities: ["Postgres", "Serverless", "AI image", "CDN assets", "x402", "Email"],
  };
}

export async function createRun402Drop(input: CreateDreamDropInput): Promise<DreamDrop> {
  const result = await getClient().functions.invoke(config.projectId, config.functionName, {
    body: { ...input },
    idempotencyKey: `dreamdrop:${crypto.randomUUID()}`,
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`Run402 generator returned HTTP ${result.status}.`);
  return parseFunctionDrop(result.body);
}

export async function remixRun402Drop(id: string): Promise<DreamDrop> {
  const result = await getClient().functions.invoke(config.projectId, config.functionName, {
    body: { mode: "remix", parentId: id },
    idempotencyKey: `dreamdrop-remix:${id}:${crypto.randomUUID()}`,
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`Run402 remix returned HTTP ${result.status}.`);
  return parseFunctionDrop(result.body);
}

export async function emailRun402Drop(id: string, email: string): Promise<EmailDreamDropResult> {
  const drop = (await getRun402Feed()).drops.find((item) => item.id === id);
  if (!drop) throw new Error("DreamDrop not found.");
  const result = await getClient().email.send(config.projectId, {
    to: email,
    mailbox: config.mailbox,
    from_name: "DreamDrop",
    subject: `${drop.title} just dropped`,
    html: renderEmail(drop),
    text: `${drop.title}\n\n${drop.hook}\n\n${drop.prompt}\n\nMade with Wasp × Run402.`,
  });
  return { status: "sent", message: `Sent via Run402 · ${result.message_id}` };
}

function parseFunctionDrop(body: unknown): DreamDrop {
  if (!body || typeof body !== "object" || !("drop" in body)) throw new Error("Run402 generator returned an invalid response.");
  return rowToDrop((body as { drop: DreamDropRow }).drop);
}

function rowToDrop(row: DreamDropRow): DreamDrop {
  const palette: DreamDrop["palette"] = Array.isArray(row.palette) && row.palette.length >= 3
    ? [row.palette[0], row.palette[1], row.palette[2]]
    : ["#ff6b57", "#d8ff5e", "#b9a7ff"];
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    prompt: row.prompt,
    hook: row.hook,
    vibe: row.vibe,
    imageUrl: row.image_url,
    artKey: row.art_key,
    palette,
    remixCount: row.remix_count,
    createdAt: row.created_at,
    createdLabel: relativeLabel(row.created_at),
    creator: row.creator,
    source: "run402",
    payment: row.payment_id ? {
      paymentId: row.payment_id,
      payer: row.payment_payer,
      amountUsdMicros: row.payment_amount_usd_micros ?? 0,
    } : null,
  };
}

function relativeLabel(value: string): string {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (ageMinutes < 1) return "JUST NOW";
  if (ageMinutes < 60) return `${ageMinutes} MIN AGO`;
  if (ageMinutes < 1_440) return `${Math.floor(ageMinutes / 60)} HRS AGO`;
  return `${Math.floor(ageMinutes / 1_440)} DAYS AGO`;
}

function renderEmail(drop: DreamDrop): string {
  const image = drop.imageUrl
    ? `<img src="${escapeHtml(drop.imageUrl)}" alt="" style="width:100%;border-radius:18px;display:block" />`
    : "";
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;background:#11110f;color:#f4efdf;padding:32px;border-radius:24px">${image}<p style="color:#d8ff5e;text-transform:uppercase;letter-spacing:.12em">DreamDrop</p><h1>${escapeHtml(drop.title)}</h1><p style="font-size:20px">${escapeHtml(drop.hook)}</p><p style="color:#b8b6aa">${escapeHtml(drop.prompt)}</p><p style="margin-top:32px;color:#77766f">Made with Wasp × Run402</p></div>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
