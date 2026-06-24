import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanFileContent,
  scanSourceTree,
  scanSourceFiles,
  readDeclaredCapabilities,
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

describe("scanFileContent — redundant user_id filter (R402_AUTH_REDUNDANT_USER_FILTER)", () => {
  it("flags `.eq(\"user_id\", user.id)`", () => {
    const content = [
      'import { db, auth } from "@run402/functions";',
      "const user = await auth.requireUser();",
      'const rows = await db().from("posts").select("*").eq("user_id", user.id);',
    ].join("\n");
    const findings = scanFileContent(content);
    const f = findings.find((x) => x.code === "R402_AUTH_REDUNDANT_USER_FILTER");
    assert.ok(f, "expected a R402_AUTH_REDUNDANT_USER_FILTER finding");
    assert.equal(f.severity, SCAN_SEVERITY.WARN);
    assert.match(f.docs, /R402_AUTH_REDUNDANT_USER_FILTER/);
    assert.equal(f.line, 3);
  });

  it("flags `.eq('user_id', actor.id)` with single quotes + different identifier", () => {
    const content = "const r = q.eq('user_id', actor.id);";
    const findings = scanFileContent(content);
    assert.ok(findings.some((f) => f.code === "R402_AUTH_REDUNDANT_USER_FILTER"));
  });

  it("is silenced by `// run402-allow-user-filter:` on the same line", () => {
    const content = [
      'import { db, auth } from "@run402/functions";',
      "const user = await auth.requireUser();",
      'const rows = await db().from("posts").select("*").eq("user_id", user.id); // run402-allow-user-filter: explicit filter for analytics export',
    ].join("\n");
    const findings = scanFileContent(content);
    assert.ok(
      !findings.some((f) => f.code === "R402_AUTH_REDUNDANT_USER_FILTER"),
      "annotated line should not produce a finding",
    );
  });

  it("is silenced by `// run402-allow-user-filter:` on the preceding line", () => {
    const content = [
      'import { db, auth } from "@run402/functions";',
      "const user = await auth.requireUser();",
      "// run402-allow-user-filter: this table's RLS scopes on org_id, not user_id",
      'const rows = await db().from("posts").select("*").eq("user_id", user.id);',
    ].join("\n");
    const findings = scanFileContent(content);
    assert.ok(
      !findings.some((f) => f.code === "R402_AUTH_REDUNDANT_USER_FILTER"),
      "preceding annotation should silence",
    );
  });

  it("does NOT flag `.eq(\"org_id\", user.org_id)` or `.eq(\"team_id\", ...)`", () => {
    const content = [
      'const rows1 = q.eq("org_id", user.id);', // non-user_id column
      "const rows2 = q.eq(\"team_id\", actor.team_id);",
      'const rows3 = q.eq("user_id", "fixed-uuid-literal");', // literal string, not <ident>.id
    ].join("\n");
    const findings = scanFileContent(content);
    assert.ok(
      !findings.some((f) => f.code === "R402_AUTH_REDUNDANT_USER_FILTER"),
      "non-matching patterns should not fire",
    );
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

describe("scanFileContent — tenant-assertion session-mint capability (#8, §5.3 / 7.9)", () => {
  const MINT = 'auth.sessions.createResponseFromTenantAssertion({ tenant, user, method: "password" });';

  it("flags a mint call when no capability is declared (default opts)", () => {
    const content = [
      'import { auth } from "@run402/functions";',
      "export default async (req) =>",
      `  ${MINT}`,
    ].join("\n");
    const findings = scanFileContent(content, { filePath: "src/pages/api/login.ts" });
    const f = findings.find(
      (x) => x.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING",
    );
    assert.ok(f, "should flag the mint call");
    assert.equal(f.severity, SCAN_SEVERITY.WARN);
    assert.equal(f.line, 3);
    assert.equal(f.file, "src/pages/api/login.ts");
    assert.match(f.fix, /auth\.sessionMint/);
    assert.match(f.message, /R402_AUTH_UNTRUSTED_CONTEXT/);
  });

  it("suppresses when declaredCapabilities (array) includes auth.sessionMint", () => {
    const findings = scanFileContent(MINT, {
      declaredCapabilities: ["auth.sessionMint"],
    });
    assert.ok(
      !findings.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
    );
  });

  it("suppresses when declaredCapabilities (Set) includes auth.sessionMint", () => {
    const findings = scanFileContent(MINT, {
      declaredCapabilities: new Set(["auth.sessionMint"]),
    });
    assert.ok(
      !findings.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
    );
  });

  it("does NOT flag the distinct createResponseFromIdentity proof path", () => {
    const content =
      "auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr });";
    const findings = scanFileContent(content);
    assert.ok(
      !findings.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
    );
  });
});

describe("readDeclaredCapabilities — run402.config.json capability union", () => {
  function writeConfig(obj) {
    const dir = mkdtempSync(join(tmpdir(), "r402-doctor-cap-"));
    writeFileSync(join(dir, "run402.config.json"), JSON.stringify(obj));
    return dir;
  }

  it("collects capabilities across functions.replace + functions.set", () => {
    const dir = writeConfig({
      functions: {
        replace: { api: { capabilities: ["auth.sessionMint"] } },
        set: { cron: { capabilities: ["other.cap"] } },
      },
    });
    const caps = readDeclaredCapabilities(dir);
    assert.ok(caps.has("auth.sessionMint"));
    assert.ok(caps.has("other.cap"));
  });

  it("returns an empty set when no config / no capabilities", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "r402-doctor-nocfg-"));
    assert.equal(readDeclaredCapabilities(emptyDir).size, 0);
    const noCapDir = writeConfig({ functions: { replace: { api: { config: {} } } } });
    assert.equal(readDeclaredCapabilities(noCapDir).size, 0);
  });

  it("scanSourceTree suppresses the mint warning when the config declares it", () => {
    const dir = mkdtempSync(join(tmpdir(), "r402-doctor-tree-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "login.ts"),
      "export default async () => auth.sessions.createResponseFromTenantAssertion({});",
    );
    writeFileSync(
      join(dir, "run402.config.json"),
      JSON.stringify({ functions: { replace: { api: { capabilities: ["auth.sessionMint"] } } } }),
    );
    const findings = scanSourceTree(join(dir, "src"), { cwd: dir });
    assert.ok(
      !findings.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
      "config-declared capability should suppress the tree-scan warning",
    );
  });
});

describe("scanSourceFiles — explicit file list (GH-409)", () => {
  function makeTwoFileDir() {
    const dir = mkdtempSync(join(tmpdir(), "r402-gh409-"));
    // A clean file referenced by a manifest — no auth violations.
    writeFileSync(join(dir, "clean.ts"), "export const x = 1;\n");
    // A sibling that legitimately imports a hallucinated name (e.g. the
    // gateway source tree implementing the auth surface). NOT in the
    // manifest, so it must never be scanned for a manifest-based deploy.
    writeFileSync(
      join(dir, "unrelated.ts"),
      'import { getUser } from "@run402/functions";\n',
    );
    return dir;
  }

  it("scanSourceTree (OLD behavior) WOULD flag the unrelated sibling — proving the bug", () => {
    const dir = makeTwoFileDir();
    const findings = scanSourceTree(dir, { cwd: dir });
    const errs = findings.filter((f) => f.severity === SCAN_SEVERITY.ERROR);
    assert.ok(
      errs.some((f) => f.file === "unrelated.ts" && f.attempted_name === "getUser"),
      "whole-tree scan should have surfaced the unrelated sibling (this is the bug)",
    );
  });

  it("scanSourceFiles([clean.ts]) returns ZERO error findings — GH-409 regression", () => {
    const dir = makeTwoFileDir();
    const findings = scanSourceFiles([join(dir, "clean.ts")], { cwd: dir });
    const errs = findings.filter((f) => f.severity === SCAN_SEVERITY.ERROR);
    assert.equal(
      errs.length,
      0,
      `scoped scan must not walk the sibling; got: ${JSON.stringify(errs)}`,
    );
  });

  it("scanSourceFiles([unrelated.ts]) STILL flags a file that IS in scope", () => {
    const dir = makeTwoFileDir();
    const findings = scanSourceFiles([join(dir, "unrelated.ts")], { cwd: dir });
    const f = findings.find(
      (x) => x.attempted_name === "getUser" && x.code === "R402_AUTH_UNKNOWN_EXPORT",
    );
    assert.ok(f, "in-scope file with a violation must still be flagged");
    assert.equal(f.severity, SCAN_SEVERITY.ERROR);
    assert.equal(f.file, "unrelated.ts");
  });

  it("labels findings relative to opts.cwd (mirroring scanSourceTree)", () => {
    const dir = mkdtempSync(join(tmpdir(), "r402-gh409-rel-"));
    mkdirSync(join(dir, "functions"));
    const abs = join(dir, "functions", "login.ts");
    writeFileSync(abs, 'import { getSession } from "@run402/functions";\n');
    const findings = scanSourceFiles([abs], { cwd: dir });
    const f = findings.find((x) => x.attempted_name === "getSession");
    assert.ok(f);
    assert.equal(f.file, join("functions", "login.ts"));
  });

  it("skips files without a scannable extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "r402-gh409-ext-"));
    const html = join(dir, "index.html");
    writeFileSync(html, '<script>const u = getSession();</script>\n');
    const findings = scanSourceFiles([html], { cwd: dir });
    assert.equal(findings.length, 0, ".html is not a scanned extension");
  });

  it("returns no findings for an empty file list", () => {
    assert.deepEqual(scanSourceFiles([], { cwd: tmpdir() }), []);
  });

  it("emits a warn finding for an unreadable (missing) file, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "r402-gh409-missing-"));
    const missing = join(dir, "ghost.ts");
    const findings = scanSourceFiles([missing], { cwd: dir });
    const f = findings.find((x) => x.code === "R402_AUTH_SOURCE_SCAN_ERROR");
    assert.ok(f, "unreadable file should produce a warn finding");
    assert.equal(f.severity, SCAN_SEVERITY.WARN);
    assert.equal(f.file, "ghost.ts");
  });

  it("respects opts.declaredCapabilities for the mint warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "r402-gh409-cap-"));
    const abs = join(dir, "login.ts");
    writeFileSync(
      abs,
      "export default async () => auth.sessions.createResponseFromTenantAssertion({});\n",
    );
    const withCap = scanSourceFiles([abs], {
      cwd: dir,
      declaredCapabilities: ["auth.sessionMint"],
    });
    assert.ok(
      !withCap.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
      "declared capability should suppress the mint warning",
    );
    const without = scanSourceFiles([abs], { cwd: dir });
    assert.ok(
      without.some((f) => f.code === "R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING"),
      "absent capability should surface the mint warning",
    );
  });
});
