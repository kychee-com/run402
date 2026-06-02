import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApiError, ProjectNotFound } from "../errors.js";
import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import type { ManagedJobSubmitRequest } from "./jobs.js";

function creds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "t" };
    },
    async getProject(id) {
      if (id === "prj_k") return { anon_key: "a", service_key: "s" };
      return null;
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(h: (c: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return h(call);
  };
  return { fetch, calls };
}

function sdk(f: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds(), fetch: f });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function submitRequest(): ManagedJobSubmitRequest {
  return {
    job_type: "kysigned.fflonk_prove.v0_17_0",
    input: { "input.json": { envelopeId: "env_1" } },
    max_cost_usd_micros: 50_000,
  };
}

describe("jobs", () => {
  it("submit POSTs the gateway request with service bearer and generated idempotency key", async () => {
    const response = {
      job_id: "job_123",
      job_type: "kysigned.fflonk_prove.v0_17_0",
      status: "queued",
      created_at: "2026-05-18T00:00:00.000Z",
    };
    const { fetch, calls } = mockFetch(() => json(response, 202));

    const result = await sdk(fetch).jobs.submit("prj_k", submitRequest());

    assert.deepEqual(result, response);
    assert.equal(calls[0]!.url, "https://api.test/jobs/v1/runs");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer s");
    assert.match(calls[0]!.headers["Idempotency-Key"], /^job-/);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), submitRequest());
  });

  it("submit forwards an optional callback_url verbatim", async () => {
    const { fetch, calls } = mockFetch(() =>
      json(
        {
          job_id: "job_cb",
          job_type: "kysigned.fflonk_prove.v0_17_0",
          status: "queued",
          created_at: "2026-05-18T00:00:00.000Z",
        },
        202,
      ),
    );

    await sdk(fetch).jobs.submit("prj_k", {
      ...submitRequest(),
      callback_url: "https://hooks.example.com/jobs",
    });

    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.callback_url, "https://hooks.example.com/jobs");
  });

  it("submit omits callback_url from the body when not provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      json(
        {
          job_id: "job_nocb",
          job_type: "kysigned.fflonk_prove.v0_17_0",
          status: "queued",
          created_at: "2026-05-18T00:00:00.000Z",
        },
        202,
      ),
    );

    await sdk(fetch).jobs.submit("prj_k", submitRequest());

    const body = JSON.parse(calls[0]!.body as string);
    assert.equal("callback_url" in body, false);
  });

  it("get reads a job run by id", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        job_id: "job_123",
        job_type: "kysigned.fflonk_prove.v0_17_0",
        status: "running",
        created_at: "2026-05-18T00:00:00.000Z",
      }),
    );

    const result = await sdk(fetch).jobs.get("prj_k", "job_123");

    assert.equal(result.status, "running");
    assert.equal(calls[0]!.url, "https://api.test/jobs/v1/runs/job_123");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.Authorization, "Bearer s");
  });

  it("logs passes tail and since as gateway query params", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        logs: [
          {
            timestamp: "2026-05-18T00:00:00.000Z",
            message: "started",
            log_stream_name: "stream",
            event_id: "evt_1",
          },
        ],
      }),
    );

    const result = await sdk(fetch).jobs.logs("prj_k", "job_123", {
      tail: 10,
      since: 1_710_000_000_000,
    });

    assert.equal(result.logs.length, 1);
    assert.equal(
      calls[0]!.url,
      "https://api.test/jobs/v1/runs/job_123/logs?tail=10&since=1710000000000",
    );
  });

  it("cancel DELETEs the job run route", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        job_id: "job_123",
        job_type: "kysigned.fflonk_prove.v0_17_0",
        status: "cancelled",
        created_at: "2026-05-18T00:00:00.000Z",
      }),
    );

    const result = await sdk(fetch).jobs.cancel("prj_k", "job_123");

    assert.equal(result.status, "cancelled");
    assert.equal(calls[0]!.url, "https://api.test/jobs/v1/runs/job_123");
    assert.equal(calls[0]!.method, "DELETE");
  });

  it("downloadArtifact streams raw bytes with the service bearer", async () => {
    const { fetch, calls } = mockFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "11" },
        }),
    );

    const res = await sdk(fetch).jobs.downloadArtifact("prj_k", "job_123", "proof.json");

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(await res.text(), '{"ok":true}');
    assert.equal(
      calls[0]!.url,
      "https://api.test/jobs/v1/runs/job_123/artifacts/proof.json",
    );
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.Authorization, "Bearer s");
  });

  it("downloadArtifact percent-encodes the filename segment", async () => {
    const { fetch, calls } = mockFetch(() => new Response("log", { status: 200 }));

    await sdk(fetch).jobs.downloadArtifact("prj_k", "job_123", "prove output.log");

    assert.equal(
      calls[0]!.url,
      "https://api.test/jobs/v1/runs/job_123/artifacts/prove%20output.log",
    );
  });

  it("downloadArtifact throws ApiError on a 404 (uncompleted job or unknown file)", async () => {
    const { fetch } = mockFetch(() => new Response("not found", { status: 404 }));

    await assert.rejects(
      sdk(fetch).jobs.downloadArtifact("prj_k", "job_123", "proof.json"),
      (err: unknown) => err instanceof ApiError && err.status === 404,
    );
  });

  it("downloadArtifact throws ProjectNotFound without fetch for unknown project", async () => {
    const { fetch, calls } = mockFetch(() => json({}));

    await assert.rejects(
      sdk(fetch).jobs.downloadArtifact("prj_missing", "job_123", "proof.json"),
      ProjectNotFound,
    );

    assert.equal(calls.length, 0);
  });

  it("throws ProjectNotFound without fetch for unknown project", async () => {
    const { fetch, calls } = mockFetch(() => json({}));

    await assert.rejects(sdk(fetch).jobs.get("prj_missing", "job_123"), ProjectNotFound);

    assert.equal(calls.length, 0);
  });
});
