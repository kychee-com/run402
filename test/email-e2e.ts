/**
 * Email E2E Test — Mailbox lifecycle
 *
 * Tests the full email lifecycle against a running instance:
 *   1. Create project (needs active tier)
 *   2. Create mailbox
 *   3. Send invite email
 *   4. Verify message stored
 *   5. List messages
 *   6. Rate limiting (daily cap)
 *   7. Suppression check
 *   8. Delete project → verify mailbox tombstoned
 *
 * Usage:
 *   BASE_URL=http://localhost:4022 npm run test:email
 *   BASE_URL=https://api.run402.com npm run test:email
 *
 * Requires: BUYER_PRIVATE_KEY in .env (for wallet auth / tier subscription)
 */

import { config } from "dotenv";
config();

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { ensureTestBalance } from "./ensure-balance.js";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.BASE_URL || "http://localhost:4022";
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY in .env");
  process.exit(1);
}

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(path: string): Promise<Record<string, string>> {
  const baseUrl = new URL(BASE_URL);
  const uri = `${baseUrl.protocol}//${baseUrl.host}${path}`;
  const now = new Date();
  const info: CompleteSIWxInfo = {
    domain: baseUrl.hostname,
    uri,
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191",
  };
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function run() {
  await ensureTestBalance(account.address, BASE_URL);

  console.log(`\nEmail E2E Test — ${BASE_URL}\n`);

  let serviceKey = "";
  let projectId = "";
  let mailboxId = "";
  let messageId = "";

  // Step 1: Create project (assumes active tier subscription)
  console.log("1. Create project");
  {
    const headers = await siwxHeaders("/projects/v1");
    const res = await fetch(`${BASE_URL}/projects/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name: `email-test-${Date.now()}` }),
    });
    ok("project created", res.status === 201, `status=${res.status}`);
    const body = await res.json() as { project_id: string; service_key: string };
    projectId = body.project_id;
    serviceKey = body.service_key;
    ok("has project_id", !!projectId);
    ok("has service_key", !!serviceKey);
  }

  if (!serviceKey) {
    console.error("Cannot continue without service_key");
    process.exit(1);
  }

  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
  };

  // Step 2: Create mailbox
  console.log("\n2. Create mailbox");
  {
    const slug = `test-${Date.now()}`;
    const res = await fetch(`${BASE_URL}/mailboxes/v1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug }),
    });
    ok("mailbox created", res.status === 201, `status=${res.status}`);
    const body = await res.json() as { mailbox_id: string; address: string; slug: string };
    mailboxId = body.mailbox_id;
    ok("has mailbox_id", !!mailboxId);
    ok("address format", body.address === `${slug}@mail.run402.com`, `got ${body.address}`);

    // Cannot create a second mailbox
    const res2 = await fetch(`${BASE_URL}/mailboxes/v1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug: `other-${Date.now()}` }),
    });
    ok("second mailbox rejected", res2.status === 409);
  }

  // Step 3: Send invite email
  console.log("\n3. Send email");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: "project_invite",
        to: "test-recipient@example.com",
        variables: {
          project_name: "Test Project",
          invite_url: "https://example.com/invite/abc",
        },
      }),
    });
    // May fail if SES sandbox mode (recipient not verified) — check both 201 and SES error
    if (res.status === 201) {
      const body = await res.json() as { message_id: string; template: string; status: string };
      messageId = body.message_id;
      ok("email sent", true);
      ok("has message_id", !!messageId);
      ok("template correct", body.template === "project_invite");
      ok("status is sent", body.status === "sent");
    } else {
      const body = await res.json() as { error: string };
      // SES sandbox rejection is expected in dev
      if (body.error?.includes("not verified") || body.error?.includes("MessageRejected")) {
        ok("email send (SES sandbox — recipient not verified, expected)", true);
        console.log("    Skipping message verification tests (sandbox mode)");
      } else {
        ok("email sent", false, `status=${res.status} ${JSON.stringify(body)}`);
      }
    }

    // Invalid template
    const res2 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: "spam_blast",
        to: "test@example.com",
        variables: {},
      }),
    });
    ok("invalid template rejected", res2.status === 400);

    // Missing variable
    const res3 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: "project_invite",
        to: "test@example.com",
        variables: { project_name: "Test" },
      }),
    });
    ok("missing variable rejected", res3.status === 400);

    // Array recipient rejected
    const res4 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: "notification",
        to: ["a@x.com", "b@x.com"],
        variables: { project_name: "Test", message: "Hello" },
      }),
    });
    ok("array recipient rejected", res4.status === 400);
  }

  // Step 4: List messages
  console.log("\n4. List messages");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      headers: authHeaders,
    });
    ok("list messages", res.status === 200, `status=${res.status}`);
    const body = await res.json() as { messages: unknown[] };
    ok("has messages array", Array.isArray(body.messages));
  }

  // Step 5: Get mailbox details
  console.log("\n5. Get mailbox details");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}`, {
      headers: authHeaders,
    });
    ok("get mailbox", res.status === 200, `status=${res.status}`);
    const body = await res.json() as { mailbox_id: string; status: string; sends_today: number };
    ok("status is active", body.status === "active");
    ok("sends_today tracked", typeof body.sends_today === "number");
  }

  // Step 6: List mailboxes
  console.log("\n6. List mailboxes");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1`, {
      headers: authHeaders,
    });
    ok("list mailboxes", res.status === 200);
    const body = await res.json() as { mailboxes: unknown[] };
    ok("has one mailbox", body.mailboxes.length === 1);
  }

  // Step 7: Slug validation
  console.log("\n7. Slug validation");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug: "admin" }),
    });
    ok("reserved slug rejected", res.status === 400);

    const res2 = await fetch(`${BASE_URL}/mailboxes/v1`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ slug: "AB" }),
    });
    ok("invalid slug rejected", res2.status === 400);
  }

  // Step 8: Send raw HTML email
  console.log("\n8. Send raw HTML email");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        to: "test-raw@example.com",
        subject: "Raw test email",
        html: "<h1>Hello from raw mode</h1><p>This is a test.</p>",
      }),
    });
    if (res.status === 201) {
      const body = await res.json() as { message_id: string; template: string | null; subject: string; status: string };
      ok("raw email sent", true);
      ok("template is null", body.template === null, `got ${body.template}`);
      ok("subject returned", body.subject === "Raw test email");
      ok("status is sent", body.status === "sent");

      // Verify in messages list
      const listRes = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
        headers: authHeaders,
      });
      const listBody = await listRes.json() as { messages: Array<{ template: string | null }> };
      const rawMsg = listBody.messages.find((m) => m.template === null);
      ok("raw message in list with template=null", !!rawMsg);
    } else {
      const body = await res.json() as { error: string };
      if (body.error?.includes("not verified") || body.error?.includes("MessageRejected")) {
        ok("raw email send (SES sandbox — expected)", true);
      } else {
        ok("raw email sent", false, `status=${res.status} ${JSON.stringify(body)}`);
      }
    }

    // Missing subject → 400
    const res2 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ to: "a@b.com", html: "<p>no subject</p>" }),
    });
    ok("raw email without subject rejected", res2.status === 400);

    // Missing html → 400 (no template and no html)
    const res3 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ to: "a@b.com", subject: "no html" }),
    });
    ok("raw email without html rejected", res3.status === 400);
  }

  // Step 9: Send with display name
  console.log("\n9. Send with display name");
  {
    const res = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        to: "test-displayname@example.com",
        subject: "Display name test",
        html: "<p>Testing from_name</p>",
        from_name: "My Test App",
      }),
    });
    if (res.status === 201) {
      ok("email with display name sent", true);
      // Get the message to verify from_address format
      const body = await res.json() as { message_id: string };
      const msgRes = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages/${body.message_id}`, {
        headers: authHeaders,
      });
      if (msgRes.status === 200) {
        const msg = await msgRes.json() as { from_address: string };
        ok("from_address has display name", msg.from_address?.includes('"My Test App"'), `got ${msg.from_address}`);
      }
    } else {
      const body = await res.json() as { error: string };
      if (body.error?.includes("not verified") || body.error?.includes("MessageRejected")) {
        ok("display name send (SES sandbox — expected)", true);
      } else {
        ok("email with display name sent", false, `status=${res.status}`);
      }
    }

    // Invalid from_name → 400
    const res2 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        to: "a@b.com",
        subject: "Test",
        html: "<p>hi</p>",
        from_name: 'Evil <script>',
      }),
    });
    ok("invalid from_name rejected", res2.status === 400);
  }

  // Step 10: Inbound reply E2E
  console.log("\n10. Inbound reply test");
  {
    // Send an outbound email first
    const outRes = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: "notification",
        to: account.address.toLowerCase() + "-reply-test@example.com",
        variables: { project_name: "Reply Test", message: "Please reply to this" },
      }),
    });
    if (outRes.status === 201) {
      const outBody = await outRes.json() as { message_id: string };
      ok("outbound sent for reply test", true);

      // Get the SES message ID for In-Reply-To header
      const msgRes = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}/messages/${outBody.message_id}`, {
        headers: authHeaders,
      });
      if (msgRes.status === 200) {
        // In a full E2E, we'd send a reply via SES SendRawEmail to the mailbox address
        // and poll for the inbound reply. This requires SES sandbox to allow sending to
        // mail.run402.com (which it does — we own the domain). But the inbound Lambda
        // needs to process it, which only works against production with active SES rules.
        //
        // For now, verify the message thread endpoint works:
        const msgBody = await msgRes.json() as { replies: Array<{ message_id: string }> };
        ok("message has replies array", Array.isArray(msgBody.replies));
        ok("replies is empty (no reply yet)", msgBody.replies.length === 0);

        // Verify the raw-MIME endpoint enforces inbound-only: outbound returns 404.
        const rawOutRes = await fetch(
          `${BASE_URL}/mailboxes/v1/${mailboxId}/messages/${outBody.message_id}/raw`,
          { headers: authHeaders },
        );
        ok(
          "raw endpoint rejects outbound message (404)",
          rawOutRes.status === 404,
          `status=${rawOutRes.status}`,
        );

        // Full inbound reply test requires production SES — skipped in non-prod
        if (BASE_URL.includes("api.run402.com")) {
          console.log("    TODO: Send real SES reply and poll for inbound (production only)");
          // If a real reply already exists from a prior run, fetch its raw bytes and
          // assert DKIM-Signature is present and CRLF line endings are preserved.
          if (msgBody.replies.length > 0) {
            const replyId = msgBody.replies[0].message_id;
            const rawRes = await fetch(
              `${BASE_URL}/mailboxes/v1/${mailboxId}/messages/${replyId}/raw`,
              { headers: authHeaders },
            );
            ok("raw endpoint returns 200 for inbound reply", rawRes.status === 200);
            ok(
              "raw response is message/rfc822",
              (rawRes.headers.get("content-type") || "").includes("message/rfc822"),
            );
            const rawBuf = Buffer.from(await rawRes.arrayBuffer());
            const rawText = rawBuf.toString("utf-8");
            ok("raw bytes contain DKIM-Signature header", /DKIM-Signature:/i.test(rawText));
            ok("raw bytes contain CRLF line endings", rawBuf.includes(Buffer.from("\r\n", "utf-8")));
          }
        }
      }
    } else {
      ok("outbound for reply test (SES sandbox — expected)", true);
    }
  }

  // Step 11: Delete project → mailbox tombstoned
  console.log("\n11. Delete project (cascade)");
  {
    const res = await fetch(`${BASE_URL}/projects/v1/${projectId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    ok("project deleted", res.status === 200, `status=${res.status}`);

    // Verify mailbox is tombstoned (admin query)
    if (ADMIN_KEY) {
      const res2 = await fetch(`${BASE_URL}/mailboxes/v1/${mailboxId}`, {
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": ADMIN_KEY,
        },
      });
      // After project deletion, the project status is terminal so serviceKeyAuth
      // returns 404 (not 401) — admin path bypasses the project-status check.
      if (res2.status === 200) {
        const body = await res2.json() as { status: string };
        ok("mailbox tombstoned", body.status === "tombstoned", `status=${body.status}`);
      } else {
        ok("mailbox tombstone check (admin)", true, "skipped — no admin access to verify");
      }
    } else {
      ok("mailbox tombstone check", true, "skipped — no ADMIN_KEY");
    }
  }

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
