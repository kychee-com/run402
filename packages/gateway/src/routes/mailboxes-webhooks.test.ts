import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockGetMailbox: (id: string) => Promise<unknown>;
let mockPoolQuery: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  },
});
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
    getMessageRaw: async () => null,
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
    _headers: {} as Record<string, string>,
    status(c: number) { res._status = c; return res; },
    json(o: unknown) { res._body = o; return res; },
    set(k: string, v: string) { res._headers[k] = v; return res; },
    send(payload: unknown) { res._body = payload; return res; },
    end() { return res; },
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
  await new Promise(r => setTimeout(r, 50));
  return error;
}

// ---------------------------------------------------------------------------
// GET /mailboxes/v1/:id/webhooks — list webhooks
// ---------------------------------------------------------------------------

const LIST_PATH = "/mailboxes/v1/:id/webhooks";

describe("GET /mailboxes/v1/:id/webhooks", () => {
  beforeEach(() => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "proj1", status: "active" });
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
  });

  it("returns empty array when no webhooks exist", async () => {
    const req = fakeReq({ params: { id: "mbx_1" } });
    const res = fakeRes();
    const err = await call("get", LIST_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { webhooks: [] });
  });

  it("returns webhooks with correct shape", async () => {
    mockPoolQuery = async () => ({
      rows: [
        { id: "whk_1", url: "https://example.com/hook", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" },
      ],
      rowCount: 1,
    });
    const req = fakeReq({ params: { id: "mbx_1" } });
    const res = fakeRes();
    const err = await call("get", LIST_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.equal(res._body.webhooks.length, 1);
    assert.equal(res._body.webhooks[0].webhook_id, "whk_1");
    assert.equal(res._body.webhooks[0].url, "https://example.com/hook");
    assert.deepEqual(res._body.webhooks[0].events, ["delivery"]);
    assert.equal(res._body.webhooks[0].created_at, "2026-01-01T00:00:00Z");
  });

  it("returns 404 when mailbox does not exist", async () => {
    mockGetMailbox = async () => null;
    const req = fakeReq({ params: { id: "mbx_1" } });
    const res = fakeRes();
    const err = await call("get", LIST_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 403 when mailbox belongs to different project", async () => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "other_proj", status: "active" });
    const req = fakeReq({ params: { id: "mbx_1" } });
    const res = fakeRes();
    const err = await call("get", LIST_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// GET /mailboxes/v1/:id/webhooks/:webhook_id — get single webhook
// ---------------------------------------------------------------------------

const GET_PATH = "/mailboxes/v1/:id/webhooks/:webhook_id";

describe("GET /mailboxes/v1/:id/webhooks/:webhook_id", () => {
  beforeEach(() => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "proj1", status: "active" });
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
  });

  it("returns webhook on success", async () => {
    mockPoolQuery = async () => ({
      rows: [{ id: "whk_1", url: "https://example.com/hook", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" }],
      rowCount: 1,
    });
    const req = fakeReq({ params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("get", GET_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.equal(res._body.webhook_id, "whk_1");
  });

  it("returns 404 when webhook does not exist", async () => {
    const req = fakeReq({ params: { id: "mbx_1", webhook_id: "whk_missing" } });
    const res = fakeRes();
    const err = await call("get", GET_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 404 when mailbox does not exist", async () => {
    mockGetMailbox = async () => null;
    const req = fakeReq({ params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("get", GET_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 403 when mailbox belongs to different project", async () => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "other_proj", status: "active" });
    const req = fakeReq({ params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("get", GET_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /mailboxes/v1/:id/webhooks/:webhook_id — delete webhook
// ---------------------------------------------------------------------------

const DELETE_PATH = "/mailboxes/v1/:id/webhooks/:webhook_id";

describe("DELETE /mailboxes/v1/:id/webhooks/:webhook_id", () => {
  beforeEach(() => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "proj1", status: "active" });
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
  });

  it("returns 204 on successful delete", async () => {
    const req = fakeReq({ method: "DELETE", params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("delete", DELETE_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 204);
  });

  it("returns 204 when webhook already deleted (idempotent)", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const req = fakeReq({ method: "DELETE", params: { id: "mbx_1", webhook_id: "whk_missing" } });
    const res = fakeRes();
    const err = await call("delete", DELETE_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 204);
  });

  it("returns 404 when mailbox does not exist", async () => {
    mockGetMailbox = async () => null;
    const req = fakeReq({ method: "DELETE", params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("delete", DELETE_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 403 when mailbox belongs to different project", async () => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "other_proj", status: "active" });
    const req = fakeReq({ method: "DELETE", params: { id: "mbx_1", webhook_id: "whk_1" } });
    const res = fakeRes();
    const err = await call("delete", DELETE_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /mailboxes/v1/:id/webhooks/:webhook_id — update webhook
// ---------------------------------------------------------------------------

const PATCH_PATH = "/mailboxes/v1/:id/webhooks/:webhook_id";

describe("PATCH /mailboxes/v1/:id/webhooks/:webhook_id", () => {
  beforeEach(() => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "proj1", status: "active" });
    mockPoolQuery = async () => ({
      rows: [{ id: "whk_1", url: "https://new.example.com/hook", events: ["delivery"], created_at: "2026-01-01T00:00:00Z" }],
      rowCount: 1,
    });
  });

  it("updates url only", async () => {
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { url: "https://new.example.com/hook" } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.equal(res._body.webhook_id, "whk_1");
  });

  it("updates events only", async () => {
    mockPoolQuery = async () => ({
      rows: [{ id: "whk_1", url: "https://example.com/hook", events: ["bounced"], created_at: "2026-01-01T00:00:00Z" }],
      rowCount: 1,
    });
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { events: ["bounced"] } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
  });

  it("updates both url and events", async () => {
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { url: "https://new.example.com/hook", events: ["delivery", "bounced"] } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
  });

  it("returns 400 when no fields provided", async () => {
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: {} });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 400 on invalid event name", async () => {
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { events: ["invalid_event"] } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 400 on invalid url", async () => {
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { url: "not-a-url" } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 404 when webhook does not exist", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_missing" }, body: { url: "https://example.com" } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });

  it("returns 403 when mailbox belongs to different project", async () => {
    mockGetMailbox = async () => ({ id: "mbx_1", slug: "test", project_id: "other_proj", status: "active" });
    const req = fakeReq({ method: "PATCH", params: { id: "mbx_1", webhook_id: "whk_1" }, body: { url: "https://example.com" } });
    const res = fakeRes();
    const err = await call("patch", PATCH_PATH, req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });
});
