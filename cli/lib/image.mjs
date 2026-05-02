import { writeFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

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

const SUB_HELP = {
  generate: `run402 image generate — Generate an AI image from a text prompt

Usage:
  run402 image generate "<prompt>" [options]

Arguments:
  <prompt>            Text prompt describing the image (quote it)

Options:
  --aspect <ratio>    Image aspect ratio: square | landscape | portrait
                      (default: square)
  --output <file>     Save image to file (e.g. output.png). If omitted,
                      returns base64 JSON to stdout.

Notes:
  - Requires a funded allowance (run402 allowance create && run402 allowance fund)
  - Payments are processed automatically via x402 micropayments
  - Use --output to save directly to a file instead of printing base64

Examples:
  run402 image generate "a startup mascot, pixel art"
  run402 image generate "futuristic city at night" --aspect landscape
  run402 image generate "portrait of a cat CEO" --aspect portrait --output cat.png
`,
};

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
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
    if (args[i] === "--help" || args[i] === "-h") { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
    else if (args[i] === "--aspect" && args[i + 1]) { opts.aspect = args[++i]; }
    else if (args[i] === "--output" && args[i + 1]) { opts.output = args[++i]; }
    i++;
  }

  if (!opts.prompt) {
    fail({
      code: "BAD_USAGE",
      message: "Prompt required.",
      hint: 'run402 image generate "your prompt"',
    });
  }

  try {
    const data = await getSdk().ai.generateImage({ prompt: opts.prompt, aspect: opts.aspect });
    if (opts.output) {
      const buf = Buffer.from(data.image, "base64");
      writeFileSync(opts.output, buf);
      console.log(JSON.stringify({ status: "ok", file: opts.output, size: buf.length, aspect: data.aspect }));
    } else {
      console.log(JSON.stringify({ status: "ok", aspect: data.aspect, content_type: data.content_type, image: data.image }));
    }
  } catch (err) {
    reportSdkError(err);
  }
}
