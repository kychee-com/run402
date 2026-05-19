import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { email } = await import("./email.js");

// email is a module-level singleton with an internal _mailboxId cache.
// The first describe block must handle discovery + send (two fetch calls).
// Subsequent blocks hit the cached mailbox ID (one fetch call each).

describe("email.send — first call discovers mailbox via GET /mailboxes/v1", () => {
  it("discovers mailbox then posts to /mailboxes/v1/:id/messages", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      if (url.endsWith("/mailboxes/v1")) {
        return new Response(
          JSON.stringify({ mailboxes: [{ mailbox_id: "mbx_test" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: "msg_001" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await email.send({ to: "user@example.com", subject: "Hi", html: "<p>Hello</p>" });

    // Discovery call
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://test.run402.com/mailboxes/v1");
    assert.equal(calls[0].opts.method, undefined); // GET (default)
    const discoverHeaders = calls[0].opts.headers as Record<string, string>;
    assert.equal(discoverHeaders.Authorization, "Bearer sk_test");

    // Send call
    assert.equal(calls[1].url, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.equal(calls[1].opts.method, "POST");
    const sendHeaders = calls[1].opts.headers as Record<string, string>;
    assert.equal(sendHeaders.Authorization, "Bearer sk_test");
    assert.equal(sendHeaders["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[1].opts.body as string), {
      to: "user@example.com",
      subject: "Hi",
      html: "<p>Hello</p>",
    });
    assert.deepEqual(result, { id: "msg_001" });
  });
});

describe("email.send — subsequent calls use cached mailboxId (no re-discover)", () => {
  it("posts raw HTML email with optional text and from_name", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(
        JSON.stringify({ id: "msg_002" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await email.send({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Welcome!</p>",
      text: "Welcome!",
      from_name: "MyApp",
    });

    assert.equal(calls.length, 1, "no re-discovery on cached mailbox");
    assert.equal(calls[0].url, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.deepEqual(JSON.parse(calls[0].opts.body as string), {
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Welcome!</p>",
      text: "Welcome!",
      from_name: "MyApp",
    });
  });

  it("posts template email with variables to /mailboxes/v1/:id/messages", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(
        JSON.stringify({ id: "msg_003" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await email.send({
      to: "alice@example.com",
      template: "welcome",
      variables: { name: "Alice" },
      from_name: "MyApp",
    });

    assert.equal(capturedUrl, "https://test.run402.com/mailboxes/v1/mbx_test/messages");
    assert.deepEqual(JSON.parse(capturedOpts.body as string), {
      to: "alice@example.com",
      template: "welcome",
      variables: { name: "Alice" },
      from_name: "MyApp",
    });
    assert.deepEqual(result, { id: "msg_003" });
  });

  it("omits optional fields not provided", async () => {
    let capturedBody = "";
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return new Response(JSON.stringify({ id: "msg_004" }), { status: 200 });
    });

    await email.send({ to: "user@example.com", template: "reset" });

    const body = JSON.parse(capturedBody);
    assert.equal(body.from_name, undefined);
    assert.deepEqual(body.variables, {});
  });

  it("throws on send failure", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ error: "over quota" }), { status: 429 }),
    );

    await assert.rejects(
      async () => {
        await email.send({ to: "user@example.com", subject: "x", html: "<p>x</p>" });
      },
      /Email send failed \(429\)/,
    );
  });
});
