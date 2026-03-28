import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
let mockGetMailbox: (id: string) => Promise<unknown>;
let mockCheckDaily: (...args: unknown[]) => Promise<unknown>;
let mockCheckRecipient: (...args: unknown[]) => Promise<unknown>;
let mockIsSuppressed: (...args: unknown[]) => Promise<boolean>;
let mockGetProjectById: (id: string) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesSend: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: unknown[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: {
    sql: (s: string) => s,
  },
});

mock.module("./mailbox.js", {
  namedExports: {
    getMailbox: (id: string) => mockGetMailbox(id),
    checkAndIncrementDailyLimit: (...args: unknown[]) => mockCheckDaily(...args),
    checkAndIncrementRecipientLimit: (...args: unknown[]) => mockCheckRecipient(...args),
    isAddressSuppressed: (...args: unknown[]) => mockIsSuppressed(...args),
    formatAddress: (slug: string) => `${slug}@mail.run402.com`,
    MailboxError: class MailboxError extends Error {
      statusCode: number;
      constructor(msg: string, code: number) { super(msg); this.statusCode = code; }
    },
  },
});

mock.module("./projects.js", {
  namedExports: {
    getProjectById: (id: string) => mockGetProjectById(id),
    projectCache: { get: () => undefined },
  },
});

mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      send(...args: unknown[]) { return mockSesSend(...args); }
    },
    SendEmailCommand: class {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  },
});

const { sendEmail, stripHtml } = await import("./email-send.js");
const { TIERS } = await import("@run402/shared");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults() {
  mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "prj_1", status: "active" });
  mockGetProjectById = async () => ({ id: "prj_1", tier: "team", status: "active" });
  mockCheckDaily = async () => ({ allowed: true, current: 1, resetsAt: "2026-04-01T00:00:00Z" });
  mockCheckRecipient = async () => ({ allowed: true, current: 1 });
  mockIsSuppressed = async () => false;
  mockPoolQuery = async () => ({ rows: [] });
  mockSesSend = async () => ({ MessageId: "ses_123" });
}

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  it("strips basic tags", () => {
    assert.equal(stripHtml("<p>Hello</p><p>World</p>"), "Hello\n\nWorld");
  });

  it("strips style and script blocks", () => {
    const html = "<style>body{color:red}</style><script>alert(1)</script><p>ok</p>";
    assert.equal(stripHtml(html), "ok");
  });

  it("converts br to newline", () => {
    assert.equal(stripHtml("line1<br>line2<br/>line3"), "line1\nline2\nline3");
  });

  it("decodes common entities", () => {
    assert.equal(stripHtml("&amp; &lt; &gt; &quot; &nbsp;"), '& < > "');
  });

  it("collapses excessive newlines", () => {
    assert.equal(stripHtml("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
  });
});

// ---------------------------------------------------------------------------
// sendEmail — raw mode
// ---------------------------------------------------------------------------

describe("sendEmail — raw mode", () => {
  beforeEach(setupDefaults);

  it("sends raw HTML email successfully", async () => {
    const result = await sendEmail({
      mailboxId: "mbx_1",
      to: "alice@example.com",
      subject: "Hello!",
      html: "<h1>Hi</h1>",
    });
    assert.equal(result.status, "sent");
    assert.equal(result.template, null);
    assert.ok(result.message_id.startsWith("msg_"));
    assert.equal(result.to, "alice@example.com");
    assert.equal(result.subject, "Hello!");
  });

  it("rejects missing subject in raw mode", async () => {
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", html: "<p>hi</p>" } as never),
      (err: Error) => err.message.includes("Subject is required"),
    );
  });

  it("rejects missing html in raw mode", async () => {
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi" } as never),
      (err: Error) => err.message.includes("HTML body is required"),
    );
  });

  it("rejects html exceeding 1MB", async () => {
    const bigHtml = "x".repeat(1_048_577);
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: bigHtml }),
      (err: Error) => err.message.includes("1MB"),
    );
  });

  it("rejects subject exceeding 998 chars", async () => {
    const longSubject = "x".repeat(999);
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: longSubject, html: "<p>hi</p>" }),
      (err: Error) => err.message.includes("998"),
    );
  });

  it("auto-generates plaintext from html when text omitted", async () => {
    let storedTextBody = "";
    mockPoolQuery = async (_q: unknown, params?: unknown[]) => {
      if (Array.isArray(params) && params.length >= 7) storedTextBody = params[6] as string;
      return { rows: [] };
    };
    await sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: "<h1>Hello</h1><p>World</p>" });
    assert.ok(storedTextBody.includes("Hello"));
    assert.ok(storedTextBody.includes("World"));
    assert.ok(storedTextBody.includes("run402.com")); // footer
  });

  it("uses provided text when given", async () => {
    let storedTextBody = "";
    mockPoolQuery = async (_q: unknown, params?: unknown[]) => {
      if (Array.isArray(params) && params.length >= 7) storedTextBody = params[6] as string;
      return { rows: [] };
    };
    await sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: "<p>html</p>", text: "custom plain" });
    assert.ok(storedTextBody.includes("custom plain"));
  });
});

// ---------------------------------------------------------------------------
// sendEmail — from_name validation
// ---------------------------------------------------------------------------

describe("sendEmail — from_name", () => {
  beforeEach(setupDefaults);

  it("rejects from_name with angle brackets", async () => {
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: "<p>hi</p>", from_name: 'Evil <script>' }),
      (err: Error) => err.message.includes("invalid characters"),
    );
  });

  it("rejects from_name with double quotes", async () => {
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: "<p>hi</p>", from_name: 'Has "quotes"' }),
      (err: Error) => err.message.includes("invalid characters"),
    );
  });

  it("rejects from_name exceeding 78 chars", async () => {
    await assert.rejects(
      () => sendEmail({ mailboxId: "mbx_1", to: "a@b.com", subject: "Hi", html: "<p>hi</p>", from_name: "x".repeat(79) }),
      (err: Error) => err.message.includes("78"),
    );
  });

  it("applies display name to template mode", async () => {
    let sesFromAddress = "";
    mockSesSend = async (cmd: { input?: { FromEmailAddress?: string } }) => {
      sesFromAddress = cmd?.input?.FromEmailAddress || "";
      return { MessageId: "ses_456" };
    };
    await sendEmail({
      mailboxId: "mbx_1",
      to: "a@b.com",
      template: "notification",
      variables: { project_name: "Test", message: "hello" },
      from_name: "My App",
    });
    assert.ok(sesFromAddress.includes('"My App"'));
    assert.ok(sesFromAddress.includes("test@mail.run402.com"));
  });
});

// ---------------------------------------------------------------------------
// sendEmail — mode detection
// ---------------------------------------------------------------------------

describe("sendEmail — mode detection", () => {
  beforeEach(setupDefaults);

  it("uses template mode when template is present", async () => {
    const result = await sendEmail({
      mailboxId: "mbx_1",
      to: "a@b.com",
      template: "notification",
      variables: { project_name: "Test", message: "hello" },
    });
    assert.equal(result.template, "notification");
  });

  it("uses raw mode when subject + html are present without template", async () => {
    const result = await sendEmail({
      mailboxId: "mbx_1",
      to: "a@b.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });
    assert.equal(result.template, null);
  });

  it("template takes precedence when both template and html are present", async () => {
    const result = await sendEmail({
      mailboxId: "mbx_1",
      to: "a@b.com",
      template: "notification",
      variables: { project_name: "Test", message: "hi" },
      subject: "Ignored",
      html: "<p>ignored</p>",
    });
    assert.equal(result.template, "notification");
  });

  it("backwards-compatible 4-arg signature still works", async () => {
    const result = await sendEmail("mbx_1", "notification", "a@b.com", { project_name: "Test", message: "hello" });
    assert.equal(result.template, "notification");
    assert.equal(result.to, "a@b.com");
  });
});

// ---------------------------------------------------------------------------
// Team tier emailsPerDay
// ---------------------------------------------------------------------------

describe("team tier config", () => {
  it("has emailsPerDay of 500", () => {
    assert.equal(TIERS.team.emailsPerDay, 500);
  });
});
