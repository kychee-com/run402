import { allowanceAuthHeaders } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, normalizeArgv, failUnknownSubcommand, flagValue, positionalArgs } from "./argparse.mjs";

const HELP = `run402 feedback — Send feedback to the Run402 developers

Usage:
  run402 feedback send <text> [--project <project_id>] [--handle <handle>]

Notes:
  - WRITE-ONLY: there is no inbox to read and no reply path. If you need an
    answer from a human, raise an escalation instead:
    run402 escalations raise "<what you need>" --severity high
  - Requires an active tier (run402 tier set <tier>)
  - Requires an allowance (run402 allowance create)
  - Messages are capped at 8 KB (8192 bytes UTF-8) to keep the developer
    inbox useful and prevent payload-dump misuse. Trim or summarize long
    content (e.g. stack traces) before sending.

Finishing a deploy — the promotion consent flow:
  When a commit or promote response reaches status "ready" with a public
  site, it carries a next_actions entry of type hand_to_operator. That is
  Run402 asking, through you, whether it may promote what your human built
  on @run402com — for free, credited to your presence name (credited_as)
  and to your human. Show your human both links (urls.site, urls.console),
  relay the offer in your own words ("Run402 would like to promote what you
  built..."), and ask yes or no. On yes, optionally ask for an X/Twitter
  handle, then:
    run402 feedback send "promote: yes" --project <project_id> [--handle <handle>]
  Say no honestly if your human declines; nothing is sent. The offer is
  asked once per project and stops after a "promote: yes" lands. If
  credited_as is missing, join the project room with a name so future
  offers credit you: run402 rooms join --name <name>

Examples:
  run402 feedback send "Hello from my agent!"
  run402 feedback send "promote: yes" --project prj_abc123 --handle @hobo_hi
`;

// Cap message body at a Twitter-ish but engineer-generous size: enough for
// a few paragraphs and a stack-trace excerpt, small enough that a misbehaving
// agent script can't dump arbitrary content into the developer inbox in one
// call. UTF-8 bytes (not characters) — emoji and accented chars count as
// multiple bytes.
const MESSAGE_MAX_BYTES = 8192;

const SUB_HELP = {
  send: `run402 feedback send — Send feedback to the Run402 developers

Usage:
  run402 feedback send <text> [--project <project_id>] [--handle <handle>]

Arguments:
  <text>              Message body (quote it; remaining positional words are
                      joined with spaces if multiple are provided)

Flags:
  --project <id>      Project this feedback concerns. Required to relay a
                      promotion consent (the hand_to_operator next action
                      from a deploy response) — the server resolves the
                      project's site URL, org, and your presence name for
                      the delivered message.
  --handle <handle>   Your human's X/Twitter handle, at most 64 characters.
                      Only used with --project; delivered as-is, stored
                      nowhere else.

Notes:
  - Requires an active tier (run402 tier set <tier>)
  - Requires an allowance (run402 allowance create)
  - Messages are capped at 8 KB (8192 bytes UTF-8) to keep the developer
    inbox useful and prevent payload-dump misuse.
  - Finishing a deploy: when a commit/promote response carries a
    hand_to_operator next action, show your human urls.site and
    urls.console, relay that Run402 would like to promote what they built
    on @run402com for free (credited to credited_as and to them), and ask
    yes or no. On yes: run402 feedback send "promote: yes" --project <id>
    [--handle <handle>]

Examples:
  run402 feedback send "Hello from my agent!"
  run402 feedback send "promote: yes" --project prj_abc123 --handle @hobo_hi
`,
};

async function send(args) {
  const valueFlags = ["--project", "--handle"];
  assertKnownFlags(args, [...valueFlags, "--help", "-h"], valueFlags);
  const text = positionalArgs(args, valueFlags).join(" ");
  if (!text) {
    fail({ code: "BAD_USAGE", message: "Missing message text." });
  }
  // Cap check runs BEFORE the allowance check so oversized payloads surface
  // a structured size error instead of being masked by a missing-allowance
  // exit.
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MESSAGE_MAX_BYTES) {
    fail({
      code: "MESSAGE_TOO_LONG",
      message: `Message is ${bytes} bytes; maximum is ${MESSAGE_MAX_BYTES} bytes (~8 KB).`,
      hint: "Trim or summarize the message.",
      details: { bytes, max_bytes: MESSAGE_MAX_BYTES },
    });
  }
  const projectId = flagValue(args, "--project");
  const handle = flagValue(args, "--handle");
  if (handle && handle.length > 64) {
    fail({
      code: "BAD_FLAG",
      message: `--handle must be at most 64 characters, got ${handle.length}.`,
      details: { flag: "--handle", length: handle.length, max: 64 },
    });
  }
  // Preserve the aggressive early exit when no allowance is configured.
  allowanceAuthHeaders("/feedback/v1");

  const opts = {};
  if (projectId) opts.project_id = projectId;
  if (handle) opts.handle = handle;

  try {
    await getSdk().admin.sendFeedback(text, opts);
    console.log(JSON.stringify({
      bytes_sent: bytes,
      sent: true,
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  if (sub !== "send") {
    failUnknownSubcommand("feedback", sub);
  }
  const parsedArgs = normalizeArgv(args);
  await send(parsedArgs);
}
