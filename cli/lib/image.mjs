import { writeFileSync } from "fs";
import { API, ALLOWANCE_FILE } from "./config.mjs";
import { setupPaidFetch } from "./paid-fetch.mjs";

const HELP = `run402 image — Generate AI images via x402 micropayments

Usage:
  run402 image generate "<prompt>" [options]

Options:
  --aspect <ratio>    Image aspect ratio: square | landscape | portrait  (default: square)
  --output <file>     Save image to file (e.g. output.png)
                      If omitted, returns base64 JSON to stdout
  --help, -h          Show this help message

Examples:
  run402 image generate "a startup mascot, pixel art"
  run402 image generate "futuristic city at night" --aspect landscape
  run402 image generate "portrait of a cat CEO" --aspect portrait --output cat.png

Output (without --output):
  { "status": "ok", "aspect": "square", "content_type": "image/png", "image": "<base64>" }

Notes:
  - Requires a funded allowance (run402 allowance create && run402 allowance fund)
  - Payments are processed automatically via x402 micropayments (Base Sepolia USDC)
  - Use --output to save directly to a file instead of printing base64
`;

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (sub !== "generate") {
    console.error(`Unknown subcommand: ${sub}\n`);
    console.log(HELP);
    process.exit(1);
  }

  const opts = { prompt: null, aspect: "square", output: null };
  let i = 0;
  if (i < args.length && !args[i].startsWith("--")) opts.prompt = args[i++];
  while (i < args.length) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(HELP); process.exit(0); }
    else if (args[i] === "--aspect" && args[i + 1]) { opts.aspect = args[++i]; }
    else if (args[i] === "--output" && args[i + 1]) { opts.output = args[++i]; }
    i++;
  }

  if (!opts.prompt) { console.error(JSON.stringify({ status: "error", message: "Prompt required. Usage: run402 image generate \"your prompt\"" })); process.exit(1); }

  const fetchPaid = await setupPaidFetch();

  const res = await fetchPaid(`${API}/generate-image/v1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: opts.prompt, aspect: opts.aspect }) });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }

  if (opts.output) {
    const buf = Buffer.from(data.image, "base64");
    writeFileSync(opts.output, buf);
    console.log(JSON.stringify({ status: "ok", file: opts.output, size: buf.length, aspect: data.aspect }));
  } else {
    console.log(JSON.stringify({ status: "ok", aspect: data.aspect, content_type: data.content_type, image: data.image }));
  }
}
