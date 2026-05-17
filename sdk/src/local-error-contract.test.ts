import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  Run402,
  isLocalError,
  isRun402Error,
  type CredentialsProvider,
  type ProjectKeys,
} from "./index.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const PLAIN_ERROR_ALLOWLIST = [
  {
    file: "node/canonicalize.ts",
    snippet: 'throw new Error("canonicalizeJson: unsupported value type");',
    reason:
      "Internal canonicalizer guard for non-JSON JS values; public deploy validation wraps user-facing spec failures in Run402DeployError before this helper runs.",
  },
] as const;

test("local SDK validation failures throw structured LocalError", async () => {
  const r = clientWithProject();

  await assertLocalError(
    r.allowance.create(),
    "creating allowance",
    "This credential provider does not support allowance creation. Use @run402/sdk/node for local allowance management.",
  );
  await assertLocalError(
    r.billing.tierCheckout("hobby", {}),
    "creating tier checkout",
    "Provide either `email` or `wallet` in identifier.",
  );
  await assertLocalError(
    r.email.createMailbox("prj_test", "ab"),
    "creating mailbox",
    "Slug must be 3-63 characters.",
  );
  await assertLocalError(
    r.email.send("prj_test", { to: "agent@example.com" }),
    "sending email",
    "Provide either `template` + `variables` or both `subject` + `html`.",
  );
  await assertLocalError(
    r.assets.put("prj_test", "bundle.js", {
      content: "console.log('hi')",
      bytes: new Uint8Array([1]),
    }),
    "uploading blob",
    "Provide exactly one of `content` or `bytes` in BlobPutSource.",
  );
  await assertLocalError(
    r.projects.use("prj_test"),
    "setting active project",
    "This credential provider does not support setActiveProject",
  );
});

test("public SDK source does not throw plain Error", () => {
  const findings = sourceFiles(SRC_DIR)
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return text
        .split("\n")
        .map((line, index) => ({ file, line, lineNumber: index + 1 }))
        .filter(({ line }) => line.includes("throw new Error("));
    })
    .filter(({ file, line }) => !isPlainErrorAllowed(file, line));

  assert.deepEqual(
    findings.map(({ file, lineNumber, line }) => `${relative(SRC_DIR, file)}:${lineNumber}: ${line.trim()}`),
    [],
    "New public SDK plain Error throws must use Run402Error subclasses or be allowlisted with a justification.",
  );
});

function clientWithProject(): Run402 {
  const keys: ProjectKeys = {
    anon_key: "anon_test",
    service_key: "service_test",
  };
  const credentials: CredentialsProvider = {
    async getAuth() {
      return null;
    },
    async getProject(id) {
      return id === "prj_test" ? keys : null;
    },
  };

  return new Run402({
    apiBase: "https://api.test.run402.local",
    credentials,
    fetch: async () => new Response("{}", { status: 200 }),
  });
}

async function assertLocalError(
  promise: Promise<unknown>,
  context: string,
  messageIncludes: string,
): Promise<void> {
  try {
    await promise;
    assert.fail("Expected promise to reject");
  } catch (err) {
    assert.ok(isRun402Error(err), "expected a Run402Error");
    assert.ok(isLocalError(err), "expected a LocalError");
    assert.equal(err.kind, "local_error");
    assert.equal(err.context, context);
    assert.match(err.message, new RegExp(escapeRegExp(messageIncludes)));
    assert.equal(err.toJSON().kind, "local_error");
    assert.equal(JSON.parse(JSON.stringify(err)).context, context);
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [path];
  });
}

function isPlainErrorAllowed(file: string, line: string): boolean {
  const rel = relative(SRC_DIR, file);
  return PLAIN_ERROR_ALLOWLIST.some((allowed) =>
    allowed.file === rel &&
    line.includes(allowed.snippet),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
