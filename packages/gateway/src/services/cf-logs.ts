/**
 * CloudFront access-log parser for the run402.com site distribution.
 * Reads gzipped log files from S3, parses them, and caches aggregated stats.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { S3_REGION } from "../config.js";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

const LOG_BUCKET = process.env.CF_LOG_BUCKET || "";
const LOG_PREFIX = process.env.CF_LOG_PREFIX || "cf-logs/";
const CACHE_TTL = 5 * 60_000; // 5 minutes

const s3 = LOG_BUCKET ? new S3Client({ region: S3_REGION }) : null;

interface LogEntry {
  date: string;
  time: string;
  path: string;
  status: number;
  userAgent: string;
  ip: string;
  method: string;
  bytes: number;
}

export interface CfLogStats {
  available: boolean;
  totalRequests: number;
  firstLog: string | null;
  lastLog: string | null;
  agentFiles: { path: string; hits: number }[];
  daily: { date: string; path: string; hits: number }[];
  hourly24h: { hour: string; hits: number }[];
  userAgents: { agent: string; hits: number; category: string }[];
  uniqueIps: number;
  last24h: {
    llmsTxt: number;
    openapiJson: number;
    uniqueIps: number;
  };
  allTime: {
    llmsTxt: number;
    openapiJson: number;
    statusJson: number;
  };
}

let cache: { data: CfLogStats; ts: number } | null = null;

const AGENT_PATHS = new Set(["/llms.txt", "/openapi.json", "/status/v1.json", "/robots.txt"]);

function categorizeUserAgent(ua: string): string {
  const lower = ua.toLowerCase();
  if (lower === "node" || lower === "-") return "internal";
  if (lower.includes("bot") || lower.includes("crawler") || lower.includes("spider")) return "bot";
  if (lower.includes("curl")) return "curl";
  if (lower.includes("python") || lower.includes("httpx") || lower.includes("requests")) return "python";
  if (lower.includes("axios") || lower.includes("node-fetch") || lower.includes("undici")) return "node-client";
  if (lower.includes("ktor") || lower.includes("okhttp") || lower.includes("java")) return "jvm";
  if (lower.includes("go-http") || lower.includes("golang")) return "go";
  if (lower.includes("rust") || lower.includes("reqwest") || lower.includes("hyper")) return "rust";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  if (lower.includes("openai") || lower.includes("gpt")) return "openai";
  if (lower.includes("mozilla") || lower.includes("chrome") || lower.includes("safari") || lower.includes("firefox")) return "browser";
  return "other";
}

async function streamToString(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function decompressGzip(data: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    gunzip.on("error", reject);
    gunzip.end(data);
  });
}

function parseLogLine(line: string): LogEntry | null {
  if (line.startsWith("#") || !line.trim()) return null;
  const fields = line.split("\t");
  if (fields.length < 13) return null;
  return {
    date: fields[0],
    time: fields[1],
    path: fields[7],
    status: parseInt(fields[8], 10),
    userAgent: decodeURIComponent(fields[10].replace(/%22/g, "").replace(/\+/g, " ")),
    ip: fields[4],
    method: fields[5],
    bytes: parseInt(fields[3], 10) || 0,
  };
}

async function fetchAndParseLogs(): Promise<LogEntry[]> {
  if (!s3 || !LOG_BUCKET) return [];

  const entries: LogEntry[] = [];
  let continuationToken: string | undefined;

  // List all log files
  const keys: string[] = [];
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: LOG_BUCKET,
      Prefix: LOG_PREFIX,
      ContinuationToken: continuationToken,
    }));
    for (const obj of list.Contents || []) {
      if (obj.Key && obj.Key.endsWith(".gz")) keys.push(obj.Key);
    }
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  // Download and parse in batches of 20
  const BATCH = 20;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (key) => {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: LOG_BUCKET, Key: key }));
        const compressed = await streamToString(obj.Body as Readable);
        const text = await decompressGzip(compressed);
        const lines = text.split("\n");
        const batchEntries: LogEntry[] = [];
        for (const line of lines) {
          const entry = parseLogLine(line);
          if (entry) batchEntries.push(entry);
        }
        return batchEntries;
      } catch {
        return [];
      }
    }));
    for (const batch of results) entries.push(...batch);
  }

  return entries;
}

function aggregateStats(entries: LogEntry[]): CfLogStats {
  if (entries.length === 0) {
    return {
      available: false,
      totalRequests: 0,
      firstLog: null,
      lastLog: null,
      agentFiles: [],
      daily: [],
      hourly24h: [],
      userAgents: [],
      uniqueIps: 0,
      last24h: { llmsTxt: 0, openapiJson: 0, uniqueIps: 0 },
      allTime: { llmsTxt: 0, openapiJson: 0, statusJson: 0 },
    };
  }

  // Filter to agent-relevant paths only
  const agentEntries = entries.filter(e => AGENT_PATHS.has(e.path));

  // All-time path counts
  const pathCounts = new Map<string, number>();
  for (const e of agentEntries) {
    pathCounts.set(e.path, (pathCounts.get(e.path) || 0) + 1);
  }

  // Daily breakdown (agent paths only)
  const dailyMap = new Map<string, number>();
  for (const e of agentEntries) {
    const key = `${e.date}|${e.path}`;
    dailyMap.set(key, (dailyMap.get(key) || 0) + 1);
  }
  const daily = [...dailyMap.entries()]
    .map(([k, hits]) => {
      const [date, path] = k.split("|");
      return { date, path, hits };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));

  // Last 24h
  const now = new Date();
  const h24ago = new Date(now.getTime() - 24 * 3600_000);
  const recent = agentEntries.filter(e => {
    const t = new Date(`${e.date}T${e.time}Z`);
    return t >= h24ago;
  });

  const recentIps = new Set(recent.map(e => e.ip));

  // Hourly breakdown (last 24h, llms.txt + openapi.json)
  const hourlyMap = new Map<string, number>();
  for (const e of recent) {
    if (e.path !== "/llms.txt" && e.path !== "/openapi.json") continue;
    const hour = `${e.date}T${e.time.slice(0, 2)}:00`;
    hourlyMap.set(hour, (hourlyMap.get(hour) || 0) + 1);
  }
  // Fill missing hours
  const hourly: { hour: string; hits: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600_000);
    const dateStr = t.toISOString().slice(0, 10);
    const hourStr = t.toISOString().slice(11, 13);
    const key = `${dateStr}T${hourStr}:00`;
    hourly.push({ hour: key, hits: hourlyMap.get(key) || 0 });
  }

  // User-agent breakdown (llms.txt only)
  const uaMap = new Map<string, number>();
  for (const e of agentEntries) {
    if (e.path !== "/llms.txt") continue;
    // Truncate long user-agent strings
    const ua = e.userAgent.length > 80 ? e.userAgent.slice(0, 77) + "..." : e.userAgent;
    uaMap.set(ua, (uaMap.get(ua) || 0) + 1);
  }
  const userAgents = [...uaMap.entries()]
    .map(([agent, hits]) => ({ agent, hits, category: categorizeUserAgent(agent) }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 30);

  // Unique IPs across all agent file requests
  const allIps = new Set(agentEntries.map(e => e.ip));

  // Dates
  const dates = entries.map(e => e.date).sort();

  return {
    available: true,
    totalRequests: entries.length,
    firstLog: dates[0],
    lastLog: dates[dates.length - 1],
    agentFiles: [...pathCounts.entries()]
      .map(([path, hits]) => ({ path, hits }))
      .sort((a, b) => b.hits - a.hits),
    daily,
    hourly24h: hourly,
    userAgents,
    uniqueIps: allIps.size,
    last24h: {
      llmsTxt: recent.filter(e => e.path === "/llms.txt").length,
      openapiJson: recent.filter(e => e.path === "/openapi.json").length,
      uniqueIps: recentIps.size,
    },
    allTime: {
      llmsTxt: pathCounts.get("/llms.txt") || 0,
      openapiJson: pathCounts.get("/openapi.json") || 0,
      statusJson: pathCounts.get("/status/v1.json") || 0,
    },
  };
}

export async function getCfLogStats(): Promise<CfLogStats> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  try {
    const entries = await fetchAndParseLogs();
    const stats = aggregateStats(entries);
    cache = { data: stats, ts: Date.now() };
    return stats;
  } catch (err) {
    console.error("[cf-logs] Failed to fetch logs:", err);
    return {
      available: false,
      totalRequests: 0,
      firstLog: null,
      lastLog: null,
      agentFiles: [],
      daily: [],
      hourly24h: [],
      userAgents: [],
      uniqueIps: 0,
      last24h: { llmsTxt: 0, openapiJson: 0, uniqueIps: 0 },
      allTime: { llmsTxt: 0, openapiJson: 0, statusJson: 0 },
    };
  }
}
