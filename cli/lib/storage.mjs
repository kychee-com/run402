import { readFileSync } from "fs";
import { findProject, API } from "./config.mjs";

const HELP = `run402 storage — Manage project file storage

Usage:
  run402 storage <subcommand> [args...]

Subcommands:
  upload   <id> <bucket> <path> [--file <local>] [--content-type <mime>]
                                       Upload a file to storage
  download <id> <bucket> <path>        Download a file from storage
  delete   <id> <bucket> <path>        Delete a file from storage
  list     <id> <bucket>               List files in a bucket

Examples:
  run402 storage upload abc123 assets logo.png --file ./logo.png --content-type image/png
  echo "hello" | run402 storage upload abc123 data notes.txt
  run402 storage download abc123 assets logo.png
  run402 storage list abc123 assets
  run402 storage delete abc123 assets logo.png

Notes:
  - <id> is the project_id from 'run402 projects list'
  - Upload reads from --file or stdin if no --file is given
`;

const SUB_HELP = {
  upload: `run402 storage upload — Upload a file to a project's storage bucket

Usage:
  run402 storage upload <id> <bucket> <path> [--file <local>] [--content-type <mime>]
  echo "..." | run402 storage upload <id> <bucket> <path> [--content-type <mime>]

Arguments:
  <id>                Project ID (from 'run402 projects list')
  <bucket>            Target bucket name
  <path>              Destination path within the bucket

Options:
  --file <local>      Local file to upload; if omitted, content is read from stdin
  --content-type <mime>  MIME type of the upload (default: text/plain)

Examples:
  run402 storage upload abc123 assets logo.png --file ./logo.png \\
    --content-type image/png
  echo "hello" | run402 storage upload abc123 data notes.txt
`,
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function upload(projectId, bucket, path, args) {
  const p = findProject(projectId);
  const opts = { file: null, contentType: "text/plain" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) opts.file = args[++i];
    if (args[i] === "--content-type" && args[i + 1]) opts.contentType = args[++i];
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

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "upload":   await upload(args[0], args[1], args[2], args.slice(3)); break;
    case "download": await download(args[0], args[1], args[2]); break;
    case "delete":   await deleteFile(args[0], args[1], args[2]); break;
    case "list":     await list(args[0], args[1]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
