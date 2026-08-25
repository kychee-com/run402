/**
 * The `--help` command listing must match what the CLI actually dispatches.
 *
 * Why this exists: `run402 message` was renamed to `run402 feedback` in 4.30.0
 * — the dispatcher was updated, the command manifest was updated, the docs were
 * updated, and the hand-maintained listing in `--help` was not. For two
 * releases `--help` advertised a command that answers `COMMAND_REMOVED` and
 * omitted the one that works. An agent's first act on an unfamiliar CLI is to
 * read `--help`, so the one surface that must not lie is the one nothing was
 * checking.
 *
 * This is the same lesson the fleet dogfood recorded: automation propagates,
 * documentation doesn't. The manifest and the dispatcher had gates; the prose
 * between them did not.
 *
 * The check is deliberately narrow — it compares NAMES, not descriptions. A
 * stale description is a wording problem; a stale name sends an agent to a
 * command that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "cli", "cli.mjs"), "utf8");

/** Command names advertised in the `--help` listing. */
function listedCommands() {
  const block = source.slice(
    source.indexOf("\nCommands:\n"),
    source.indexOf("\nGlobal options"),
  );
  const names = new Set();
  for (const line of block.split("\n")) {
    // "  name        description" — two-space indent, then the name.
    const m = /^ {2}(\S+)(?: +\S)/.exec(line);
    // Sub-entries like "init mpp" document a FLAG on an existing command, not
    // a dispatchable name of their own.
    if (m && !line.startsWith("  init mpp")) names.add(m[1]);
  }
  return names;
}

/** Command names the dispatcher actually answers. */
function dispatchedCommands() {
  const names = new Set();
  for (const m of source.matchAll(/^\s*case "([a-z0-9-]+)":/gm)) names.add(m[1]);
  return names;
}

test("every command in --help is one the CLI dispatches", () => {
  const listed = [...listedCommands()];
  const dispatched = dispatchedCommands();
  assert.ok(listed.length > 20, "the listing parser found almost nothing — fix the parser, not the test");

  const phantom = listed.filter((n) => !dispatched.has(n));
  assert.deepEqual(
    phantom,
    [],
    `--help advertises ${phantom.join(", ")}, which the CLI does not dispatch. `
      + "An agent reads --help first; a name here that does not work sends it somewhere that does not exist.",
  );
});

test("a removed command is not still advertised", () => {
  // The specific regression: a rename that reserves the old name must also
  // take it out of the listing, or --help keeps recommending the tombstone.
  const removed = [...source.matchAll(/code: "COMMAND_REMOVED"[\s\S]{0,400}?was: "([a-z0-9-]+)"/g)]
    .map((m) => m[1]);
  const listed = listedCommands();
  const advertised = removed.filter((n) => listed.has(n));
  assert.deepEqual(
    advertised,
    [],
    `--help still lists removed command(s): ${advertised.join(", ")}. Replace each with its successor.`,
  );
});
