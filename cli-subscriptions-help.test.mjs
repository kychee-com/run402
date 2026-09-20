/**
 * cli-subscriptions-help.test.mjs — the flags `run402 subscriptions add --help`
 * teaches must be flags its parser accepts, and vice versa.
 *
 * Regression: the v4.82.0 notifications split rewrote the HELP header to
 * `--contact <binding_id>` while the parser kept `--binding`, so the only
 * command an agent could learn from `--help` died as UNKNOWN_FLAG the moment it
 * was typed. cli-help.test.mjs checks that help PRINTS; nothing checked that
 * what it prints is TRUE. This does.
 *
 * Run (after `npm run build`, which the root `npm test` does first):
 *   node --test cli-subscriptions-help.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTIONS_ADD_USAGE,
  SUBSCRIPTIONS_ADD_VALUE_FLAGS,
  SUBSCRIPTIONS_HELP,
} from "./cli/lib/subscriptions.mjs";

const flagsIn = (text) => Array.from(new Set(text.match(/--[a-z][a-z-]*/g) ?? []));

describe("run402 subscriptions add — help and parser agree", () => {
  it("every flag the HELP usage line teaches is a flag the parser accepts", () => {
    const usageLine = SUBSCRIPTIONS_HELP.split("\n").find((l) => /subscriptions add/.test(l));
    assert.ok(usageLine, "HELP has a `subscriptions add` usage line");
    for (const flag of flagsIn(usageLine)) {
      assert.ok(SUBSCRIPTIONS_ADD_VALUE_FLAGS.includes(flag), `HELP teaches ${flag} but the parser does not accept it`);
    }
  });

  it("the BAD_USAGE fallback names the current noun and only accepted flags", () => {
    assert.match(SUBSCRIPTIONS_ADD_USAGE, /^run402 subscriptions add /, "no pre-split `notifications rules` spelling");
    for (const flag of flagsIn(SUBSCRIPTIONS_ADD_USAGE)) {
      assert.ok(SUBSCRIPTIONS_ADD_VALUE_FLAGS.includes(flag), `usage names ${flag} but the parser does not accept it`);
    }
  });

  it("every accepted value flag is documented somewhere in HELP", () => {
    for (const flag of SUBSCRIPTIONS_ADD_VALUE_FLAGS) {
      assert.ok(SUBSCRIPTIONS_HELP.includes(flag), `parser accepts ${flag} but HELP never mentions it`);
    }
  });

  it("--binding is canonical and --contact is its alias, matching the docs", () => {
    assert.match(SUBSCRIPTIONS_ADD_USAGE, /--binding <binding_id>/);
    assert.ok(SUBSCRIPTIONS_ADD_VALUE_FLAGS.includes("--contact"));
  });
});
