/**
 * profile-guidance.test.mjs — a profile must not recommend tools it withholds.
 *
 * `RUN402_MCP_PROFILE=buyer` registers 6 tools instead of 198. Filtering
 * REGISTRATION is only half the job: our guidance strings kept naming tools
 * from the full surface, so a buyer following our own advice was pointed at
 * tools that do not exist for them. Cold-walking the buyer profile on
 * 2026-07-30 (kychee-com/run402-private#635) found two:
 *
 *   allowance_status  ->  "Use `allowance_create` to create one."
 *   init              ->  "**Next:** Use `set_tier` to subscribe to a tier."
 *
 * Neither tool is registered under `buyer`. `set_tier` is worse than absent —
 * a tier buys project hosting, which is not what someone buying a $0.03 image
 * came for.
 *
 * This is the same defect class as our ClawHub skill opening with
 * `run402 wallet status` for four months, and as the CLI-vs-MCP paid-stack
 * drift: a surface that names something which does not exist FOR THE USER BEING
 * ADDRESSED. Those two were each caught by a human walking the path. This one
 * is caught by CI.
 *
 * HOW IT WORKS: scan the source for backtick-quoted identifiers inside
 * user-facing strings, keep the ones that are real tool names, and require that
 * any such name is in the profile — but ONLY for guidance a member of that
 * profile can actually reach. The scan is deliberately textual: it catches a
 * plain string literal, which is how every instance of this bug was written.
 *
 * REACHABILITY IS LOAD-BEARING. The first version of this gate flagged 14
 * "offenders", 13 of them false: `list_mailboxes` recommends `create_mailbox`,
 * but `list_mailboxes` is not in the buyer profile either, so no buyer can ever
 * see that sentence. A checker whose ground truth is wrong invents findings,
 * which is worse than no checker — the same trap that made the first
 * published-docs verb checker wrong 3 times out of 3 by diffing against
 * `--help`. So: `src/tools/<kebab>.ts` backs tool `<snake>` and is in scope only
 * when that tool is in the profile; shared modules outside `src/tools/` are
 * reachable from anything and are always in scope.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const src = join(root, "src");

/** Every tool name the server can register, read from the registration calls. */
function allToolNames() {
  const index = readFileSync(join(src, "index.ts"), "utf8");
  const names = new Set();
  for (const m of index.matchAll(/server\.tool\(\s*\n?\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  // Fallback for a differently-formatted registration: `"name",` on its own
  // line inside the big registration block.
  for (const m of index.matchAll(/^\s{2}"([a-z0-9_]+)",$/gm)) names.add(m[1]);
  return names;
}

/** The profile table, parsed from its own module rather than duplicated here. */
function toolProfiles() {
  const text = readFileSync(join(src, "tool-profiles.ts"), "utf8");
  const body = text.slice(text.indexOf("TOOL_PROFILES"));
  const profiles = {};
  for (const m of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    profiles[m[1]] = [...m[2].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  }
  return profiles;
}

/**
 * Guidance statements in a source file, as whole STATEMENTS not lines.
 *
 * Must not be line-based. A line-based scan only examines lines that themselves
 * contain `lines.push(` / `text:`, so every MULTI-LINE statement escapes it
 * entirely — including the `isToolAvailable(...) ? ... : ...` form this gate
 * asks people to write. That hole made an earlier version of this file pass
 * while the original bug sat in the tree, twice.
 *
 * Comments are stripped first: a comment explaining that `set_tier` is withheld
 * must not read as a recommendation of `set_tier`.
 */
function guidanceStatements(text) {
  const stripped = text
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ""))
    .join("\n");
  const out = [];
  let offset = 0;
  for (const chunk of stripped.split(";")) {
    if (/text:|lines\.push\(|message:/.test(chunk)) {
      const lead = chunk.length - chunk.trimStart().length;
      out.push({
        text: chunk,
        line: stripped.slice(0, offset + lead).split("\n").length,
      });
    }
    offset += chunk.length + 1;
  }
  return out;
}

/** Recursively collect .ts sources, skipping tests. */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

const TOOLS = allToolNames();
const PROFILES = toolProfiles();

/**
 * Can a caller restricted to `profileTools` ever see text from this file?
 *
 * `src/tools/<kebab>.ts` backs the single tool `<snake>`, so its guidance is
 * unreachable unless that tool is registered. Anything outside `src/tools/` is
 * shared plumbing (error mappers, auth helpers) reachable from any tool, so it
 * is always in scope.
 */
/**
 * Shared modules whose guidance a profile member genuinely reaches.
 *
 * DELIBERATELY NARROW. `src/errors.ts` is the gateway error-code mapper and is
 * imported by everything, so treating it as reachable flags its
 * `ADMIN_REQUIRED` / `LAST_OWNER` / `PROJECT_FROZEN` hints — which name
 * control-plane tools that a buyer calling `generate_image` can never trigger.
 * Gating those soundly would mean modelling which error codes each tool can
 * return, which is a lot of machinery for hints nobody in this profile will see.
 * A gate that demands twenty unreachable fixes gets switched off, and a
 * switched-off gate protects nothing. If a profile is ever added whose tools DO
 * hit control-plane errors, add `errors.ts` here and do that modelling then.
 */
const SHARED_IN_SCOPE = new Set(["allowance-auth.ts"]);

/**
 * Can a caller restricted to `profileTools` ever see text from this file?
 *
 * `src/tools/<kebab>.ts` backs the single tool `<snake>`, so its guidance is
 * unreachable unless that tool is registered.
 */
function reachableUnderProfile(file, profileTools) {
  const rel = file.slice(src.length + 1);
  if (!rel.startsWith("tools/")) return SHARED_IN_SCOPE.has(rel);
  const toolName = rel.slice("tools/".length).replace(/\.ts$/, "").replace(/-/g, "_");
  // A file whose name maps to no registered tool holds several tools (or was
  // renamed). Out of scope: the filename cannot tell us which profile reaches
  // it, and guessing produces false findings — the failure mode that made the
  // first version of this gate report 13 non-bugs.
  if (!TOOLS.has(toolName)) return false;
  return profileTools.includes(toolName);
}

describe("profile guidance never names a withheld tool", () => {
  it("the harness can see the tool surface and the profiles", () => {
    // Without this control, a regex that stopped matching would make every
    // assertion below pass vacuously — the "probe returns empty on malformed
    // input" failure mode.
    assert.ok(TOOLS.size > 100, `expected >100 registered tools, found ${TOOLS.size}`);
    assert.ok(Object.keys(PROFILES).length > 0, "expected at least one profile");
    for (const [name, list] of Object.entries(PROFILES)) {
      assert.ok(list.length > 0, `profile "${name}" parsed as empty`);
      for (const t of list) {
        assert.ok(TOOLS.has(t), `profile "${name}" names "${t}", which is not a registered tool`);
      }
    }
  });

  for (const [profileName, profileTools] of Object.entries(PROFILES)) {
    it(`"${profileName}" profile: no guidance string recommends a tool outside it`, () => {
      const offenders = [];
      for (const file of sources(src)) {
        if (!reachableUnderProfile(file, profileTools)) continue;
        for (const stmt of guidanceStatements(readFileSync(file, "utf8"))) {
          // A statement that consults the profile IS the fix, not a violation.
          if (/isToolAvailable|noAllowanceHint/.test(stmt.text)) continue;
          // Backticks may be ESCAPED (\`tool\`) because most guidance lives in
          // template literals, where an inner backtick has to be.
          for (const m of stmt.text.matchAll(/\\?`([a-z0-9_]+)\\?`/g)) {
            const named = m[1];
            if (!TOOLS.has(named)) continue;
            if (profileTools.includes(named)) continue;
            offenders.push(`${file.slice(root.length + 1)}:${stmt.line} recommends \`${named}\``);
          }
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `guidance reachable under RUN402_MCP_PROFILE=${profileName} names tools that profile does not ` +
          `register, so the caller cannot act on the advice:\n  ${offenders.join("\n  ")}\n` +
          `Fix by branching on isToolAvailable() (see src/tool-profiles.ts), not by deleting the advice.`,
      );
    });
  }
});
