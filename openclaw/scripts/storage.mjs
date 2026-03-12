#!/usr/bin/env node
/**
 * Run402 storage manager — upload, download, list, delete files.
 *
 * Usage:
 *   node storage.mjs upload <project_id> <bucket> <path> [--file <local>] [--content-type <mime>]
 *   node storage.mjs download <project_id> <bucket> <path>
 *   node storage.mjs list <project_id> <bucket>
 *   node storage.mjs delete <project_id> <bucket> <path>
 */

import { readFileSync } from "fs";
import { findProject, API } from "./config.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function upload(projectId, bucket, path, extraArgs) {
  const p = findProject(projectId);
  const opts = { file: null, contentType: "text/plain" };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--file" && extraArgs[i + 1]) opts.file = extraArgs[++i];
    if (extraArgs[i] === "--content-type" && extraArgs[i + 1]) opts.contentType = extraArgs[++i];
  }
  const content = opts.file ? readFileSync(opts.file, "utf-8") : await readStdin();
  const res = await fetch(`${API}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: { "Content-Type": opts.contentType, "apikey": p.anon_key, "Authorization": `Bearer ${p.anon_key}` },
    body: content,
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function download(projectId, bucket, path) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/storage/v1/object/${bucket}/${path}`, {
    headers: { "apikey": p.anon_key, "Authorization": `Bearer ${p.anon_key}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
  const text = await res.text();
  process.stdout.write(text);
}

async function deleteFile(projectId, bucket, path) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/storage/v1/object/${bucket}/${path}`, {
    method: "DELETE",
    headers: { "apikey": p.anon_key, "Authorization": `Bearer ${p.anon_key}` },
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `File '${bucket}/${path}' deleted.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

async function list(projectId, bucket) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/storage/v1/object/list/${bucket}`, {
    headers: { "apikey": p.anon_key, "Authorization": `Bearer ${p.anon_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "upload": await upload(args[0], args[1], args[2], args.slice(3)); break;
  case "download": await download(args[0], args[1], args[2]); break;
  case "list": await list(args[0], args[1]); break;
  case "delete": await deleteFile(args[0], args[1], args[2]); break;
  default:
    console.log("Usage: node storage.mjs <upload|download|list|delete> [args...]");
    process.exit(1);
}
