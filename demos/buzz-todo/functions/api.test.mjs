// node --test demos/buzz-todo/functions/api.test.mjs
// Needs @noble/curves and @scure/base resolvable from this directory.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  MCP_PROTOCOL_VERSIONS,
  MCP_TOOLS,
  mcpDispatch,
  serveMcp,
  signNostrEvent,
  verifyNip98Request,
  verifyOwnerAttestation,
} from "./api.mjs";

// NIP-OA's published test keys.
const OWNER = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER_PUB = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT = "0000000000000000000000000000000000000000000000000000000000000002";
const AGENT_PUB = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const URL_ = "https://buzz-todo.run402.com/api/mcp";
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function attestation(agentPub, conditions = "", ownerPriv = OWNER) {
  const digest = sha256(`nostr:agent-auth:${agentPub}:${conditions}`);
  const sig = Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), Buffer.from(ownerPriv, "hex"))).toString("hex");
  return ["auth", Buffer.from(schnorr.getPublicKey(Buffer.from(ownerPriv, "hex"))).toString("hex"), conditions, sig];
}

function header(event) {
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

function request(body, { priv = AGENT, url = URL_, method = "POST", extra = [], createdAt } = {}) {
  const tags = [["u", url], ["method", method], ["payload", sha256(body)], ...extra];
  return signNostrEvent(priv, 27235, tags, "", createdAt);
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return "no error";
}

describe("NIP-OA owner attestation", () => {
  it("accepts the NIP's published vector", () => {
    const event = {
      pubkey: AGENT_PUB,
      created_at: 1713956400,
      kind: 1,
      tags: [["auth", OWNER_PUB, "kind=1&created_at<1713957000", "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369"]],
    };
    assert.equal(verifyOwnerAttestation(event), OWNER_PUB);
  });

  it("returns null when there is no auth tag", () => {
    assert.equal(verifyOwnerAttestation({ pubkey: AGENT_PUB, kind: 27235, created_at: 1, tags: [["u", URL_]] }), null);
  });

  it("rejects the NIP's invalid vectors", () => {
    const base = { pubkey: AGENT_PUB, kind: 1, created_at: 1713956400 };
    const valid = attestation(AGENT_PUB, "kind=1");
    for (const tags of [
      [valid, valid],
      [valid.slice(0, 3)],
      [attestation(AGENT_PUB, "kind=1&")],
      [attestation(AGENT_PUB, "kind=01")],
      [attestation(AGENT_PUB, "", AGENT)], // self-attestation
      [attestation(AGENT_PUB, "kind=1&color=red")],
    ]) {
      assert.equal(codeOf(() => verifyOwnerAttestation({ ...base, tags })), "NOSTR_AUTH_ATTESTATION_INVALID", JSON.stringify(tags));
    }
  });

  it("rejects conditions the event does not satisfy, and a forged owner", () => {
    const base = { pubkey: AGENT_PUB, kind: 27235, created_at: 1713956400 };
    assert.equal(codeOf(() => verifyOwnerAttestation({ ...base, tags: [attestation(AGENT_PUB, "kind=1")] })), "NOSTR_AUTH_ATTESTATION_INVALID");
    const forged = attestation(AGENT_PUB);
    forged[1] = "f".repeat(63) + "e";
    assert.equal(codeOf(() => verifyOwnerAttestation({ ...base, tags: [forged] })), "NOSTR_AUTH_ATTESTATION_INVALID");
  });
});

describe("NIP-98 request verification", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const verify = (event, overrides = {}) =>
    verifyNip98Request(header(event), { url: URL_, method: "POST", body, ...overrides });

  it("an agent without an attestation works on its own list", () => {
    const auth = verify(request(body));
    assert.deepEqual([auth.actor, auth.owner, auth.user], [AGENT_PUB, null, AGENT_PUB]);
  });

  it("an owner-attested agent works on its owner's list", () => {
    const auth = verify(request(body, { extra: [attestation(AGENT_PUB)] }));
    assert.deepEqual([auth.actor, auth.owner, auth.user], [AGENT_PUB, OWNER_PUB, OWNER_PUB]);
  });

  it("binds the URL, method, body and time", () => {
    assert.equal(codeOf(() => verify(request(body, { url: "https://evil.run402.com/api/mcp" }))), "NOSTR_AUTH_MISMATCH");
    assert.equal(codeOf(() => verify(request(body, { method: "GET" }))), "NOSTR_AUTH_MISMATCH");
    assert.equal(codeOf(() => verify(request(body), { body: `${body} ` })), "NOSTR_AUTH_MISMATCH");
    const old = Math.floor(Date.now() / 1000) - 120;
    assert.equal(codeOf(() => verify(request(body, { createdAt: old }))), "NOSTR_AUTH_STALE");
  });

  it("rejects tampering, a missing header, and stray tags", () => {
    const event = request(body);
    assert.equal(codeOf(() => verify({ ...event, sig: event.sig.replace(/^./, event.sig[0] === "a" ? "b" : "a") })), "NOSTR_AUTH_INVALID");
    assert.equal(codeOf(() => verify({ ...event, created_at: event.created_at + 1 })), "NOSTR_AUTH_INVALID");
    assert.equal(codeOf(() => verifyNip98Request(undefined, { url: URL_, method: "POST", body })), "NOSTR_AUTH_REQUIRED");
    assert.equal(codeOf(() => verify(request(body, { extra: [["p", OWNER_PUB]] }))), "NOSTR_AUTH_INVALID");
    assert.equal(codeOf(() => verify(request(body, { extra: [["u", URL_]] }))), "NOSTR_AUTH_INVALID");
  });
});

describe("MCP dispatch", () => {
  function memoryStore() {
    const rows = [];
    return {
      rows,
      list: async () => rows.map((r) => ({ ...r })),
      add: async (title) => {
        const row = { id: randomUUID(), title, done: false, created_at: new Date().toISOString() };
        rows.push(row);
        return { ...row };
      },
      setDone: async (id, done) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return null;
        row.done = done;
        return { ...row };
      },
      remove: async (id) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i < 0) return false;
        rows.splice(i, 1);
        return true;
      },
    };
  }
  const call = (store, name, args, id = 7) =>
    mcpDispatch({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, store);

  it("negotiates the protocol version and lists the tools", async () => {
    const store = memoryStore();
    const init = await mcpDispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, store);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    const unknown = await mcpDispatch({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, store);
    assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
    const list = await mcpDispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" }, store);
    assert.deepEqual(list.result.tools.map((t) => t.name), ["list_tasks", "add_task", "complete_task", "delete_task"]);
    for (const tool of MCP_TOOLS) assert.match(tool.name, /^[a-z_]{1,64}$/);
  });

  it("adds, lists, completes and deletes tasks", async () => {
    const store = memoryStore();
    const added = await call(store, "add_task", { title: "  Buy milk " });
    const { id } = added.result.structuredContent.task;
    assert.equal(added.result.isError, false);
    assert.equal(store.rows[0].title, "Buy milk");
    await call(store, "add_task", { title: "Call mom" });
    const done = await call(store, "complete_task", { id });
    assert.equal(done.result.structuredContent.task.done, true);
    const open = await call(store, "list_tasks", { include_done: false });
    assert.deepEqual(open.result.structuredContent.tasks.map((t) => t.title), ["Call mom"]);
    assert.deepEqual(JSON.parse(open.result.content[0].text), open.result.structuredContent);
    const undone = await call(store, "complete_task", { id, done: false });
    assert.equal(undone.result.structuredContent.task.done, false);
    assert.deepEqual((await call(store, "delete_task", { id })).result.structuredContent, { deleted: id });
    assert.equal(store.rows.length, 1);
  });

  it("reports bad arguments as tool errors, unknown tools and methods as protocol errors", async () => {
    const store = memoryStore();
    assert.equal((await call(store, "add_task", { title: "" })).result.isError, true);
    assert.equal((await call(store, "add_task", { title: "x", owner: "me" })).result.isError, true);
    assert.equal((await call(store, "complete_task", { id: "nope" })).result.isError, true);
    assert.equal((await call(store, "delete_task", { id: randomUUID() })).result.isError, true);
    assert.equal((await call(store, "drop_tables", {})).error.code, -32602);
    assert.equal((await mcpDispatch({ jsonrpc: "2.0", id: 9, method: "resources/list" }, store)).error.code, -32601);
    assert.equal((await mcpDispatch([{ jsonrpc: "2.0", id: 1, method: "ping" }], store)).error.code, -32600);
    assert.equal(await mcpDispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, store), null);
  });
});

describe("POST /api/mcp", () => {
  // Just enough of db.sql for the MCP path: seen ids, user upserts, tasks.
  function fakeDb() {
    const seen = new Set();
    const users = new Set();
    const tasks = [];
    return {
      tasks,
      users,
      sql: async (text, params = []) => {
        if (text.startsWith("INSERT INTO buzz_nostr_auth_seen")) {
          if (seen.has(params[0])) return { rows: [] };
          seen.add(params[0]);
          return { rows: [{ event_id: params[0] }] };
        }
        if (text.startsWith("DELETE FROM buzz_nostr_auth_seen")) return { rows: [] };
        if (text.startsWith("INSERT INTO buzz_users")) {
          users.add(params[0]);
          return { rows: [] };
        }
        if (text.startsWith("INSERT INTO tasks")) {
          const row = { id: randomUUID(), pubkey: params[0], title: params[1], done: false, created_at: "now" };
          tasks.push(row);
          return { rows: [row] };
        }
        if (text.startsWith("SELECT id, title, done, created_at FROM tasks")) return { rows: tasks.filter((t) => t.pubkey === params[0]) };
        throw new Error(`unexpected SQL: ${text}`);
      },
    };
  }
  const ctx = { host: "buzz-todo.run402.com" };
  function post(body, event) {
    return new Request("http://internal/api/mcp", { method: "POST", headers: { authorization: header(event) }, body });
  }

  it("runs a signed agent call on the owner's list and refuses a replay", async () => {
    const db = fakeDb();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_task", arguments: { title: "Water plants" } } });
    const event = request(body, { extra: [attestation(AGENT_PUB)] });
    const res = await serveMcp(post(body, event), ctx, db);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.structuredContent.task.title, "Water plants");
    assert.deepEqual(db.tasks.map((t) => t.pubkey), [OWNER_PUB]);
    assert.deepEqual([...db.users], [OWNER_PUB]);
    const replay = await serveMcp(post(body, event), ctx, db);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, "NOSTR_AUTH_REPLAYED");
    assert.equal(db.tasks.length, 1);
  });

  it("answers 401 with WWW-Authenticate before touching the store, and 202 to notifications", async () => {
    const db = fakeDb();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const wrongHost = request(body, { url: "https://other.run402.com/api/mcp" });
    const denied = await serveMcp(post(body, wrongHost), ctx, db);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), "Nostr");
    assert.equal(db.users.size, 0);
    const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal((await serveMcp(post(note, request(note)), ctx, db)).status, 202);
  });
});
