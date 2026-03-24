/**
 * Comprehensive unit tests for the mailbox service.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock DB pool before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

const {
  validateSlug,
  formatAddress,
  createMailbox,
  getMailbox,
  getMailboxBySlug,
  listMailboxes,
  deleteMailbox,
  tombstoneProjectMailbox,
  suspendMailbox,
  reactivateMailbox,
  checkAndIncrementDailyLimit,
  checkAndIncrementRecipientLimit,
  isAddressSuppressed,
  addSuppression,
  initMailboxTables,
  MailboxError,
} = await import("./mailbox.js");

// ---------------------------------------------------------------------------
// MailboxError
// ---------------------------------------------------------------------------

describe("MailboxError", () => {
  it("has message and statusCode", () => {
    const err = new MailboxError("conflict", 409);
    assert.equal(err.message, "conflict");
    assert.equal(err.statusCode, 409);
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    assert.equal(validateSlug("my-app"), null);
    assert.equal(validateSlug("workout-tracker"), null);
    assert.equal(validateSlug("app123"), null);
    assert.equal(validateSlug("abc"), null);
    assert.equal(validateSlug("a".repeat(63)), null);
    assert.equal(validateSlug("a1b"), null);
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
    assert.ok(validateSlug("ALLCAPS")?.includes("lowercase"));
  });

  it("rejects slugs with invalid characters", () => {
    assert.ok(validateSlug("my_app") !== null);
    assert.ok(validateSlug("my app") !== null);
    assert.ok(validateSlug("my.app") !== null);
    assert.ok(validateSlug("my@app") !== null);
  });

  it("rejects slugs starting or ending with hyphen", () => {
    assert.ok(validateSlug("-myapp") !== null);
    assert.ok(validateSlug("myapp-") !== null);
  });

  it("rejects consecutive hyphens", () => {
    assert.ok(validateSlug("my--app")?.includes("consecutive"));
  });

  it("rejects reserved words", () => {
    // Only test reserved words with >= 3 chars (shorter ones fail length check first)
    const reserved = [
      "abuse", "postmaster", "hostmaster", "webmaster", "mailer-daemon",
      "bounce", "bounces", "smtp", "imap", "pop", "dkim", "dmarc",
      "noreply", "no-reply",
      "admin", "info", "support", "help", "hello", "contact", "sales",
      "billing", "accounts", "legal", "privacy", "security", "press",
      "media", "jobs", "careers", "team", "ops", "status", "api", "docs",
      "dashboard", "run402", "agentdb",
      "tal", "barry", "ceo", "founder", "owner", "finance", "payroll",
    ];
    for (const slug of reserved) {
      const err = validateSlug(slug);
      assert.ok(err?.includes("reserved"), `Expected "${slug}" to be reserved, got: ${err}`);
    }
  });

  it("allows slugs that are not reserved", () => {
    assert.equal(validateSlug("my-project"), null);
    assert.equal(validateSlug("cosmic-forge"), null);
    assert.equal(validateSlug("test-app-123"), null);
  });
});

// ---------------------------------------------------------------------------
// formatAddress
// ---------------------------------------------------------------------------

describe("formatAddress", () => {
  it("returns slug@mail.run402.com", () => {
    assert.equal(formatAddress("my-app"), "my-app@mail.run402.com");
  });

  it("works with various slugs", () => {
    assert.equal(formatAddress("test"), "test@mail.run402.com");
    assert.equal(formatAddress("abc123"), "abc123@mail.run402.com");
  });
});

// ---------------------------------------------------------------------------
// createMailbox
// ---------------------------------------------------------------------------

describe("createMailbox", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
  });

  it("throws 409 when project already has a mailbox", async () => {
    mockPoolQuery = async () => ({ rows: [{ id: "mbx_existing" }] });

    await assert.rejects(
      () => createMailbox("my-slug", "prj_001"),
      (err: any) => {
        assert.ok(err instanceof MailboxError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes("already has a mailbox"));
        return true;
      },
    );
  });

  it("throws 409 when slug is taken by active mailbox", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing project mailbox
      if (queryCount === 2) return { rows: [{ id: "mbx_other", status: "active", tombstoned_at: null }] }; // slug taken
      return { rows: [] };
    };

    await assert.rejects(
      () => createMailbox("taken-slug", "prj_001"),
      (err: any) => {
        assert.ok(err instanceof MailboxError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes("Slug already in use"));
        return true;
      },
    );
  });

  it("throws 409 when slug is taken by suspended mailbox", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] };
      if (queryCount === 2) return { rows: [{ id: "mbx_other", status: "suspended", tombstoned_at: null }] };
      return { rows: [] };
    };

    await assert.rejects(
      () => createMailbox("susp-slug", "prj_001"),
      (err: any) => {
        assert.ok(err instanceof MailboxError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes("Slug already in use"));
        return true;
      },
    );
  });

  it("throws 409 when slug is in tombstone cooldown", async () => {
    const recentTombstone = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 1 day ago
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] };
      if (queryCount === 2) return { rows: [{ id: "mbx_old", status: "tombstoned", tombstoned_at: recentTombstone }] };
      return { rows: [] };
    };

    await assert.rejects(
      () => createMailbox("old-slug", "prj_001"),
      (err: any) => {
        assert.ok(err instanceof MailboxError);
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes("cooldown"));
        return true;
      },
    );
  });

  it("creates mailbox successfully when slug is free", async () => {
    let queryCount = 0;
    const fakeRecord = {
      id: "mbx_test",
      slug: "new-slug",
      project_id: "prj_001",
      status: "active",
      tombstoned_at: null,
      sends_today: 0,
      sends_today_reset_at: new Date().toISOString(),
      unique_recipients: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing project mailbox
      if (queryCount === 2) return { rows: [] }; // slug not taken
      return { rows: [fakeRecord] }; // INSERT RETURNING
    };

    const result = await createMailbox("new-slug", "prj_001");
    assert.equal(result.slug, "new-slug");
    assert.equal(result.project_id, "prj_001");
    assert.equal(result.status, "active");
  });

  it("reuses slug when tombstone cooldown has expired", async () => {
    const oldTombstone = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(); // 91 days ago
    let queryCount = 0;
    const fakeRecord = {
      id: "mbx_new",
      slug: "recycled",
      project_id: "prj_002",
      status: "active",
      tombstoned_at: null,
      sends_today: 0,
      sends_today_reset_at: new Date().toISOString(),
      unique_recipients: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing project mailbox
      if (queryCount === 2) return { rows: [{ id: "mbx_expired", status: "tombstoned", tombstoned_at: oldTombstone }] };
      if (queryCount === 3) return { rows: [], rowCount: 1 }; // DELETE expired tombstone
      return { rows: [fakeRecord] }; // INSERT RETURNING
    };

    const result = await createMailbox("recycled", "prj_002");
    assert.equal(result.slug, "recycled");
    assert.equal(result.status, "active");
  });
});

// ---------------------------------------------------------------------------
// getMailbox
// ---------------------------------------------------------------------------

describe("getMailbox", () => {
  it("returns mailbox when found", async () => {
    const record = { id: "mbx_001", slug: "test", project_id: "prj_001", status: "active" };
    mockPoolQuery = async () => ({ rows: [record] });

    const result = await getMailbox("mbx_001");
    assert.deepEqual(result, record);
  });

  it("returns null when not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const result = await getMailbox("mbx_missing");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// getMailboxBySlug
// ---------------------------------------------------------------------------

describe("getMailboxBySlug", () => {
  it("returns mailbox when found", async () => {
    const record = { id: "mbx_001", slug: "test", project_id: "prj_001", status: "active" };
    mockPoolQuery = async () => ({ rows: [record] });

    const result = await getMailboxBySlug("test");
    assert.deepEqual(result, record);
  });

  it("returns null when not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const result = await getMailboxBySlug("no-such-slug");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// listMailboxes
// ---------------------------------------------------------------------------

describe("listMailboxes", () => {
  it("returns list of mailboxes for a project", async () => {
    const records = [
      { id: "mbx_001", slug: "first", project_id: "prj_001", status: "active" },
      { id: "mbx_002", slug: "second", project_id: "prj_001", status: "active" },
    ];
    mockPoolQuery = async () => ({ rows: records });

    const result = await listMailboxes("prj_001");
    assert.equal(result.length, 2);
    assert.equal(result[0].slug, "first");
    assert.equal(result[1].slug, "second");
  });

  it("returns empty list when project has no mailboxes", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const result = await listMailboxes("prj_empty");
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// deleteMailbox
// ---------------------------------------------------------------------------

describe("deleteMailbox", () => {
  it("returns false when mailbox not found", async () => {
    mockPoolQuery = async () => ({ rows: [] }); // getMailbox returns null

    const result = await deleteMailbox("mbx_missing", "prj_001");
    assert.equal(result, false);
  });

  it("throws 403 when mailbox belongs to different project", async () => {
    mockPoolQuery = async () => ({
      rows: [{ id: "mbx_001", slug: "test", project_id: "prj_other", status: "active" }],
    });

    await assert.rejects(
      () => deleteMailbox("mbx_001", "prj_001"),
      (err: any) => {
        assert.ok(err instanceof MailboxError);
        assert.equal(err.statusCode, 403);
        assert.ok(err.message.includes("different project"));
        return true;
      },
    );
  });

  it("tombstones mailbox successfully", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) {
        // getMailbox
        return { rows: [{ id: "mbx_001", slug: "test", project_id: "prj_001", status: "active" }] };
      }
      // UPDATE (tombstone)
      return { rows: [], rowCount: 1 };
    };

    const result = await deleteMailbox("mbx_001", "prj_001");
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// tombstoneProjectMailbox
// ---------------------------------------------------------------------------

describe("tombstoneProjectMailbox", () => {
  it("tombstones all active mailboxes for the project", async () => {
    mockPoolQuery = async () => ({
      rows: [{ slug: "first" }, { slug: "second" }],
    });

    // Should not throw
    await tombstoneProjectMailbox("prj_001");
  });

  it("handles project with no active mailboxes", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    await tombstoneProjectMailbox("prj_empty");
  });
});

// ---------------------------------------------------------------------------
// suspendMailbox
// ---------------------------------------------------------------------------

describe("suspendMailbox", () => {
  it("updates status to suspended", async () => {
    let calledWith: any[] = [];
    mockPoolQuery = async (...args: any[]) => {
      calledWith = args;
      return { rows: [], rowCount: 1 };
    };

    await suspendMailbox("mbx_001", "spam detected");
    // Verify the query was called with the mailbox id
    assert.equal(calledWith[1][0], "mbx_001");
  });
});

// ---------------------------------------------------------------------------
// reactivateMailbox
// ---------------------------------------------------------------------------

describe("reactivateMailbox", () => {
  it("returns true when reactivation succeeds", async () => {
    mockPoolQuery = async () => ({ rows: [{ id: "mbx_001" }], rowCount: 1 });

    const result = await reactivateMailbox("mbx_001");
    assert.equal(result, true);
  });

  it("returns false when mailbox not found or not suspended", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

    const result = await reactivateMailbox("mbx_missing");
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// checkAndIncrementDailyLimit
// ---------------------------------------------------------------------------

describe("checkAndIncrementDailyLimit", () => {
  it("returns allowed: true when under limit", async () => {
    mockPoolQuery = async () => ({
      rows: [{ sends_today: 5, sends_today_reset_at: "2026-03-25T00:00:00Z" }],
    });

    const result = await checkAndIncrementDailyLimit("mbx_001", 100);
    assert.equal(result.allowed, true);
    assert.equal(result.current, 5);
    assert.equal(result.resetsAt, "2026-03-25T00:00:00Z");
  });

  it("returns allowed: false when over limit", async () => {
    mockPoolQuery = async () => ({
      rows: [{ sends_today: 101, sends_today_reset_at: "2026-03-25T00:00:00Z" }],
    });

    const result = await checkAndIncrementDailyLimit("mbx_001", 100);
    assert.equal(result.allowed, false);
    assert.equal(result.current, 101);
  });

  it("returns allowed: true when exactly at limit", async () => {
    mockPoolQuery = async () => ({
      rows: [{ sends_today: 100, sends_today_reset_at: "2026-03-25T00:00:00Z" }],
    });

    const result = await checkAndIncrementDailyLimit("mbx_001", 100);
    assert.equal(result.allowed, true);
    assert.equal(result.current, 100);
  });
});

// ---------------------------------------------------------------------------
// checkAndIncrementRecipientLimit
// ---------------------------------------------------------------------------

describe("checkAndIncrementRecipientLimit", () => {
  it("returns allowed: true for existing recipient", async () => {
    mockPoolQuery = async () => ({ rows: [{ "?column?": 1 }] }); // existing recipient found

    const result = await checkAndIncrementRecipientLimit("mbx_001", "user@example.com", 50);
    assert.equal(result.allowed, true);
    assert.equal(result.current, -1);
  });

  it("returns allowed: true for new recipient under limit", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing messages to this address
      if (queryCount === 2) {
        // getMailbox
        return { rows: [{ id: "mbx_001", unique_recipients: 5 }] };
      }
      // UPDATE unique_recipients
      return { rows: [], rowCount: 1 };
    };

    const result = await checkAndIncrementRecipientLimit("mbx_001", "new@example.com", 50);
    assert.equal(result.allowed, true);
    assert.equal(result.current, 6); // 5 + 1
  });

  it("returns allowed: false for new recipient over limit", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing messages
      // getMailbox — already at limit
      return { rows: [{ id: "mbx_001", unique_recipients: 50 }] };
    };

    const result = await checkAndIncrementRecipientLimit("mbx_001", "new@example.com", 50);
    assert.equal(result.allowed, false);
    assert.equal(result.current, 50);
  });

  it("returns allowed: false when mailbox not found", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => {
      queryCount++;
      if (queryCount === 1) return { rows: [] }; // no existing messages
      return { rows: [] }; // getMailbox returns null
    };

    const result = await checkAndIncrementRecipientLimit("mbx_gone", "new@example.com", 50);
    assert.equal(result.allowed, false);
    assert.equal(result.current, 0);
  });
});

// ---------------------------------------------------------------------------
// isAddressSuppressed
// ---------------------------------------------------------------------------

describe("isAddressSuppressed", () => {
  it("returns true when address is suppressed", async () => {
    mockPoolQuery = async () => ({ rows: [{ "?column?": 1 }] });

    const result = await isAddressSuppressed("bad@example.com", "prj_001");
    assert.equal(result, true);
  });

  it("returns false when address is not suppressed", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const result = await isAddressSuppressed("good@example.com", "prj_001");
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// addSuppression
// ---------------------------------------------------------------------------

describe("addSuppression", () => {
  it("inserts global suppression", async () => {
    let calledWith: any[] = [];
    mockPoolQuery = async (...args: any[]) => {
      calledWith = args;
      return { rows: [], rowCount: 1 };
    };

    await addSuppression("bounce@example.com", "global", null, "hard bounce");
    assert.equal(calledWith[1][0], "bounce@example.com");
    assert.equal(calledWith[1][1], "global");
    assert.equal(calledWith[1][2], ""); // null project_id becomes empty string
    assert.equal(calledWith[1][3], "hard bounce");
  });

  it("inserts project-scoped suppression", async () => {
    let calledWith: any[] = [];
    mockPoolQuery = async (...args: any[]) => {
      calledWith = args;
      return { rows: [], rowCount: 1 };
    };

    await addSuppression("unsub@example.com", "project", "prj_001", "unsubscribed");
    assert.equal(calledWith[1][0], "unsub@example.com");
    assert.equal(calledWith[1][1], "project");
    assert.equal(calledWith[1][2], "prj_001");
    assert.equal(calledWith[1][3], "unsubscribed");
  });
});

// ---------------------------------------------------------------------------
// initMailboxTables
// ---------------------------------------------------------------------------

describe("initMailboxTables", () => {
  it("creates all mailbox tables and indexes", async () => {
    let queryCount = 0;
    mockPoolQuery = async () => { queryCount++; return { rows: [] }; };
    await initMailboxTables();
    assert.equal(queryCount, 9); // 4 CREATE TABLE + 5 CREATE INDEX
  });
});
