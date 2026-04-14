import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockGetMailbox: (id: string) => Promise<unknown>;
let mockGetMessageRaw: (mailboxId: string, messageId: string) => Promise<unknown>;

mock.module("../db/pool.js", { namedExports: { pool: { query: async () => ({ rows: [] }) } } });
mock.module("../db/sql.js", { namedExports: { sql: (s: string) => s } });

mock.module("../services/mailbox.js", {
  namedExports: {
    getMailbox: (id: string) => mockGetMailbox(id),
    formatAddress: (slug: string) => `${slug}@mail.run402.com`,
    validateSlug: () => null,
    createMailbox: async () => ({}),
    listMailboxes: async () => [],
    deleteMailbox: async () => true,
    reactivateMailbox: async () => true,
    MailboxError: class MailboxError extends Error {
      statusCode: number;
      constructor(msg: string, code: number) { super(msg); this.statusCode = code; }
    },
  },
});

mock.module("../services/email-send.js", {
  namedExports: {
    sendEmail: async () => ({}),
    listMessages: async () => ({ messages: [], has_more: false, next_cursor: null }),
    getMessage: async () => null,
    getMessageRaw: (mailboxId: string, messageId: string) => mockGetMessageRaw(mailboxId, messageId),
  },
});

mock.module("../middleware/apikey.js", {
  namedExports: {
    serviceKeyAuth: (_r: unknown, _s: unknown, n: () => void) => n(),
  },
});

mock.module("../middleware/admin-auth.js", {
  namedExports: {
    serviceKeyOrAdmin: (_r: unknown, _s: unknown, n: () => void) => n(),
  },
});

mock.module("../middleware/lifecycle-gate.js", {
  namedExports: {
    lifecycleGate: (_r: unknown, _s: unknown, n: () => void) => n(),
  },
});

const { default: router } = await import("./mailboxes.js");
const { MailboxError } = await import("../services/mailbox.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}) {
  return {
    method: "GET",
    params: {},
    body: {},
    project: { id: "proj1" },
    ...overrides,
  };
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> = {
    _status: 200,
    _body: null,
    _bodyBuffer: null as Buffer | null,
    _headers: {} as Record<string, string>,
    status(c: number) { res._status = c; return res; },
    json(o: unknown) { res._body = o; return res; },
    set(k: string, v: string) { res._headers[k] = v; return res; },
    setHeader(k: string, v: string) { res._headers[k] = v; return res; },
    type(t: string) { res._headers["Content-Type"] = t; return res; },
    send(payload: unknown) {
      if (Buffer.isBuffer(payload)) res._bodyBuffer = payload;
      else res._body = payload;
      return res;
    },
    end(payload?: unknown) {
      if (payload && Buffer.isBuffer(payload)) res._bodyBuffer = payload;
      return res;
    },
  };
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(method: string, path: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, req: any, res: any): Promise<any> {
  const handler = findHandler(method, path);
  assert.ok(handler, `handler for ${method} ${path} should exist`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let error: any = undefined;
  const next = (e?: unknown) => { error = e; };
  handler(req, res, next);
  // asyncHandler wraps the route in fn(...).catch(next) — give the microtask
  // queue a moment to settle so thrown HttpErrors land in `error`.
  await new Promise(r => setTimeout(r, 50));
  return error;
}

// ---------------------------------------------------------------------------
// GET /v1/mailboxes/:id/messages/:messageId/raw
// ---------------------------------------------------------------------------

const PATH = "/mailboxes/v1/:id/messages/:messageId/raw";
const VALID_MSG_ID = "11111111-1111-1111-1111-111111111111";

describe("GET /v1/mailboxes/:id/messages/:messageId/raw", () => {
  beforeEach(() => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "proj1", status: "active" });
    mockGetMessageRaw = async () => null;
  });

  it("returns 404 when mailbox does not exist", async () => {
    mockGetMailbox = async () => null;
    const req = fakeReq({ params: { id: "mbx_1", messageId: VALID_MSG_ID } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 403 when mailbox belongs to a different project", async () => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "other_proj", status: "active" });
    const req = fakeReq({ params: { id: "mbx_1", messageId: VALID_MSG_ID } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });

  it("returns 404 when service returns null (outbound, missing s3_key, etc.)", async () => {
    mockGetMessageRaw = async () => null;
    const req = fakeReq({ params: { id: "mbx_1", messageId: VALID_MSG_ID } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 200 with message/rfc822 and exact bytes on success", async () => {
    const fixture = Buffer.from("DKIM-Signature: v=1\r\nFrom: a@b.com\r\n\r\nI APPROVE\r\n", "utf-8");
    mockGetMessageRaw = async () => ({ bytes: fixture, contentLength: fixture.length });
    const req = fakeReq({ params: { id: "mbx_1", messageId: VALID_MSG_ID } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.equal(err, undefined, "no error expected");
    assert.equal(res._status, 200);
    assert.equal(res._headers["Content-Type"], "message/rfc822");
    assert.ok(res._bodyBuffer, "expected a Buffer body");
    assert.equal(Buffer.compare(res._bodyBuffer as Buffer, fixture), 0);
    assert.equal(res._headers["Content-Length"], String(fixture.length));
  });

  it("translates 413 MailboxError into HttpError 413", async () => {
    mockGetMessageRaw = async () => {
      throw new (MailboxError as new (m: string, c: number) => Error)(
        "Raw MIME exceeds 10MB limit (10485761 bytes)",
        413,
      );
    };
    const req = fakeReq({ params: { id: "mbx_1", messageId: VALID_MSG_ID } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 413);
    assert.ok(err.message.includes("10MB"));
  });

  it("rejects an invalid (non-UUID) messageId", async () => {
    const req = fakeReq({ params: { id: "mbx_1", messageId: "not-a-uuid" } });
    const res = fakeRes();
    const err = await call("get", PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });
});
