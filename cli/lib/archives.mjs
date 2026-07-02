import { inspectArchive, verifyArchive } from "#sdk/node";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 archives — Inspect and verify portable Run402 project archives

Usage:
  run402 archives inspect <archive-path> [--json]
  run402 archives verify  <archive-path> [--json]

Notes:
  - Verification is local and offline. It does not require Cloud credentials.
  - Archives are untrusted input; verify checks integrity and compatibility, not trust.
`;

export async function run(sub, rawArgs = []) {
  const all = [sub, ...rawArgs].filter(Boolean);
  if (hasHelp(all)) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "inspect": return inspect(rawArgs);
    case "verify": return verify(rawArgs);
    default:
      fail({
        code: "UNKNOWN_SUBCOMMAND",
        message: `Unknown archives subcommand: ${sub}`,
        hint: "Run `run402 archives --help` for usage.",
        details: { command: "archives", subcommand: sub },
      });
  }
}

async function inspect(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--json", "--help", "-h"], []);
  const archivePath = positionalArgs(args, [])[0];
  if (!archivePath) fail({ code: "BAD_USAGE", message: "Usage: run402 archives inspect <archive-path> [--json]" });
  try {
    const result = await inspectArchive(archivePath);
    console.log(JSON.stringify({ archive: result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function verify(rawArgs) {
  const args = normalizeArgv(rawArgs);
  assertKnownFlags(args, ["--json", "--help", "-h"], []);
  const archivePath = positionalArgs(args, [])[0];
  if (!archivePath) fail({ code: "BAD_USAGE", message: "Usage: run402 archives verify <archive-path> [--json]" });
  try {
    const result = await verifyArchive(archivePath);
    console.log(JSON.stringify({ ok: result.ok, verified: result.ok, archive: result }, null, 2));
    if (!result.ok) process.exit(1);
  } catch (err) {
    reportSdkError(err);
  }
}
