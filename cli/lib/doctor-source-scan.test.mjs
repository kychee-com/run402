import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scanFileContent,
  SCAN_SEVERITY,
  _testOnly_hallucinatedNames,
  _testOnly_authProperties,
} from "./doctor-source-scan.mjs";

describe("scanFileContent — hallucinated bare names", () => {
  it("flags `import { getUser } from \"@run402/functions\"` as an error", () => {
    const findings = scanFileContent(
      `import { getUser } from "@run402/functions";\n`,
      { filePath: "src/pages/index.astro" },
    );
    assert.ok(findings.length >= 1);
    const f = findings.find((x) => x.attempted_name === "getUser" && x.line === 1);
    assert.ok(f, "found getUser finding");
    assert.equal(f.code, "R402_AUTH_UNKNOWN_EXPORT");
    assert.equal(f.severity, SCAN_SEVERITY.ERROR);
    assert.match(f.canonical_name, /auth\.user/);
    assert.equal(f.file, "src/pages/index.astro");
  });

  it("flags `import { getSession, currentUser } from \"@run402/functions\"`", () => {
    const findings = scanFileContent(
      `import { getSession, currentUser } from "@run402/functions";`,
    );
    const names = new Set(findings.map((f) => f.attempted_name));
    assert.ok(names.has("getSession"));
    assert.ok(names.has("currentUser"));
  });

  it("flags bare `await getSession()` call sites", () => {
    const findings = scanFileContent(`
      const session = await getSession();
    `);
    assert.ok(findings.some((f) => f.attempted_name === "getSession"));
  });

  it("does not double-fire on `auth.getSession()` — that's the property scanner's job", () => {
    const findings = scanFileContent(`
      const session = await auth.getSession();
    `);
    // The bare-name scanner should NOT fire on `auth.getSession`; only
    // the property scanner should. So exactly one finding for getSession.
    const bareGetSession = findings.filter((f) => f.attempted_name === "getSession");
    assert.equal(bareGetSession.length, 0, "bare getSession() must not fire on auth.getSession()");
    const authGetSession = findings.filter((f) => f.attempted_name === "auth.getSession");
    assert.equal(authGetSession.length, 1);
  });

  it("includes the canonical replacement and docs URL in the finding", () => {
    const findings = scanFileContent(
      `import { getUser } from "@run402/functions";`,
    );
    const f = findings[0];
    assert.match(f.canonical_name, /auth\.user/);
    assert.match(f.import_line, /@run402\/functions/);
    assert.match(f.docs, /docs\.run402\.com\/auth\/sdk/);
  });

  it("covers every hallucinated name in the spec registry", () => {
    const names = _testOnly_hallucinatedNames();
    for (const entry of names) {
      const findings = scanFileContent(`const x = ${entry.name}();`);
      assert.ok(
        findings.some((f) => f.attempted_name === entry.name),
        `expected scanner to flag bare ${entry.name}()`,
      );
    }
  });

  it("does NOT fire on `auth.user()` (the canonical helper)", () => {
    const findings = scanFileContent(`
      const user = await auth.user();
      const required = await auth.requireUser();
    `);
    // Should be zero R402_AUTH_UNKNOWN_EXPORT findings.
    assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  });
});

describe("scanFileContent — auth.* property hallucinations", () => {
  it("flags `auth.protect(...)` as an error pointing at auth.requireUser / auth.requireRole", () => {
    const findings = scanFileContent(`const r = auth.protect({ role: "admin" });`);
    const f = findings.find((x) => x.attempted_name === "auth.protect");
    assert.ok(f);
    assert.match(f.canonical_name, /requireUser|requireRole/);
  });

  it("flags `auth.signIn(...)` pointing at createResponseFromIdentity", () => {
    const findings = scanFileContent(`return auth.signIn({ provider: "google" });`);
    const f = findings.find((x) => x.attempted_name === "auth.signIn");
    assert.ok(f);
    assert.match(f.canonical_name, /createResponseFromIdentity|POST \/auth\/sign-in/);
  });

  it("covers every auth.* property in the registry", () => {
    const props = _testOnly_authProperties();
    for (const entry of props) {
      const findings = scanFileContent(`const r = ${entry.name}();`);
      assert.ok(
        findings.some((f) => f.attempted_name === entry.name),
        `expected scanner to flag ${entry.name}`,
      );
    }
  });
});

describe("scanFileContent — browser-only patterns", () => {
  it("flags `localStorage.getItem(\"wl_session\")`", () => {
    const findings = scanFileContent(`
      const token = localStorage.getItem("wl_session");
    `);
    assert.ok(findings.some((f) => f.attempted_name === "localStorage.wl_session"));
  });

  it("warns on Authorization: Bearer in browser-context code", () => {
    const findings = scanFileContent(`
      fetch("/api", { headers: { "Authorization": "Bearer " + token } });
    `);
    const f = findings.find((x) => x.attempted_name?.startsWith("Authorization"));
    assert.ok(f);
    assert.equal(f.severity, SCAN_SEVERITY.WARN, "Bearer is a warn, not an error");
  });
});

describe("scanFileContent — prerendered pages calling auth.*", () => {
  it("flags `export const prerender = true` + `auth.user()`", () => {
    const findings = scanFileContent(
      `---
export const prerender = true;
const user = await auth.user();
---
<html><body>{user?.email}</body></html>`,
      { filePath: "src/pages/me.astro" },
    );
    const f = findings.find((x) => x.code === "R402_AUTH_PRERENDERED");
    assert.ok(f, "expected R402_AUTH_PRERENDERED");
    assert.equal(f.severity, SCAN_SEVERITY.ERROR);
    assert.match(f.docs, /rendering-modes/);
  });

  it("does NOT fire when `prerender = true` page never calls auth.*", () => {
    const findings = scanFileContent(
      `---
export const prerender = true;
const title = "static page";
---
<html><body>{title}</body></html>`,
      { filePath: "src/pages/static.astro" },
    );
    const f = findings.find((x) => x.code === "R402_AUTH_PRERENDERED");
    assert.equal(f, undefined);
  });

  it("does NOT fire when the file lacks the prerender export", () => {
    const findings = scanFileContent(
      `const user = await auth.user();`,
      { filePath: "src/pages/dynamic.astro" },
    );
    const f = findings.find((x) => x.code === "R402_AUTH_PRERENDERED");
    assert.equal(f, undefined);
  });
});

describe("scanFileContent — state-changing GET handlers", () => {
  it("flags `export async function GET` with `db().insert(...)`", () => {
    const findings = scanFileContent(`
      import { db } from "@run402/functions";
      export async function GET(req) {
        await db().from("posts").insert({ title: "x" });
        return new Response("ok");
      }
    `);
    const f = findings.find((x) => x.code === "R402_AUTH_STATE_CHANGING_GET");
    assert.ok(f);
    assert.equal(f.severity, SCAN_SEVERITY.ERROR);
  });

  it("flags `export const GET` with `adminDb().sql(\"UPDATE ...\")`", () => {
    const findings = scanFileContent(`
      import { adminDb } from "@run402/functions";
      export const GET = async () => {
        await adminDb().sql("UPDATE foo SET x = 1");
        return new Response("ok");
      };
    `);
    const f = findings.find((x) => x.code === "R402_AUTH_STATE_CHANGING_GET");
    assert.ok(f);
  });

  it("does NOT fire on read-only GET handlers", () => {
    const findings = scanFileContent(`
      import { db } from "@run402/functions";
      export async function GET() {
        const rows = await db().from("posts").select();
        return Response.json(rows);
      }
    `);
    const f = findings.find((x) => x.code === "R402_AUTH_STATE_CHANGING_GET");
    assert.equal(f, undefined);
  });
});

describe("scanFileContent — direct authz_version mutation", () => {
  it("flags `UPDATE internal.sessions SET authz_version`", () => {
    const findings = scanFileContent(`
      adminDb().sql(\`UPDATE internal.sessions SET authz_version = authz_version + 1\`);
    `);
    const f = findings.find((x) => x.code === "R402_AUTH_AUTHZ_VERSION_PROHIBITED");
    assert.ok(f);
    assert.equal(f.severity, SCAN_SEVERITY.ERROR);
    assert.match(f.docs, /authz-version/);
  });

  it("is case-insensitive (UPDATE / update / Update)", () => {
    const variants = [
      "update internal.sessions set authz_version = 5;",
      "Update Internal.Sessions Set Authz_Version = 5;",
    ];
    for (const sql of variants) {
      const findings = scanFileContent(sql);
      assert.ok(
        findings.some((f) => f.code === "R402_AUTH_AUTHZ_VERSION_PROHIBITED"),
        `case variant failed: ${sql}`,
      );
    }
  });
});

describe("scanFileContent — line numbers + file paths", () => {
  it("reports the line of the violation, not always line 1", () => {
    const content = [
      "// line 1: comment",
      "// line 2: comment",
      'import { auth } from "@run402/functions";',
      "// line 4: comment",
      'const u = await getSession(); // line 5',
      "",
    ].join("\n");
    const findings = scanFileContent(content);
    const f = findings.find((x) => x.attempted_name === "getSession");
    assert.ok(f);
    assert.equal(f.line, 5);
  });

  it("propagates filePath from the caller", () => {
    const findings = scanFileContent(`const u = await getSession();`, {
      filePath: "src/pages/account.astro",
    });
    assert.equal(findings[0].file, "src/pages/account.astro");
  });
});
