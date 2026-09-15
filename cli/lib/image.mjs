import { writeFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 image — Generate AI images via x402 micropayments

Usage:
  run402 image generate "<prompt>" [options]

Options:
  --aspect <ratio>    Image aspect ratio: square | landscape | portrait  (default: square)
  --output <file>     Save image to file (e.g. output.png)
                      If omitted, returns base64 JSON to stdout
  --org <org_id>      The paying organization when the wallet belongs to more
                      than one (Lightning rail); x402 ignores it
  --help, -h          Show this help message

Examples:
  run402 image generate "a startup mascot, pixel art"
  run402 image generate "futuristic city at night" --aspect landscape
  run402 image generate "portrait of a cat CEO" --aspect portrait --output cat.png

Output (without --output):
  { "aspect": "square", "content_type": "image/png", "image": "<base64>" }

Notes:
  - Requires a funded allowance (run402 allowance create && run402 allowance fund)
  - Payments are processed automatically via x402 micropayments (USDC on the
    network your allowance targets — Base Sepolia on the prototype tier, Base
    mainnet on paid tiers) or over Lightning from a rail: lightning wallet
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
  --org <org_id>      The paying organization when the wallet belongs to more
                      than one (Lightning rail); x402 ignores it

Notes:
  - Requires a funded allowance (run402 allowance create && run402 allowance fund)
  - Payments are processed automatically via x402 micropayments, or over
    Lightning from a rail: lightning wallet
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
    failUnknownSubcommand("image", sub);
  }

  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--aspect", "--output", "--org"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for image generate: ${positionals[1]}`,
      hint: 'Quote multi-word prompts, e.g. run402 image generate "your prompt".',
    });
  }
  const opts = {
    prompt: positionals[0] ?? null,
    aspect: flagValue(parsedArgs, "--aspect") ?? "square",
    output: flagValue(parsedArgs, "--output"),
    org: flagValue(parsedArgs, "--org"),
  };

  if (!opts.prompt) {
    fail({
      code: "BAD_USAGE",
      message: "Prompt required.",
      hint: 'run402 image generate "your prompt"',
    });
  }
  assertAllowedValue(opts.aspect, ["square", "landscape", "portrait"], "--aspect");

  try {
    const data = await getSdk().ai.generateImage({ prompt: opts.prompt, aspect: opts.aspect, ...(opts.org ? { orgId: opts.org } : {}) });
    if (opts.output) {
      const buf = Buffer.from(data.image, "base64");
      writeFileSync(opts.output, buf);
      console.log(JSON.stringify({ file: opts.output, size: buf.length, aspect: data.aspect }));
    } else {
      console.log(JSON.stringify({ aspect: data.aspect, content_type: data.content_type, image: data.image }));
    }
  } catch (err) {
    reportSdkError(err);
  }
}
