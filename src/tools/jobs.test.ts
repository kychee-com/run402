import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _resetSdk } from "../sdk.js";
import {
  handleJobsDownloadArtifact,
  handleJobsGet,
  handleJobsLogs,
  handleJobsPurge,
  handleJobsSubmit,
} from "./jobs.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-jobs-tool-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  writeFileSync(
    join(tempDir, "projects.json"),
    JSON.stringify({
      projects: {
        prj_k: {
          anon_key: "anon_test",
          service_key: "svc_test",
        },
      },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  _resetSdk();
});

describe("jobs MCP tools", () => {
  it("submits through the SDK and returns JSON text", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      });
      return new Response(
        JSON.stringify({
          job_id: "job_123",
          job_type: "example.managed_job.v1",
          status: "queued",
          created_at: "2026-05-18T00:00:00.000Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleJobsSubmit({
      project_id: "prj_k",
      request: {
        job_type: "example.managed_job.v1",
        input: { input_json: { envelopeId: "env_1" } },
        max_cost_usd_micros: 50_000,
      },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("job_123"));
    assert.equal(calls[0]!.url, "https://test-api.run402.com/jobs/v1/runs");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc_test");
    assert.match(calls[0]!.headers["Idempotency-Key"], /^job-/);
  });

  it("forwards an optional callback_url in the POST body", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          job_id: "job_cb",
          job_type: "example.managed_job.v1",
          status: "queued",
          created_at: "2026-05-18T00:00:00.000Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleJobsSubmit({
      project_id: "prj_k",
      request: {
        job_type: "example.managed_job.v1",
        input: { input_json: { envelopeId: "env_1" } },
        max_cost_usd_micros: 50_000,
        callback_url: "https://hooks.example.com/jobs",
      },
    });

    assert.ok(capturedBody, "expected a request body");
    assert.equal(JSON.parse(capturedBody!).callback_url, "https://hooks.example.com/jobs");
  });

  it("gets a job and reads logs", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      const isLogs = String(input).includes("/logs");
      return new Response(
        JSON.stringify(
          isLogs
            ? { logs: [{ timestamp: "2026-05-18T00:00:00.000Z", message: "ok", log_stream_name: "s", event_id: "e" }] }
            : { job_id: "job_123", job_type: "example.managed_job.v1", status: "running", created_at: "2026-05-18T00:00:00.000Z" },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const job = await handleJobsGet({ project_id: "prj_k", job_id: "job_123" });
    const logs = await handleJobsLogs({
      project_id: "prj_k",
      job_id: "job_123",
      tail: 10,
      since: 1_710_000_000_000,
    });

    assert.ok(job.content[0]!.text.includes("running"));
    assert.ok(logs.content[0]!.text.includes("ok"));
    assert.equal(urls[0], "https://test-api.run402.com/jobs/v1/runs/job_123");
    assert.equal(
      urls[1],
      "https://test-api.run402.com/jobs/v1/runs/job_123/logs?tail=10&since=1710000000000",
    );
  });

  it("purges project job runs", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          deleted_jobs: 3,
          cancelled_active_jobs: 1,
          terminated_instances: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleJobsPurge({ project_id: "prj_k" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("deleted_jobs"));
    assert.equal(calls[0]!.url, "https://test-api.run402.com/jobs/v1/runs");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc_test");
  });

  it("downloads an artifact through the SDK and writes it to disk", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": "11" },
      });
    }) as typeof fetch;

    const outPath = join(tempDir, "artifacts", "proof.json");
    const result = await handleJobsDownloadArtifact({
      project_id: "prj_k",
      job_id: "job_123",
      filename: "proof.json",
      output_path: outPath,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("proof.json"));
    assert.equal(readFileSync(outPath, "utf-8"), '{"ok":true}');
    assert.equal(
      calls[0]!.url,
      "https://test-api.run402.com/jobs/v1/runs/job_123/artifacts/proof.json",
    );
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc_test");
  });

  it("returns a structured error when the local output path can't be written", async () => {
    globalThis.fetch = (async () =>
      new Response("bytes", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    // Pointing at the temp dir (a directory) makes the file write fail.
    const result = await handleJobsDownloadArtifact({
      project_id: "prj_k",
      job_id: "job_123",
      filename: "proof.json",
      output_path: tempDir,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Error writing job artifact to local file/);
  });

  it("surfaces a 404 as a structured error (uncompleted job or unknown file)", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const result = await handleJobsDownloadArtifact({
      project_id: "prj_k",
      job_id: "job_123",
      filename: "proof.json",
      output_path: join(tempDir, "proof.json"),
    });

    assert.equal(result.isError, true);
  });
});
