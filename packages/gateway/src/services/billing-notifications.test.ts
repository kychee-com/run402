import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSendEmail: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("./email-send.js", {
  namedExports: {
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    MailboxError: class MailboxError extends Error {
      statusCode: number;
      constructor(msg: string, code: number) { super(msg); this.statusCode = code; }
    },
  },
});

mock.module("../db/pool.js", {
  namedExports: {
    pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  },
});

mock.module("../db/sql.js", {
  namedExports: { sql: (s: string) => s },
});

mock.module("../config.js", {
  namedExports: {
    BILLING_MAILBOX_ID: "mbx_billing",
    PUBLIC_API_URL: "https://api.run402.com",
  },
});

const {
  sendVerificationEmail,
  checkBillingNotificationRateLimit,
  _resetRateLimitForTests,
} = await import("./billing-notifications.js");

// ---------------------------------------------------------------------------
// checkBillingNotificationRateLimit
// ---------------------------------------------------------------------------

describe("checkBillingNotificationRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
  });

  it("allows first request from an email", () => {
    const result = checkBillingNotificationRateLimit("user@example.com", "1.2.3.4");
    assert.equal(result.allowed, true);
  });

  it("rejects rapid second request (60s cooldown) for same email", () => {
    checkBillingNotificationRateLimit("user@example.com", "1.2.3.4");
    const result = checkBillingNotificationRateLimit("user@example.com", "1.2.3.4");
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, "per_email_cooldown");
  });

  it("enforces per-IP limit of 10/hour", () => {
    for (let i = 0; i < 10; i++) {
      const result = checkBillingNotificationRateLimit(`u${i}@example.com`, "5.6.7.8");
      assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
    }
    const result = checkBillingNotificationRateLimit("u11@example.com", "5.6.7.8");
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, "per_ip");
  });

  it("enforces global limit of 500/hour", () => {
    for (let i = 0; i < 500; i++) {
      const result = checkBillingNotificationRateLimit(`g${i}@example.com`, `10.${Math.floor(i / 10)}.${i % 10}.1`);
      assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
    }
    const result = checkBillingNotificationRateLimit("g501@example.com", "10.99.99.99");
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, "global");
  });
});

// ---------------------------------------------------------------------------
// sendVerificationEmail
// ---------------------------------------------------------------------------

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    mockSendEmail = async () => ({ messageId: "msg-1" });
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
  });

  it("sends verification email via billing mailbox", async () => {
    let sendArgs: Record<string, unknown> | null = null;
    mockSendEmail = async (opts: Record<string, unknown>) => {
      sendArgs = opts;
      return { messageId: "msg-1" };
    };

    await sendVerificationEmail("user@example.com", "token-abc", "1.2.3.4");

    assert.ok(sendArgs);
    assert.equal((sendArgs as Record<string, unknown>).mailboxId, "mbx_billing");
    assert.equal((sendArgs as Record<string, unknown>).to, "user@example.com");
  });

  it("increments verification_send_count in DB", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (sqlStr: string) => {
      queries.push(sqlStr);
      return { rows: [], rowCount: 1 };
    };

    await sendVerificationEmail("user@example.com", "token-abc", "1.2.3.4");

    const updateQuery = queries.find(q => q.includes("UPDATE") && q.includes("billing_account_emails"));
    assert.ok(updateQuery, "should update verification counters");
    assert.ok(updateQuery!.includes("verification_send_count"));
    assert.ok(updateQuery!.includes("last_verification_sent_at"));
  });

  it("rejects rate-limited request without sending", async () => {
    let sendCalled = false;
    mockSendEmail = async () => { sendCalled = true; return { messageId: "x" }; };

    await sendVerificationEmail("user@example.com", "token-1", "1.2.3.4");
    sendCalled = false; // reset

    await assert.rejects(
      async () => await sendVerificationEmail("user@example.com", "token-2", "1.2.3.4"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 429,
    );
    assert.equal(sendCalled, false, "second send should not be called");
  });
});
