/**
 * `run402 doctor` source-scan module (auth-aware-ssr Section 9).
 *
 * Walks the project's `src/` directory and reports patterns the
 * auth-aware-ssr design specifies as deploy-failing OR runtime warnings:
 *
 *   - **Hallucinated SDK names.** `getUser`, `getSession`, `currentUser`,
 *     `getCurrentUser`, `getServerSession`, `auth.protect`, `auth.signIn`,
 *     `auth.logout`, `auth.middleware`, etc. Each hit emits
 *     `R402_AUTH_UNKNOWN_EXPORT` with a structured fix-it (attempted name,
 *     canonical replacement, import line, docs URL).
 *
 *   - **State-changing GET handlers.** Astro pages that export a GET
 *     handler containing DB-mutation patterns (`db().insert`, `db().update`,
 *     `db().delete`, `adminDb().sql("UPDATE"`, etc.). Emit
 *     `R402_AUTH_STATE_CHANGING_GET`.
 *
 *   - **`auth.*` calls in prerendered pages.** Astro pages declaring
 *     `export const prerender = true` that also call `auth.*` helpers.
 *     Emit `R402_AUTH_PRERENDERED`.
 *
 *   - **Direct `internal.sessions.authz_version` mutation.** Consumer
 *     migrations that try to `UPDATE internal.sessions SET authz_version`
 *     manually. Emit `R402_AUTH_AUTHZ_VERSION_PROHIBITED`.
 *
 * The scanner is regex-based — fast, dependency-free, and good enough
 * for the canonical patterns. The `run402 doctor --json` mode emits the
 * structured envelope; the default mode prints a readable per-finding
 * summary. Wired into `run402 deploy` pre-flight as a deploy-failing
 * gate for the error severities; non-blocking for warning severities.
 *
 * @see openspec/changes/auth-aware-ssr/specs/functions-sdk-auth-model
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** Severity ladder for scanner findings. `error` blocks deploy; `warn`
 *  reports but doesn't block. The `run402 doctor` exit code is non-zero
 *  whenever any `error`-severity finding is present. */
export const SCAN_SEVERITY = Object.freeze({
  ERROR: "error",
  WARN: "warn",
});

/** File extensions scanned. Astro frontmatter + TS/JS are the primary
 *  surface; the regex matchers fire equally on all of them. `.astro`
 *  matters because consumers write SSR pages there. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);

/** Directories the scanner refuses to descend into. We never report
 *  on platform-generated code or vendored dependencies. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".vscode",
  ".idea",
  "dist",
  "build",
  "out",
  ".astro",
  ".next",
  ".vercel",
  ".netlify",
  "coverage",
]);

/** Hallucinated-name registry from the auth-aware-ssr spec. Each entry
 *  carries the canonical replacement so the fix-it is actionable. The
 *  list is intentionally exhaustive — every name flagged here came up
 *  in pre-launch LLM hallucination samples. */
const HALLUCINATED_NAMES = [
  // ESM named imports — caught by regex on import lines AND by call-site
  // matching when consumers paste from training-data examples.
  { name: "getUser", canonical: "auth.user() / auth.requireUser()", origin: "supabase / clerk / nextauth legacy" },
  { name: "getUserId", canonical: "(await auth.user())?.id", origin: "run402 v0.x" },
  { name: "getRole", canonical: "auth.requireRole(role)", origin: "run402 v0.x" },
  { name: "getSession", canonical: "auth.user()", origin: "next-auth / nextauth" },
  { name: "currentUser", canonical: "auth.user()", origin: "clerk" },
  { name: "currentSession", canonical: "auth.user()", origin: "clerk" },
  { name: "getCurrentUser", canonical: "auth.user()", origin: "generic" },
  { name: "getCurrentSession", canonical: "auth.user()", origin: "generic" },
  { name: "getServerSession", canonical: "auth.user()", origin: "next-auth" },
  { name: "getAuth", canonical: "auth.user() / auth.requireUser()", origin: "clerk" },
  { name: "requireAuth", canonical: "auth.requireUser()", origin: "generic" },
  { name: "withAuth", canonical: "auth.requireUser() inside the handler", origin: "next-auth-style HOC" },
  { name: "protectRoute", canonical: "auth.requireUser() inside the handler", origin: "generic" },
  { name: "useUser", canonical: "auth.user() (note: server-only; not a React hook)", origin: "clerk / supabase" },
  { name: "useSession", canonical: "auth.user() (note: server-only)", origin: "next-auth / clerk" },
  { name: "createServerClient", canonical: "db() (use the bundled SDK; no client setup needed)", origin: "supabase" },
  { name: "clerkClient", canonical: "auth.user() + db()", origin: "clerk" },
];

/** Property-access hallucinations on the `auth` object. The SDK's
 *  Proxy catches these at runtime, but the source scanner fires
 *  earlier so the deploy fails before the bundle ships. */
const HALLUCINATED_AUTH_PROPERTIES = [
  { name: "auth.session", canonical: "auth.user() then read .sessionId" },
  { name: "auth.getSession", canonical: "auth.user()" },
  { name: "auth.currentUser", canonical: "auth.user()" },
  { name: "auth.currentSession", canonical: "auth.user()" },
  { name: "auth.requireAuth", canonical: "auth.requireUser()" },
  { name: "auth.middleware", canonical: "auth.csrfField() / @run402/astro middleware" },
  { name: "auth.signIn", canonical: "POST /auth/sign-in or auth.sessions.createResponseFromIdentity({...})" },
  { name: "auth.signOut", canonical: "auth.sessions.endResponse()" },
  { name: "auth.signout", canonical: "auth.sessions.endResponse()" },
  { name: "auth.logout", canonical: "auth.sessions.endResponse()" },
  { name: "auth.login", canonical: "auth.sessions.createResponseFromIdentity({...})" },
  { name: "auth.redirectToSignIn", canonical: "auth.requireUser() — platform handles redirect" },
  { name: "auth.getUser", canonical: "auth.user()" },
  { name: "auth.getToken", canonical: "auth.requireUser() then read .sessionId (tokens not exposed)" },
  { name: "auth.protect", canonical: "auth.requireUser() / auth.requireRole(...)" },
];

/** Browser-only patterns that should NEVER appear in SSR / Lambda code.
 *  These are caught at scan time because the SDK doesn't ship a
 *  shim — the line just fails to execute. */
const BROWSER_ONLY_PATTERNS = [
  {
    pattern: /localStorage\.getItem\(\s*['"]wl_session['"]\s*\)/g,
    name: "localStorage.wl_session",
    canonical: "auth.user() (browser sessions are HttpOnly cookies; no localStorage)",
  },
  {
    // Matches: `Authorization: "Bearer ..."` (bare key + string value)
    //          `"Authorization": "Bearer ..."` (string key + string value)
    //          `'Authorization': 'Bearer ...'` (single quotes)
    pattern: /['"]?Authorization['"]?\s*[:,]\s*['"]Bearer\s/g,
    name: "Authorization: Bearer (in browser code)",
    canonical: "Browser code doesn't carry JWTs. Use auth.fetch() for same-origin SSR fetches.",
    severity: SCAN_SEVERITY.WARN, // Bearer is fine in server-side machine code; gated by file path.
  },
];

/** Scan a single file's content. Returns the array of findings (zero
 *  or more). Pure / no I/O — tests pass strings directly. */
export function scanFileContent(content, opts = {}) {
  const filePath = opts.filePath ?? "<inline>";
  const findings = [];

  // 1) Hallucinated bare names — import { getSession } from ... OR
  //    bare call sites `await getSession(...)`.
  for (const entry of HALLUCINATED_NAMES) {
    // Match in an `import { … }` statement OR a bare function-call site.
    // Negative-lookahead: don't fire on `auth.getSession` etc. (caught
    // separately by the auth-property scanner below).
    const importRegex = new RegExp(
      `import\\s*\\{[^}]*\\b${escapeRegex(entry.name)}\\b[^}]*\\}\\s*from\\s*['"]@run402/functions['"]`,
      "g",
    );
    const callRegex = new RegExp(
      `(?<![.\\w])${escapeRegex(entry.name)}\\s*\\(`,
      "g",
    );
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_UNKNOWN_EXPORT",
        severity: SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        attempted_name: entry.name,
        canonical_name: entry.canonical,
        import_line: 'import { auth } from "@run402/functions"',
        docs: "https://docs.run402.com/auth/sdk",
        message: `Import '${entry.name}' from @run402/functions is not a working export (origin: ${entry.origin}). Use ${entry.canonical}.`,
      });
    }
    while ((match = callRegex.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_UNKNOWN_EXPORT",
        severity: SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        attempted_name: entry.name,
        canonical_name: entry.canonical,
        import_line: 'import { auth } from "@run402/functions"',
        docs: "https://docs.run402.com/auth/sdk",
        message: `Call to '${entry.name}()' will throw R402_AUTH_UNKNOWN_EXPORT at runtime. Use ${entry.canonical}.`,
      });
    }
  }

  // 2) Hallucinated property access on `auth.*`. The SDK Proxy catches
  //    these at runtime; we catch earlier at deploy.
  for (const entry of HALLUCINATED_AUTH_PROPERTIES) {
    const regex = new RegExp(`(?<![\\w.])${escapeRegex(entry.name)}\\b`, "g");
    let match;
    while ((match = regex.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_UNKNOWN_EXPORT",
        severity: SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        attempted_name: entry.name,
        canonical_name: entry.canonical,
        import_line: 'import { auth } from "@run402/functions"',
        docs: "https://docs.run402.com/auth/sdk",
        message: `'${entry.name}' is not a valid auth.* helper. Use ${entry.canonical}.`,
      });
    }
  }

  // 3) Browser-only / wrong-environment patterns.
  for (const entry of BROWSER_ONLY_PATTERNS) {
    let match;
    while ((match = entry.pattern.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_UNKNOWN_EXPORT",
        severity: entry.severity ?? SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        attempted_name: entry.name,
        canonical_name: entry.canonical,
        message: `'${entry.name}' is not supported. ${entry.canonical}.`,
      });
    }
  }

  // 4) Prerendered pages calling auth.*. The Astro adapter throws
  //    R402_AUTH_PRERENDERED at build time; this catches earlier.
  if (filePath.endsWith(".astro") || filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    const declaresPrerender = /export\s+const\s+prerender\s*=\s*true/.test(content);
    if (declaresPrerender) {
      const authCallRegex = /\bauth\.(user|requireUser|requireRole|requireMembership|requireFresh|fetch|csrfToken|csrfField|sessions|identities)\b/g;
      let match;
      while ((match = authCallRegex.exec(content)) !== null) {
        findings.push({
          code: "R402_AUTH_PRERENDERED",
          severity: SCAN_SEVERITY.ERROR,
          file: filePath,
          line: lineNumberFor(content, match.index),
          message: `auth.${match[1]} called from a prerendered page. Convert to SSR (\`export const prerender = false\`) or use a server island.`,
          docs: "https://docs.run402.com/auth/rendering-modes",
        });
      }
    }
  }

  // 5) State-changing GET handlers. Heuristic: an Astro `export const GET`
  //    or a `GET` Web-handler containing db-mutation patterns.
  const getHandlerRegex = /export\s+(?:async\s+)?(?:const\s+|function\s+)GET\s*[=(]/g;
  const mutationInGetRegex = /\b(?:db|adminDb)\s*\(\s*\)?[^)]*\)?\s*\.(?:insert|update|delete)\s*\(/g;
  const sqlMutationRegex = /\.sql\s*\(\s*['"`]\s*(?:UPDATE|INSERT|DELETE)\b/gi;
  if (getHandlerRegex.test(content)) {
    let match;
    while ((match = mutationInGetRegex.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_STATE_CHANGING_GET",
        severity: SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        message: "GET handler mutates state. Move the mutation to POST.",
        docs: "https://docs.run402.com/auth/hosted-ui#post-only",
      });
    }
    while ((match = sqlMutationRegex.exec(content)) !== null) {
      findings.push({
        code: "R402_AUTH_STATE_CHANGING_GET",
        severity: SCAN_SEVERITY.ERROR,
        file: filePath,
        line: lineNumberFor(content, match.index),
        message: "GET handler runs UPDATE/INSERT/DELETE SQL. Move the mutation to POST.",
        docs: "https://docs.run402.com/auth/hosted-ui#post-only",
      });
    }
  }

  // 6) Direct mutation of internal.sessions.authz_version in consumer
  //    migrations or SQL strings. The platform is the sole writer.
  const authzVersionRegex = /UPDATE\s+internal\.sessions\s+SET\s+authz_version\b/gi;
  let m;
  while ((m = authzVersionRegex.exec(content)) !== null) {
    findings.push({
      code: "R402_AUTH_AUTHZ_VERSION_PROHIBITED",
      severity: SCAN_SEVERITY.ERROR,
      file: filePath,
      line: lineNumberFor(content, m.index),
      message: "Consumer code may not mutate internal.sessions.authz_version directly. Register your grants table in the authz manifest so the platform installs the bump trigger.",
      docs: "https://docs.run402.com/auth/db-actor-context#authz-version",
    });
  }

  return findings;
}

/** Recursively walk `srcDir` and scan every file with a relevant
 *  extension. Returns the combined findings list, sorted by file +
 *  line for stable output. */
export function scanSourceTree(srcDir, opts = {}) {
  const findings = [];
  walk(srcDir, (filePath) => {
    if (!SCANNED_EXTENSIONS.has(extname(filePath))) return;
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      findings.push({
        code: "R402_AUTH_SOURCE_SCAN_ERROR",
        severity: SCAN_SEVERITY.WARN,
        file: relative(opts.cwd ?? srcDir, filePath),
        message: `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    findings.push(
      ...scanFileContent(content, { filePath: relative(opts.cwd ?? srcDir, filePath) }),
    );
  });
  findings.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return findings;
}

function walk(dir, visitor) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(join(dir, entry.name), visitor);
    } else if (entry.isFile()) {
      visitor(join(dir, entry.name));
    }
  }
}

function lineNumberFor(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convenience for tests: synchronous, no FS access. */
export function _testOnly_hallucinatedNames() {
  return HALLUCINATED_NAMES.slice();
}

export function _testOnly_authProperties() {
  return HALLUCINATED_AUTH_PROPERTIES.slice();
}

/** Resolve the project's src/ directory. Astro convention is `<root>/src`;
 *  bare Node projects use `<root>/src` or `<root>`. We prefer `src/` if
 *  it exists. */
export function resolveScanRoot(cwd = process.cwd()) {
  const srcDir = join(cwd, "src");
  try {
    if (statSync(srcDir).isDirectory()) return srcDir;
  } catch {
    // Fall through.
  }
  return cwd;
}
