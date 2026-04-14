import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderPastDueEmail,
  renderFrozenEmail,
  renderFinalWarningEmail,
} from "./project-email-templates.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts that every form of the rendered email mentions a value. */
function assertEveryField(
  { subject, html, text }: { subject: string; html: string; text: string },
  value: string,
  label: string,
): void {
  assert.ok(subject.length > 0, `${label}: subject non-empty`);
  assert.ok(html.length > 0, `${label}: html non-empty`);
  assert.ok(text.length > 0, `${label}: text non-empty`);
  assert.ok(
    subject.includes(value) || html.includes(value) || text.includes(value),
    `${label}: at least one of subject/html/text must include "${value}"`,
  );
}

// ---------------------------------------------------------------------------
// renderPastDueEmail
// ---------------------------------------------------------------------------

describe("renderPastDueEmail", () => {
  it("includes the project name, frozen date, and a renewal CTA in all three fields", () => {
    const email = renderPastDueEmail({ projectName: "Alpha", frozenOn: "2026-05-01" });
    assertEveryField(email, "Alpha", "project name");
    assertEveryField(email, "2026-05-01", "frozen date");
    assert.ok(email.html.includes("run402.com"), "html must include renewal URL");
    assert.ok(email.text.includes("run402.com"), "text must include renewal URL");
  });

  it("tells the owner the site is unaffected", () => {
    const email = renderPastDueEmail({ projectName: "Alpha", frozenOn: "2026-05-01" });
    assert.ok(/end users are not affected|site.*continue|not affected/i.test(email.html));
    assert.ok(/unaffected|not.*affected/i.test(email.text));
  });

  it("names the control-plane operations that will be blocked", () => {
    const email = renderPastDueEmail({ projectName: "Alpha", frozenOn: "2026-05-01" });
    assert.ok(/deploy/i.test(email.html));
    assert.ok(/secret/i.test(email.html));
    assert.ok(/subdomain/i.test(email.html));
  });

  it("escapes HTML in the project name", () => {
    const email = renderPastDueEmail({ projectName: '<script>alert("x")</script>', frozenOn: "2026-05-01" });
    assert.ok(!email.html.includes("<script>"), "raw tag must not leak into html");
    assert.ok(email.html.includes("&lt;script&gt;"), "tag must be escaped");
    // Subject and text are plain-text contexts, escaping is not applied
    assert.ok(email.subject.includes("<script>"));
  });
});

// ---------------------------------------------------------------------------
// renderFrozenEmail
// ---------------------------------------------------------------------------

describe("renderFrozenEmail", () => {
  it("includes the project name and dormant date in all three fields", () => {
    const email = renderFrozenEmail({ projectName: "Beta", dormantOn: "2026-05-15" });
    assertEveryField(email, "Beta", "project name");
    assertEveryField(email, "2026-05-15", "dormant date");
  });

  it("explicitly warns that scheduled functions will pause on the dormant date", () => {
    const email = renderFrozenEmail({ projectName: "Beta", dormantOn: "2026-05-15" });
    assert.ok(/scheduled|cron/i.test(email.html), "html must mention scheduled/cron");
    assert.ok(/stop running|pause|silent/i.test(email.html), "html must name the consequence");
    assert.ok(/scheduled|cron/i.test(email.text), "text must mention scheduled/cron");
  });

  it("explicitly names control-plane writes as blocked", () => {
    const email = renderFrozenEmail({ projectName: "Beta", dormantOn: "2026-05-15" });
    assert.ok(/deploy/i.test(email.html));
    assert.ok(/blocked|disabled|locked/i.test(email.html));
  });

  it("assures the owner the subdomain is reserved", () => {
    const email = renderFrozenEmail({ projectName: "Beta", dormantOn: "2026-05-15" });
    assert.ok(/reserved/i.test(email.html));
  });

  it("escapes HTML in the project name", () => {
    const email = renderFrozenEmail({ projectName: "<b>x</b>", dormantOn: "2026-05-15" });
    assert.ok(!email.html.includes("<b>x</b>"));
    assert.ok(email.html.includes("&lt;b&gt;"));
  });
});

// ---------------------------------------------------------------------------
// renderFinalWarningEmail
// ---------------------------------------------------------------------------

describe("renderFinalWarningEmail", () => {
  it("includes the project name and exact purge timestamp", () => {
    const email = renderFinalWarningEmail({
      projectName: "Gamma",
      scheduledPurgeAt: "2026-06-01T12:00:00.000Z",
    });
    assertEveryField(email, "Gamma", "project name");
    assertEveryField(email, "2026-06-01T12:00:00.000Z", "exact timestamp");
  });

  it("uses urgent language and emphasizes 24 hours", () => {
    const email = renderFinalWarningEmail({
      projectName: "Gamma",
      scheduledPurgeAt: "2026-06-01T12:00:00.000Z",
    });
    assert.ok(/FINAL NOTICE|FINAL WARNING/i.test(email.subject));
    assert.ok(/24 hours/i.test(email.html));
    assert.ok(/24 hours/i.test(email.text));
  });

  it("states that deletion is irreversible", () => {
    const email = renderFinalWarningEmail({
      projectName: "Gamma",
      scheduledPurgeAt: "2026-06-01T12:00:00.000Z",
    });
    assert.ok(/irreversible/i.test(email.html));
    assert.ok(/irreversible/i.test(email.text));
  });

  it("includes a renewal link as a clickable anchor", () => {
    const email = renderFinalWarningEmail({
      projectName: "Gamma",
      scheduledPurgeAt: "2026-06-01T12:00:00.000Z",
    });
    assert.ok(/<a href="https:\/\/run402\.com">/.test(email.html), "html must have an <a href> anchor");
  });

  it("escapes HTML in the project name", () => {
    const email = renderFinalWarningEmail({
      projectName: '"evil" <img>',
      scheduledPurgeAt: "2026-06-01T12:00:00.000Z",
    });
    assert.ok(!email.html.includes("<img>"));
    assert.ok(email.html.includes("&quot;evil&quot;"));
    assert.ok(email.html.includes("&lt;img&gt;"));
  });
});

// ---------------------------------------------------------------------------
// Shape regression: all renderers return a plain object shape
// ---------------------------------------------------------------------------

describe("render shape", () => {
  it("every renderer returns exactly { subject, html, text } with non-empty strings", () => {
    const renderers = [
      () => renderPastDueEmail({ projectName: "P", frozenOn: "2026-01-01" }),
      () => renderFrozenEmail({ projectName: "P", dormantOn: "2026-01-01" }),
      () => renderFinalWarningEmail({ projectName: "P", scheduledPurgeAt: "2026-01-01T00:00:00Z" }),
    ];
    for (const render of renderers) {
      const email = render();
      assert.deepEqual(Object.keys(email).sort(), ["html", "subject", "text"]);
      assert.equal(typeof email.subject, "string");
      assert.equal(typeof email.html, "string");
      assert.equal(typeof email.text, "string");
      assert.ok(email.subject.length > 0);
      assert.ok(email.html.length > 0);
      assert.ok(email.text.length > 0);
    }
  });
});
