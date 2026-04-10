import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetEmailRaw } from "./get-email-raw.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-get-email-raw-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

// Helper: mock both the mailbox-list call (to resolve mailbox ID) and the /raw call
function mockFetchSequence(responses: Array<{ status: number; body: unknown; contentType?: string }>) {
  let callIndex = 0;
  globalThis.fetch = (async () => {
    const resp = responses[callIndex++] || responses[responses.length - 1];
    const ct = resp.contentType || "application/json";
    if (ct === "message/rfc822") {
      // Binary response — body is a Buffer-like
      return new Response(resp.body as BodyInit, {
        status: resp.status,
        headers: { "Content-Type": ct, "Content-Length": String((resp.body as Uint8Array).length) },
      });
    }
    return new Response(
      JSON.stringify(resp.body),
      { status: resp.status, headers: { "Content-Type": ct } },
    );
  }) as typeof fetch;
}

// Standard mailbox list response for resolveMailboxId
const MAILBOX_LIST = { mailboxes: [{ mailbox_id: "mbx_1", address: "test@mail.run402.com" }] };

describe("get_email_raw tool", () => {
  it("returns base64-encoded raw MIME bytes on success", async () => {
    const rawMime = "DKIM-Signature: v=1; a=rsa-sha256\r\nFrom: alice@example.com\r\n\r\nI APPROVE\r\n";
    const rawBytes = Buffer.from(rawMime, "utf-8");

    mockFetchSequence([
      { status: 200, body: MAILBOX_LIST },
      { status: 200, body: rawBytes, contentType: "message/rfc822" },
    ]);

    const result = await handleGetEmailRaw({ project_id: "proj-001", message_id: "msg_123" });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    // Should contain base64 of the raw bytes
    const expectedB64 = rawBytes.toString("base64");
    assert.ok(text.includes(expectedB64), "response should contain base64-encoded bytes");
    assert.ok(text.includes("message/rfc822"), "response should mention content type");
  });

  it("round-trips bytes losslessly via base64", async () => {
    // Craft bytes with CRLF, 8-bit chars, DKIM header — the exact scenario
    const rawMime = Buffer.from(
      "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel;\r\n" +
      " h=from:to:subject; bh=abc=; b=def=\r\n" +
      "From: alice@example.com\r\n" +
      "Subject: env_123\r\n" +
      "\r\n" +
      "I APPROVE\r\n",
      "utf-8",
    );

    mockFetchSequence([
      { status: 200, body: MAILBOX_LIST },
      { status: 200, body: rawMime, contentType: "message/rfc822" },
    ]);

    const result = await handleGetEmailRaw({ project_id: "proj-001", message_id: "msg_123" });
    const text = result.content[0]!.text;

    // Extract the base64 line from the markdown output
    const b64Match = text.match(/```\n([\s\S]*?)\n```/);
    assert.ok(b64Match, "should contain a code block with base64");
    const decoded = Buffer.from(b64Match![1]!.trim(), "base64");
    assert.equal(Buffer.compare(decoded, rawMime), 0, "decoded bytes must be identical to original");
  });

  it("returns isError on 404 (outbound or missing)", async () => {
    mockFetchSequence([
      { status: 200, body: MAILBOX_LIST },
      { status: 404, body: { error: "Message not found or no raw MIME available" } },
    ]);

    const result = await handleGetEmailRaw({ project_id: "proj-001", message_id: "msg_999" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found"));
  });

  it("returns isError on 413 (oversize)", async () => {
    mockFetchSequence([
      { status: 200, body: MAILBOX_LIST },
      { status: 413, body: { error: "Raw MIME exceeds 10MB limit" } },
    ]);

    const result = await handleGetEmailRaw({ project_id: "proj-001", message_id: "msg_big" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("10MB") || result.content[0]!.text.includes("413"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleGetEmailRaw({ project_id: "nonexistent", message_id: "msg_123" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
