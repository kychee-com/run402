import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isApiError, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSdk(fetch: typeof globalThis.fetch, opts: { principal?: boolean; capabilities?: { returnSecrets: boolean } } = {}): Run402 {
  const principal = opts.principal ?? true;
  const creds: CredentialsProvider = {
    async getAuth() {
      return principal ? { "SIGN-IN-WITH-X": "test-siwx" } : null;
    },
    async getProjectCredentials(id) {
      return { anon_key: `anon-${id}`, service_key: `svc-${id}` };
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch, ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) });
}

const BASE = "https://api.example.test/projects/v1/prj_kiwi/app-repos";
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const REPO = {
  repo_name: "default",
  head: HEAD,
  seq: 3,
  commit_count: 3,
  size_bytes: 2048,
  size: "2.0 kB",
  clone_url: `${BASE}/default.git`,
  created_at: "2026-10-27T08:00:00.000Z",
  updated_at: "2026-10-27T09:00:00.000Z",
};

const COMMIT = {
  commit: HEAD,
  parent: null,
  seq: 1,
  author: { name: "Ada", email: "u_1@users.prj_kiwi.run402.com" },
  committer: { name: "kiwi", email: "prj_kiwi@app-repos.run402.com" },
  message: "Update people/a.json\n\nRun402-Actor: u_1",
  committed_at: "2026-10-27T09:00:00.000Z",
  paths: ["people/a.json"],
  paths_total: 1,
  actor_user_id: "u_1",
};

describe("appRepos SDK", () => {
  it("list GETs the collection with the caller's principal", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ app_repos: [REPO] }));
    const result = await makeSdk(fetch).appRepos.list("prj_kiwi");
    assert.equal(result.app_repos[0]!.repo_name, "default");
    assert.equal(calls[0]!.url, BASE);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
  });

  it("falls back to the project's cached service key when no principal is configured", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(REPO));
    await makeSdk(fetch, { principal: false }).appRepos.get("prj_kiwi", "default");
    assert.equal(calls[0]!.url, `${BASE}/default`);
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc-prj_kiwi");
  });

  it("create POSTs repo_name and from", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...REPO, repo_name: "user-42" }, 201));
    const created = await makeSdk(fetch).appRepos.create("prj_kiwi", { repo_name: "user-42", from: "template" });
    assert.equal(created.repo_name, "user-42");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, { repo_name: "user-42", from: "template" });
  });

  it("delete sends ?confirm=<name> and refuses locally without a matching confirm", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ deleted: true, repo_name: "user-42" }));
    const r = makeSdk(fetch);
    await assert.rejects(() => r.appRepos.delete("prj_kiwi", "user-42", { confirm: "user-4" }), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
    const out = await r.appRepos.delete("prj_kiwi", "user-42", { confirm: "user-42" });
    assert.equal(out.deleted, true);
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, `${BASE}/user-42?confirm=user-42`);
  });

  it("log passes path, cursor and limit as query parameters", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ commits: [COMMIT], head: HEAD, has_more: false, next_cursor: null }));
    const page = await makeSdk(fetch).appRepos.log("prj_kiwi", "default", { path: "people/a.json", cursor: "c1", limit: 10 });
    assert.equal(page.commits[0]!.actor_user_id, "u_1");
    assert.equal(calls[0]!.url, `${BASE}/default/commits?path=people%2Fa.json&cursor=c1&limit=10`);
  });

  it("readFile returns bytes, text, the commit read and the blob id", async () => {
    const { fetch, calls } = mockFetch(() => new Response('{"a":1}\n', {
      status: 200,
      headers: { "content-type": "application/json", etag: '"e69de29b"', "x-run402-commit": HEAD },
    }));
    const file = await makeSdk(fetch).appRepos.readFile("prj_kiwi", "default", "people/a b.json", { at: HEAD });
    assert.ok(file);
    assert.equal(calls[0]!.url, `${BASE}/default/files/people/a%20b.json?at=${HEAD}`);
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(file.text, '{"a":1}\n');
    assert.equal(file.commit, HEAD);
    assert.equal(file.oid, "e69de29b");
    assert.equal(file.size_bytes, 8);
    assert.ok(file.bytes instanceof Uint8Array);
  });

  it("readFile returns text: null for bytes that are not UTF-8, and uses the service key without a principal", async () => {
    const { fetch, calls } = mockFetch(() => new Response(new Uint8Array([0xff, 0xfe, 0x00]), { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const file = await makeSdk(fetch, { principal: false }).appRepos.readFile("prj_kiwi", "default", "blob.bin");
    assert.equal(file!.text, null);
    assert.equal(file!.commit, null);
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc-prj_kiwi");
  });

  it("readFile returns null on APP_REPO_PATH_NOT_FOUND and throws on any other 404", async () => {
    const { fetch } = mockFetch((call) => call.url.includes("missing")
      ? jsonResponse({ code: "APP_REPO_PATH_NOT_FOUND", message: "No file at missing.txt" }, 404)
      : jsonResponse({ code: "APP_REPO_NOT_FOUND", message: "No app repo nope", next_actions: [{ type: "create_app_repo" }] }, 404));
    const r = makeSdk(fetch);
    assert.equal(await r.appRepos.readFile("prj_kiwi", "default", "missing.txt"), null);
    await assert.rejects(() => r.appRepos.readFile("prj_kiwi", "nope", "a.txt"), (err: unknown) => {
      assert.ok(isApiError(err));
      assert.equal((err as { code?: string }).code, "APP_REPO_NOT_FOUND");
      return true;
    });
  });

  it("tree GETs the root or a directory", async () => {
    const tree = { commit: HEAD, path: "people", entries: [{ name: "a.json", path: "people/a.json", type: "file", size: 8, oid: "e69de29b" }] };
    const { fetch, calls } = mockFetch(() => jsonResponse(tree));
    const r = makeSdk(fetch);
    await r.appRepos.tree("prj_kiwi", "default");
    const listed = await r.appRepos.tree("prj_kiwi", "default", "people/", { at: HEAD });
    assert.equal(listed.entries[0]!.type, "file");
    assert.deepEqual(calls.map((c) => c.url), [`${BASE}/default/tree`, `${BASE}/default/tree/people?at=${HEAD}`]);
  });

  it("diff GETs from and to", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ from: "a", to: "b", changes: [] }));
    await makeSdk(fetch).appRepos.diff("prj_kiwi", "default", "a", "b");
    assert.equal(calls[0]!.url, `${BASE}/default/diff?from=a&to=b`);
  });

  it("commit sends the wire shape, turning a string into { text } and bytes into { base64 }", async () => {
    const answer = { committed: true, commit: HEAD, parent: null, head: HEAD, seq: 1, paths: ["a.txt"], author: COMMIT.author };
    const { fetch, calls } = mockFetch(() => jsonResponse(answer, 201));
    const result = await makeSdk(fetch).appRepos.commit("prj_kiwi", "default", {
      files: {
        "a.txt": "hello",
        "b.bin": new Uint8Array([1, 2, 3]),
        "c.json": { json: { b: 1, a: 2 } },
        "old.txt": null,
      },
      message: "Seed",
      base: HEAD,
    });
    assert.equal(result.committed, true);
    assert.equal(calls[0]!.url, `${BASE}/default/commits`);
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(calls[0]!.body, {
      files: {
        "a.txt": { text: "hello" },
        "b.bin": { base64: "AQID" },
        "c.json": { json: { b: 1, a: 2 } },
        "old.txt": null,
      },
      message: "Seed",
      base: HEAD,
    });
  });

  it("commit refuses a bare object locally, before any request", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).appRepos.commit("prj_kiwi", "default", { files: { "a.json": { a: 1 } as never } }),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("a conflict surfaces the gateway's 409 with its details", async () => {
    const { fetch } = mockFetch(() => jsonResponse({
      code: "APP_REPO_CONFLICT",
      message: "people/a.json changed since your base",
      details: { head: HEAD, base: "old", conflicting_paths: ["people/a.json"] },
    }, 409));
    await assert.rejects(
      () => makeSdk(fetch).appRepos.commit("prj_kiwi", "default", { files: { "people/a.json": "x" }, base: "old" }),
      (err: unknown) => {
        assert.ok(isApiError(err));
        assert.equal((err as { status?: number }).status, 409);
        assert.equal((err as { code?: string }).code, "APP_REPO_CONFLICT");
        return true;
      },
    );
  });

  it("revert POSTs the commit to undo", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ committed: false, head: HEAD }));
    const out = await makeSdk(fetch).appRepos.revert("prj_kiwi", "default", HEAD, { message: "undo" });
    assert.equal(out.committed, false);
    assert.equal(calls[0]!.url, `${BASE}/default/reverts`);
    assert.deepEqual(calls[0]!.body, { commit: HEAD, message: "undo" });
  });

  it("is project-scoped as r.project(id).appRepos", async () => {
    const { fetch, calls } = mockFetch((call) => jsonResponse(call.url === BASE ? { app_repos: [REPO] } : REPO));
    const p = makeSdk(fetch).project("prj_kiwi");
    await p.appRepos.list();
    await p.appRepos.get("default");
    assert.deepEqual(calls.map((c) => c.url), [BASE, `${BASE}/default`]);
  });

  it("refuses a missing project id locally", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    await assert.rejects(() => r.appRepos.list(""), (err: unknown) => isLocalError(err));
    await assert.rejects(() => r.appRepos.readFile("prj_kiwi", "default", ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });

  it("runs on the MCP sandbox surface: no method carries a one-time secret", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ app_repos: [REPO] }));
    await makeSdk(fetch, { capabilities: { returnSecrets: false } }).appRepos.list("prj_kiwi");
    assert.equal(calls.length, 1);
  });
});
