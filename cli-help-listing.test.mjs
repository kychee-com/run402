/**
 * The `--help` command listing must match what the CLI actually dispatches,
 * in BOTH directions, and every listed command must sit in a family.
 *
 * Why this exists: `run402 message` was renamed to `run402 feedback` in 4.30.0
 * — the dispatcher was updated, the command manifest was updated, the docs were
 * updated, and the hand-maintained listing in `--help` was not. For two
 * releases `--help` advertised a command that answers `COMMAND_REMOVED` and
 * omitted the one that works.
 *
 * Measuring that defect found a second one of the same shape pointing the other
 * way: `notifications` and `webhook-secret` DISPATCHED and appeared nowhere in
 * the listing. A whole family of operator-facing commands was undiscoverable,
 * and nothing noticed, because absence meant nothing. So absence must now be
 * DECLARED (see HIDDEN_COMMANDS) rather than merely happen.
 *
 * An agent's first act on an unfamiliar CLI is to read `--help`. That makes the
 * listing the one surface that must not lie — a name that does not work sends
 * the reader nowhere, and a working command that is absent cannot be found.
 *
 * The check is deliberately narrow: it compares NAMES, not descriptions. A
 * stale description is a wording problem; a stale name is a dead end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "cli", "cli.mjs"), "utf8");

/**
 * Commands deliberately absent from `--help`, each with the reason.
 *
 * Empty on purpose: every command the CLI dispatches today is one a user may
 * legitimately need to find. An entry here is a deliberate act, and the reason
 * string is what makes it reviewable later — "why is this hidden" should never
 * require archaeology.
 */
const HIDDEN_COMMANDS = Object.freeze({
  // e.g. "some-internal-cmd": "internal plumbing; never invoked by a user",
});

/** Family headings are ALL-CAPS lines; commands are indented beneath one. */
function parseListing() {
  const block = source.slice(
    source.indexOf("\nCommands, grouped"),
    source.indexOf("\nGlobal options"),
  );
  // A LIST, not a map: a later entry must not overwrite an earlier one, or a
  // command listed twice (or once above any heading and once inside a family)
  // would mask itself. Found while verifying the orphan check — the first
  // version of this parser silently passed exactly that case.
  const entries = []; // { name, family }
  let family = null;
  for (const line of block.split("\n")) {
    const head = /^([A-Z][A-Z &]+[A-Z])\b/.exec(line);
    if (head) { family = head[1]; continue; }
    const m = /^ {2}(\S+)(?: +\S)/.exec(line);
    // "init mpp" documents a FLAG on an existing command, not a name of its own.
    if (m && !line.startsWith("  init mpp")) entries.push({ name: m[1], family });
  }
  return entries;
}

const listedNames = (entries) => new Set(entries.map((e) => e.name));

function dispatchedCommands() {
  const names = new Set();
  for (const m of source.matchAll(/^\s*case "([a-z0-9-]+)":/gm)) names.add(m[1]);
  return names;
}

test("every command in --help is one the CLI dispatches", () => {
  const listed = parseListing();
  const dispatched = dispatchedCommands();
  assert.ok(listed.length > 40, "the listing parser found almost nothing — fix the parser, not the test");

  const phantom = [...listedNames(listed)].filter((n) => !dispatched.has(n));
  assert.deepEqual(
    phantom,
    [],
    `--help advertises ${phantom.join(", ")}, which the CLI does not dispatch. `
      + "An agent reads --help first; a name here that does not work sends it somewhere that does not exist.",
  );
});

test("every command the CLI dispatches is listed, or declared hidden", () => {
  // The direction that let `notifications` disappear. Absence must be a
  // decision someone made, not something that happened.
  const listed = listedNames(parseListing());
  const invisible = [...dispatchedCommands()].filter(
    (n) => !listed.has(n) && !(n in HIDDEN_COMMANDS) && !isReserved(n),
  );
  assert.deepEqual(
    invisible,
    [],
    `these commands dispatch but appear nowhere in --help: ${invisible.join(", ")}. `
      + "List them, or add them to HIDDEN_COMMANDS with a reason. A user cannot find what is not there.",
  );
});

test("every listed command sits in a family", () => {
  const listed = parseListing();
  const orphans = listed.filter((e) => !e.family).map((e) => e.name);
  assert.deepEqual(
    orphans,
    [],
    `these commands are listed above any family heading: ${orphans.join(", ")}. `
      + "The grouping is what makes the surface learnable; a command outside it is back in the flat list.",
  );
});

/**
 * A spelling kept alive only to answer `COMMAND_REMOVED`.
 *
 * Two shapes: a top-level `case` that fails inline (`message`), and a family
 * whose whole module is a reservation (`notifications`, split into
 * deliveries/contacts/subscriptions). The second answers from its own file, so
 * the redirect is not visible in cli.mjs — consult the manifest's
 * SKIPPED_FAMILIES, which is where that decision is recorded.
 */
function isReserved(name) {
  if (new RegExp(`was: "${name}"`).test(source)) return true;
  const manifest = readFileSync(join(here, "cli", "lib", "command-manifest.mjs"), "utf8");
  const skipped = manifest.slice(manifest.indexOf("export const SKIPPED_FAMILIES"));
  return new RegExp(`"${name}":`).test(skipped.slice(0, skipped.indexOf("};")));
}

test("a removed command is not still advertised", () => {
  const removed = [...source.matchAll(/code: "COMMAND_REMOVED"[\s\S]{0,400}?was: "([a-z0-9-]+)"/g)]
    .map((m) => m[1]);
  const listed = listedNames(parseListing());
  const advertised = removed.filter((n) => listed.has(n));
  assert.deepEqual(
    advertised,
    [],
    `--help still lists removed command(s): ${advertised.join(", ")}. Replace each with its successor.`,
  );
});

test("no command is listed twice", () => {
  // A duplicate is how the orphan check above can be defeated: the same name
  // once outside any family and once inside one. Catching it directly is
  // cheaper than making every other check duplicate-aware.
  const seen = new Map();
  const dupes = [];
  for (const { name } of parseListing()) {
    if (seen.has(name)) dupes.push(name);
    seen.set(name, true);
  }
  assert.deepEqual(dupes, [], `listed more than once: ${dupes.join(", ")}. One command, one family.`);
});

test("hidden commands state why they are hidden", () => {
  for (const [name, reason] of Object.entries(HIDDEN_COMMANDS)) {
    assert.ok(
      typeof reason === "string" && reason.trim().length > 10,
      `HIDDEN_COMMANDS["${name}"] needs a real reason — "why is this hidden" must not require archaeology.`,
    );
  }
});
