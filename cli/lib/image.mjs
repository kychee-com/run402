import { writeFileSync } from "fs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";
import { resolveOrg } from "./org-context.mjs";
import { nextAction } from "./next-actions.mjs";

const HELP = `run402 image — Generate AI images via x402 micropayments

Usage:
  run402 image generate "<prompt>" [options]

Options:
  --aspect <ratio>    Image aspect ratio: square | landscape | portrait  (default: square)
  --output <file>     Save image to file (e.g. output.png)
                      If omitted, returns base64 JSON to stdout
  --org <org_id>      The paying organization when the wallet belongs to more
                      than one (Lightning rail); x402 ignores it. Omitted, it
                      is the current org (RUN402_ORG, the .run402.json binding,
                      run402 org use, or the active project's owning org)
  --help, -h          Show this help message

Examples:
  run402 image generate "a startup mascot, pixel art"
  run402 image generate "futuristic city at night" --aspect landscape
  run402 image generate "portrait of a cat CEO" --aspect portrait --output cat.png

Output (without --output):
  { "aspect": "square", "content_type": "image/png", "image": "<base64>" }

Notes:
  - Requires a funded wallet (run402 init && run402 wallets fund)
  - Payments are processed automatically via x402 micropayments (USDC on the
    network your wallet targets — Base Sepolia on the prototype tier, Base
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
                      than one (Lightning rail); x402 ignores it. Omitted, it
                      is the current org (RUN402_ORG, the .run402.json binding,
                      run402 org use, or the active project's owning org)

Notes:
  - Requires a funded wallet (run402 init && run402 wallets fund)
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

  // The paying organization rides the ONE shared org chain (--org, then
  // RUN402_ORG / RUN402_ROOM / RUN402_PROJECT_ID, then the .run402.json
  // binding, then `org use` / the active project's owning org). Only the
  // Lightning rail reads it — a multi-org principal is refused
  // ORGANIZATION_SELECTION_REQUIRED without one — and x402 ignores it, so
  // resolving it is never a reason to refuse an x402 purchase: `optional`
  // answers null rather than ORG_REQUIRED when the chain is empty.
  const org = await resolveOrg({ org: opts.org }, { cmd: "image", optional: true });

  try {
    const data = await getSdk().ai.generateImage({ prompt: opts.prompt, aspect: opts.aspect, ...(org ? { orgId: org.orgId } : {}) });
    if (opts.output) {
      const buf = Buffer.from(data.image, "base64");
      writeFileSync(opts.output, buf);
      console.log(JSON.stringify({ file: opts.output, size: buf.length, aspect: data.aspect }));
    } else {
      console.log(JSON.stringify({ aspect: data.aspect, content_type: data.content_type, image: data.image }));
    }
  } catch (err) {
    reportOrgSelectionError(err, org);
    reportSdkError(err);
  }
}

/**
 * The Lightning rail's two org refusals, explained in the CLI's own words:
 * `ORGANIZATION_SELECTION_REQUIRED` (no org named, and the SDK found no
 * single local match among the gateway's candidates) and the 403 the
 * gateway answers when the resolved org is one the principal cannot bill.
 * Both name where the org came from and how to name another one.
 */
function reportOrgSelectionError(err, org) {
  const code = err?.code;
  const details = err?.details && typeof err.details === "object" ? err.details : {};
  if (code === "ORGANIZATION_SELECTION_REQUIRED") {
    const ids = Array.isArray(details.organization_ids) ? details.organization_ids : [];
    fail({
      code,
      message: err.message,
      hint:
        `Pass --org <org_id> (one of: ${ids.join(", ") || "run402 org list"}) or select a current organization with ` +
        "run402 org use <org_id>. Only the Lightning rail needs it; x402 ignores it.",
      details: { ...details, organization_ids: ids, org_source: org?.source ?? null, org_source_detail: org?.sourceDetail ?? null },
      next_actions: err.nextActions ?? [
        nextAction("edit_request", { command: 'run402 image generate "<prompt>" --org <org_id>', why: "Name the paying organization on this call." }),
        nextAction("edit_request", { command: "run402 org use <org_id>", why: "Select a current organization for this profile." }),
      ],
    });
  }
  if (err?.status === 403 && org && details.org_id === org.orgId && org.source !== "flag") {
    fail({
      code: code ?? "FORBIDDEN",
      message: err.message,
      hint:
        `The paying organization ${org.orgId} came from ${org.sourceDetail} (${org.source}) and this principal holds no billing role there. ` +
        "Pass --org <org_id> for an organization you can bill, or run: run402 org use <org_id>",
      details: { ...details, org_source: org.source, org_source_detail: org.sourceDetail },
      next_actions: err.nextActions,
    });
  }
}
