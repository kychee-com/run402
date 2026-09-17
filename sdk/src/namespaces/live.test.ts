import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import type { LiveEvent } from "./live.types.js";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const credentials: CredentialsProvider = {
    async getAuth() { return { "SIGN-IN-WITH-X": "wallet" }; },
    async getProjectCredentials(id: string) {
      return id === "prj_1" ? { project_id: id, anon_key: "anon-key", service_key: "service-key" } : null;
    },
  } as unknown as CredentialsProvider;
  return new Run402({ credentials, apiBase: "https://api.example", fetch: fetchImpl });
}

describe("live.changes", () => {
  it("issues the held read with the project's anon key and passes cursor and wait", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const r = makeSdk(async (input, init) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(JSON.stringify({ changes: [], cursor: "0000abcd-4", resync: false, waited_seconds: 5 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const page = await r.project("prj_1").then((p) => p.live.changes({ tables: ["cells", "notes"], cursor: "0000abcd-3", wait: 5 }));
    assert.equal(page.cursor, "0000abcd-4");
    assert.equal(calls[0].url, "https://api.example/live/v1/changes?project_id=prj_1&tables=cells%2Cnotes&cursor=0000abcd-3&wait=5");
    assert.equal(calls[0].headers.apikey, "anon-key");
    assert.equal(calls[0].headers["sign-in-with-x"], undefined, "the apikey owns the credential family");
  });

  it("uses the service key for the service audience and a Bearer for a user", async () => {
    const seen: Array<Record<string, string>> = [];
    const r = makeSdk(async (_input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JSON.stringify({ changes: [], cursor: "c", resync: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await r.live.changes("prj_1", { tables: ["cells"], as: "service" });
    await r.live.changes("prj_1", { tables: ["cells"], as: "user", accessToken: "user-jwt" });
    assert.equal(seen[0].apikey, "service-key");
    assert.equal(seen[1].apikey, "anon-key");
    assert.equal(seen[1].authorization, "Bearer user-jwt");
  });

  it("refuses an empty table list locally", async () => {
    const r = makeSdk(async () => new Response("{}", { status: 200 }));
    await assert.rejects(() => r.live.changes("prj_1", { tables: [] }), /non-empty array/);
  });
});

describe("live.subscribe", () => {
  it("parses the stream, reconnects with Last-Event-ID after the server's reconnect, and honors retry", async () => {
    const calls: Array<Record<string, string>> = [];
    let n = 0;
    const r = makeSdk(async (_input, init) => {
      calls.push(Object.fromEntries(new Headers(init?.headers).entries()));
      n += 1;
      if (n === 1) {
        return new Response(sseBody([
          "retry: 10\nevent: ready\nid: 0000abcd-0\ndata: {\"cursor\":\"0000abcd-0\",\"tables\":[\"cells\"]}\n\n",
          ": heartbeat\n\n",
          "event: change\nid: 0000abcd-1\ndata: {\"table\":\"cells\",\"op\":\"insert\",\"pk\":[{\"id\":1}],\"n\":1}\n\n",
          "event: reconnect\ndata: {\"reason\":\"max_lifetime\",\"cursor\":\"0000abcd-1\"}\n\n",
        ]), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(sseBody([
        "event: resync\ndata: {\"tables\":[\"cells\"],\"reason\":\"foreign_epoch\"}\n\nevent: ready\nid: ffff0000-0\ndata: {\"cursor\":\"ffff0000-0\",\"tables\":[\"cells\"]}\n\n",
      ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const events: LiveEvent[] = [];
    const sub = r.live.subscribe("prj_1", { tables: ["cells"] }, (e) => {
      events.push(e);
      if (e.type === "ready" && e.cursor === "ffff0000-0") sub.close();
    });
    await sub.done;
    assert.deepEqual(events.map((e) => e.type), ["ready", "change", "reconnect", "resync", "ready"]);
    const change = events[1] as Extract<LiveEvent, { type: "change" }>;
    assert.deepEqual(change.change, { table: "cells", op: "insert", pk: [{ id: 1 }], n: 1, cursor: "0000abcd-1" });
    assert.equal(calls[0].accept, "text/event-stream");
    assert.equal(calls[0].apikey, "anon-key");
    assert.equal(calls[0]["last-event-id"], undefined);
    assert.equal(calls[1]["last-event-id"], "0000abcd-1", "reconnects from the last cursor");
  });

  it("surfaces a non-retryable refusal as the gateway's error", async () => {
    const r = makeSdk(async () =>
      new Response(JSON.stringify({ error: 'Table "audit" is not live', code: "TABLE_NOT_LIVE" }), { status: 403, headers: { "content-type": "application/json" } }));
    const sub = r.live.subscribe("prj_1", { tables: ["audit"] }, () => {});
    await assert.rejects(() => sub.done, (err: unknown) => /not live|TABLE_NOT_LIVE/.test(String((err as Error).message)) || (err as { code?: string }).code === "TABLE_NOT_LIVE");
  });

  it("backs off on 429 with Retry-After and stops when closed", async () => {
    const events: LiveEvent[] = [];
    const r = makeSdk(async () => new Response("{}", { status: 429, headers: { "retry-after": "1" } }));
    const sub = r.live.subscribe("prj_1", { tables: ["cells"] }, (e) => {
      events.push(e);
      sub.close();
    });
    await sub.done;
    assert.equal(events[0].type, "disconnected");
    assert.equal((events[0] as Extract<LiveEvent, { type: "disconnected" }>).retry_in_ms, 1000);
  });
});
