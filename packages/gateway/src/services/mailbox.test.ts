/**
 * Unit tests for mailbox slug validation and blocklist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSlug } from "./mailbox.js";

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    assert.equal(validateSlug("my-app"), null);
    assert.equal(validateSlug("workout-tracker"), null);
    assert.equal(validateSlug("app123"), null);
    assert.equal(validateSlug("abc"), null);
    assert.equal(validateSlug("a".repeat(63)), null);
  });

  it("rejects slugs that are too short", () => {
    assert.ok(validateSlug("ab")?.includes("3-63"));
    assert.ok(validateSlug("a")?.includes("3-63"));
    assert.ok(validateSlug("") !== null);
  });

  it("rejects slugs that are too long", () => {
    assert.ok(validateSlug("a".repeat(64))?.includes("3-63"));
  });

  it("rejects uppercase slugs", () => {
    assert.ok(validateSlug("MyApp")?.includes("lowercase"));
  });

  it("rejects slugs with invalid characters", () => {
    assert.ok(validateSlug("my_app")?.includes("lowercase letters"));
    assert.ok(validateSlug("my app")?.includes("lowercase letters"));
    assert.ok(validateSlug("my.app")?.includes("lowercase letters"));
    assert.ok(validateSlug("my@app")?.includes("lowercase letters"));
  });

  it("rejects slugs starting or ending with hyphen", () => {
    assert.ok(validateSlug("-myapp") !== null);
    assert.ok(validateSlug("myapp-") !== null);
  });

  it("rejects consecutive hyphens", () => {
    assert.ok(validateSlug("my--app")?.includes("consecutive"));
  });

  it("rejects reserved slugs", () => {
    const reserved = [
      "admin", "info", "support", "help", "postmaster", "abuse",
      "hostmaster", "webmaster", "mailer-daemon", "bounce",
      "tal", "barry", "ceo", "founder", "run402", "agentdb",
      "billing", "legal", "security", "noreply", "no-reply",
      "payroll", "finance", "owner",
    ];
    for (const slug of reserved) {
      const err = validateSlug(slug);
      assert.ok(err?.includes("reserved"), `Expected "${slug}" to be reserved, got: ${err}`);
    }
  });

  it("allows slugs that are not reserved", () => {
    assert.equal(validateSlug("my-project"), null);
    assert.equal(validateSlug("workout-tracker"), null);
    assert.equal(validateSlug("cosmic-forge"), null);
    assert.equal(validateSlug("test-app-123"), null);
  });
});
