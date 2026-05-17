/**
 * Regression tests for CLI argv parsing.
 *
 * These stay separate from cli-e2e.test.mjs so parser failures are fast and
 * focused: no command should reach the network when argv itself is invalid.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const tempDir = mkdtempSync(join(tmpdir(), "run402-argv-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalStdin = process.stdin;
let stdout = [];
let stderr = [];
let calls = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestInfo(input, init) {
  const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.origin === API ? `${parsed.pathname}${parsed.search}` : url;
  return { url, method, path, init };
}

function mockFetch(input, init) {
  const info = requestInfo(input, init);
  calls.push(info);
  const pathNoQuery = info.path.split("?")[0];

  if (pathNoQuery === "/storage/v1/blobs" && info.method === "GET") {
    return Promise.resolve(json({ blobs: [{ key: "file.txt" }] }));
  }
  if (/\/functions\/hello\/logs$/.test(pathNoQuery) && info.method === "GET") {
    return Promise.resolve(json({ logs: [{ timestamp: "2026-05-01T00:00:00Z", message: "ok" }] }));
  }
  if (/\/functions\/hello$/.test(pathNoQuery) && info.method === "PATCH") {
    return Promise.resolve(json({ name: "hello", status: "updated" }));
  }

  return Promise.resolve(json({ ok: true }));
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function stderrJson() {
  const line = stderr.find((s) => s.trim().startsWith("{"));
  assert.ok(line, `expected JSON stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

async function expectExit1(fn) {
  let threw = null;
  captureStart();
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)");
  return stderrJson();
}

async function withMockStdin(chunks, fn, { isTTY = false } = {}) {
  const stream = Readable.from(chunks);
  stream.isTTY = isTTY;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
}

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  saveProject("prj_test123", {
    anon_key: "anon_test_key",
    service_key: "svc_test_key",
  });
  setActiveProjectId("prj_test123");
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

describe("unknown flags", () => {
  it("status rejects unknown flags before doing any work (GH-190)", async () => {
    const { run } = await import("./cli/lib/status.mjs");
    const err = await expectExit1(() => run(["--unknownflag"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--unknownflag");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("functions logs rejects unknown flags before fetching logs (GH-190)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--no-such-flag", "value"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--no-such-flag");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("email argv validation", () => {
  it("email list rejects unknown --projct before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("list", ["--projct", "prj_test123"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email get rejects missing --project value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("get", ["msg_1", "--project"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--project");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email get-raw rejects missing --output value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("get-raw", ["msg_1", "--output"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--output");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email reply rejects missing --html value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("reply", ["msg_1", "--html"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--html");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("email delete rejects missing --project value before network (GH-277)", async () => {
    const { run } = await import("./cli/lib/email.mjs");
    const err = await expectExit1(() => run("delete", ["--confirm", "--project"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--project");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("email webhooks argv validation", () => {
  it("webhooks list rejects unknown --projct before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("list", ["--projct", "prj_test123"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks register rejects missing --url value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("register", ["--url"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--url");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks register rejects missing --events value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() =>
      run("register", ["--url", "https://example.com/hook", "--events"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--events");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks update rejects missing --events value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("update", ["whk_1", "--events"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--events");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("webhooks update rejects missing --url value before network (GH-278)", async () => {
    const { run } = await import("./cli/lib/webhooks.mjs");
    const err = await expectExit1(() => run("update", ["whk_1", "--url"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--url");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("ai argv validation (GH-280)", () => {
  it("ai translate rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("translate", ["text", "--too", "fr"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--too");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai translate rejects missing --to value before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("translate", ["text", "--to"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--to");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai moderate rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("moderate", ["text", "--projct", "prj_x"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });

  it("ai usage rejects typoed flags before SDK/network", async () => {
    const { run } = await import("./cli/lib/ai.mjs");
    const err = await expectExit1(() =>
      run("usage", ["--projct", "prj_x"]));

    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--projct");
    assert.equal(calls.length, 0, "invalid argv must not hit the network");
  });
});

describe("projects costs argv validation", () => {
  it("rejects invalid --window before network", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const err = await expectExit1(() => run("costs", ["--window", "1y"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--window");
    assert.equal(calls.length, 0, "bad --window must not hit the network");
  });
});

describe("contracts wei argv validation", () => {
  for (const thresholdWei of ["abc", "1.5", "-1", "1e18"]) {
    it(`set-alert rejects malformed --threshold-wei ${JSON.stringify(thresholdWei)} before network`, async () => {
      const { run } = await import("./cli/lib/contracts.mjs");
      const err = await expectExit1(() =>
        run("set-alert", ["prj_test123", "cwlt_test", "--threshold-wei", thresholdWei]));

      assert.equal(err.code, "BAD_FLAG");
      assert.equal(err.details.flag, "--threshold-wei");
      assert.equal(calls.length, 0, "bad --threshold-wei must not hit the network");
    });
  }

  for (const valueWei of ["abc", "1.5", "-1", "1e18"]) {
    it(`call rejects malformed --value-wei ${JSON.stringify(valueWei)} before network`, async () => {
      const { run } = await import("./cli/lib/contracts.mjs");
      const err = await expectExit1(() =>
        run("call", [
          "prj_test123",
          "cwlt_test",
          "--to",
          "0x4444444444444444444444444444444444444444",
          "--abi",
          "[]",
          "--fn",
          "noop",
          "--args",
          "[]",
          "--value-wei",
          valueWei,
        ]));

      assert.equal(err.code, "BAD_FLAG");
      assert.equal(err.details.flag, "--value-wei");
      assert.equal(calls.length, 0, "bad --value-wei must not hit the network");
    });
  }
});

describe("2026-05 CLI bug backlog argv validation", () => {
  const invalidCases = [
    {
      issue: "GH-319",
      name: "blob sign rejects TTL below signed URL minimum",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("sign", ["reports/a.pdf", "--project", "prj_test123", "--ttl", "59"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-318",
      name: "blob get rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("get", ["a.txt", "b.txt", "--output", join(tempDir, "blob-extra.txt"), "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob rm rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("rm", ["a.txt", "b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob sign rejects extra positional keys",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("sign", ["a.txt", "b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-318",
      name: "blob diagnose rejects extra positional URLs",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("diagnose", ["https://app.run402.com/_blob/a.txt", "https://app.run402.com/_blob/b.txt", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-306",
      name: "blob put rejects multi-file uploads with a fixed --key",
      module: "./cli/lib/assets.mjs",
      call: (run) => run("put", ["./a.txt", "./b.txt", "--key", "release/current.txt"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-305",
      name: "cdn wait-fresh rejects invalid SHA values",
      module: "./cli/lib/cdn.mjs",
      call: (run) => run("wait-fresh", ["https://example.com/a.png", "--sha", "not-a-sha"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-305",
      name: "cdn wait-fresh rejects non-integer timeout values",
      module: "./cli/lib/cdn.mjs",
      call: (run) => run("wait-fresh", ["https://example.com/a.png", "--sha", "a".repeat(64), "--timeout", "NaN"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-304",
      name: "sites deploy rejects unknown flags",
      module: "./cli/lib/sites.mjs",
      call: (run) => run("deploy", ["--manifest", "site.json", "--manfiest", "typo.json"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-304",
      name: "sites deploy-dir rejects extra paths",
      module: "./cli/lib/sites.mjs",
      call: (run) => run("deploy-dir", ["dist", "dist-copy", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-303",
      name: "tier set rejects extra positional arguments",
      module: "./cli/lib/tier.mjs",
      call: (run) => run("set", ["prototype", "team"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-302",
      name: "message send rejects option-looking tokens",
      module: "./cli/lib/message.mjs",
      call: (run) => run("send", ["--file", "./message.txt"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-301",
      name: "agent contact rejects unknown flags",
      module: "./cli/lib/agent.mjs",
      call: (run) => run("contact", ["--name", "agent", "--emali", "a@example.com"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-300",
      name: "apps publish rejects missing flag values",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("publish", ["prj_test123", "--description"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-299",
      name: "apps update rejects conflicting fork policy flags",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("update", ["prj_test123", "ver_1", "--fork-allowed", "--no-fork"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-298",
      name: "apps fork rejects unsupported --tier",
      module: "./cli/lib/apps.mjs",
      call: (run) => run("fork", ["ver_1", "copy", "--tier", "hobby"]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-297",
      name: "secrets delete rejects extra arguments",
      module: "./cli/lib/secrets.mjs",
      call: (run) => run("delete", ["prj_test123", "API_KEY", "OTHER_KEY"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-295",
      name: "secrets set rejects inline value plus --file",
      module: "./cli/lib/secrets.mjs",
      call: (run) => run("set", ["prj_test123", "API_KEY", "inline", "--file", "./prod-secret.txt"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-294",
      name: "image generate rejects invalid aspect values",
      module: "./cli/lib/image.mjs",
      call: (run) => run("generate", ["prompt", "--aspect", "panorama"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-293",
      name: "image generate rejects extra prompt words",
      module: "./cli/lib/image.mjs",
      call: (run) => run("generate", ["a", "cyberpunk", "eagle"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-292",
      name: "domains delete rejects extra positional domains",
      module: "./cli/lib/domains.mjs",
      call: (run) => run("delete", ["example.com", "extra.com", "--confirm"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-291",
      name: "subdomains delete rejects extra positional names",
      module: "./cli/lib/subdomains.mjs",
      call: (run) => run("delete", ["site-a", "site-b", "--confirm"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-290",
      name: "subdomains claim rejects missing flag values",
      module: "./cli/lib/subdomains.mjs",
      call: (run) => run("claim", ["site-a", "--deployment"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-289",
      name: "sender-domain register rejects extra domains",
      module: "./cli/lib/sender-domain.mjs",
      call: (run) => run("register", ["example.com", "typo.com", "--project", "prj_test123"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-288",
      name: "sender-domain status rejects missing --project values",
      module: "./cli/lib/sender-domain.mjs",
      call: (run) => run("status", ["--project"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-287",
      name: "contracts drain rejects malformed destination addresses",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("drain", ["prj_test123", "cwlt_1", "--to", "0xabc", "--confirm"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-286",
      name: "contracts provision-wallet rejects unsupported chains",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("provision-wallet", ["prj_test123", "--chain", "polygon"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-285",
      name: "contracts set-recovery rejects --clear and --address together",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("set-recovery", ["prj_test123", "cwlt_1", "--clear", "--address", "0x1111111111111111111111111111111111111111"]),
      code: "BAD_USAGE",
    },
    {
      issue: "GH-284",
      name: "contracts call rejects unknown flags",
      module: "./cli/lib/contracts.mjs",
      call: (run) => run("call", [
        "prj_test123",
        "cwlt_1",
        "--to",
        "0x4444444444444444444444444444444444444444",
        "--abi",
        "[]",
        "--fn",
        "noop",
        "--args",
        "[]",
        "--chaim",
        "base-sepolia",
      ]),
      code: "UNKNOWN_FLAG",
    },
    {
      issue: "GH-283",
      name: "billing history rejects fractional limits",
      module: "./cli/lib/billing.mjs",
      call: (run) => run("history", ["user@example.com", "--limit", "1.5"]),
      code: "BAD_FLAG",
    },
    {
      issue: "GH-282",
      name: "billing tier-checkout rejects missing flag values",
      module: "./cli/lib/billing.mjs",
      call: (run) => run("tier-checkout", ["prototype", "--email"]),
      code: "BAD_FLAG",
    },
  ];

  for (const testCase of invalidCases) {
    it(`${testCase.issue}: ${testCase.name}`, async () => {
      const { run } = await import(testCase.module);
      const err = await expectExit1(() => testCase.call(run));

      assert.equal(err.code, testCase.code);
      assert.equal(calls.length, 0, "invalid argv must not hit the network");
    });
  }

  it("GH-296: secrets set allows an intentional empty-string value", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("set", ["prj_test123", "EMPTY_SECRET", ""]);
    captureStop();

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "");
  });

  it("GH-336: secrets set --stdin reads the secret from stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const value = readSecretValueForSet(["--stdin"], [], {
      readStdin: () => "pipe_secret",
    });

    assert.equal(value, "pipe_secret");
    assert.equal(calls.length, 0, "stdin value resolution must not hit the network");
  });

  it("GH-336: secrets set --file stdin aliases read stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const seen = [];
    const readers = {
      readStdin: () => "pipe_secret",
      readFile: (path) => {
        seen.push(["readFile", path]);
        return "file_secret";
      },
      validateFile: (path) => {
        seen.push(["validateFile", path]);
      },
    };

    assert.equal(readSecretValueForSet(["--file", "/dev/stdin"], [], readers), "pipe_secret");
    assert.equal(readSecretValueForSet(["--file", "-"], [], readers), "pipe_secret");
    assert.deepEqual(seen, []);
    assert.equal(calls.length, 0, "stdin value resolution must not hit the network");
  });

  it("GH-336: secrets set normal --file still validates and reads the file", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const seen = [];
    const value = readSecretValueForSet(["--file", "./secret.txt"], [], {
      validateFile: (path, flag) => seen.push(["validateFile", path, flag]),
      readFile: (path) => {
        seen.push(["readFile", path]);
        return "file_secret";
      },
    });

    assert.equal(value, "file_secret");
    assert.deepEqual(seen, [
      ["validateFile", "./secret.txt", "--file"],
      ["readFile", "./secret.txt"],
    ]);
    assert.equal(calls.length, 0, "file value resolution must not hit the network");
  });

  it("GH-336: secrets set rejects inline values combined with --stdin", async () => {
    const { readSecretValueForSet } = await import("./cli/lib/secrets.mjs");
    const err = await expectExit1(() =>
      readSecretValueForSet(["--stdin"], ["inline"], { readStdin: () => "pipe_secret" }));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /exactly one secret value source/);
    assert.equal(calls.length, 0, "invalid value source selection must not hit the network");
  });

  it("secrets set --stdin reads piped values without echoing them", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["stdin-secret-value"], async () => {
      captureStart();
      await run("set", ["prj_test123", "STDIN_SECRET", "--stdin"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "stdin-secret-value");
    assert.doesNotMatch(stdout.join("\n"), /stdin-secret-value/);
    assert.doesNotMatch(stderr.join("\n"), /stdin-secret-value/);
  });

  it("secrets set --file - reads stdin as a POSIX alias", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["dash-stdin-secret"], async () => {
      captureStart();
      await run("set", ["prj_test123", "DASH_SECRET", "--file", "-"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "dash-stdin-secret");
  });

  it("secrets set --file /dev/stdin reads stdin without regular-file validation", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    await withMockStdin(["dev-stdin-secret"], async () => {
      captureStart();
      await run("set", ["prj_test123", "DEV_STDIN_SECRET", "--file", "/dev/stdin"]);
      captureStop();
    });

    const call = calls.find((c) => c.path === "/projects/v1/admin/prj_test123/secrets");
    assert.ok(call, `expected secrets set request, got ${JSON.stringify(calls)}`);
    assert.equal(JSON.parse(call.init.body).value, "dev-stdin-secret");
  });

  it("secrets set rejects inline value plus --stdin without leaking the value", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    const err = await expectExit1(() =>
      run("set", ["prj_test123", "API_KEY", "super-secret-inline", "--stdin"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.deepEqual(err.details.sources, ["inline", "--stdin"]);
    assert.equal(calls.length, 0, "conflicting sources must not hit the network");
    assert.doesNotMatch(JSON.stringify(err), /super-secret-inline/);
  });

  it("secrets set --stdin rejects empty stdin before network", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    const err = await withMockStdin([], () =>
      expectExit1(() => run("set", ["prj_test123", "EMPTY_STDIN_SECRET", "--stdin"])));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /stdin/i);
    assert.equal(calls.length, 0, "empty stdin must not hit the network");
  });
});

describe("--flag=value", () => {
  it("blob ls accepts equals-form flags (GH-189)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    captureStart();
    await run("ls", ["--project=prj_test123", "--limit=500"]);
    captureStop();

    const call = calls.find((c) => c.path.startsWith("/storage/v1/blobs?"));
    assert.ok(call, `expected blob list request, got ${JSON.stringify(calls)}`);
    assert.match(call.url, /limit=500/);
    assert.ok(stdout.join("\n").includes("file.txt"));
  });

  it("functions logs accepts equals-form numeric flags (GH-189)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", ["prj_test123", "hello", "--tail=10"]);
    captureStop();

    const call = calls.find((c) => /\/logs\?/.test(c.path));
    assert.ok(call, `expected logs request, got ${JSON.stringify(calls)}`);
    assert.match(call.url, /tail=10/);
  });

  it("functions logs accepts equals-form request-id filters", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", ["prj_test123", "hello", "--request-id=req_abc123"]);
    captureStop();

    const call = calls.find((c) => /\/logs\?/.test(c.path));
    assert.ok(call, `expected logs request, got ${JSON.stringify(calls)}`);
    assert.equal(new URL(call.url).searchParams.get("request_id"), "req_abc123");
  });
});

describe("function log filter validation", () => {
  it("functions logs rejects invalid --since before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--since", "not-a-date"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--since");
    assert.equal(calls.length, 0, "bad --since must not hit the network");
  });

  it("functions logs rejects invalid --request-id before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--request-id", "trace_abc"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.equal(err.details.flag, "--request-id");
    assert.equal(calls.length, 0, "bad --request-id must not hit the network");
  });

  it("functions logs rejects --tail above the gateway bound before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("logs", ["prj_test123", "hello", "--tail", "1001"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.equal(err.details.flag, "--tail");
    assert.equal(calls.length, 0, "bad --tail must not hit the network");
  });

  it("functions logs follow dedupes same-millisecond entries by event identity", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const prevFetch = globalThis.fetch;
    const prevSetTimeout = globalThis.setTimeout;
    const timestamp = "2026-05-01T00:00:00.000Z";
    let logFetches = 0;
    let sleeps = 0;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      const pathNoQuery = info.path.split("?")[0];
      if (/\/functions\/hello\/logs$/.test(pathNoQuery) && info.method === "GET") {
        logFetches += 1;
        const logs = logFetches === 1
          ? [
              { timestamp, message: "first", event_id: "evt-1", log_stream_name: "stream-a" },
              { timestamp, message: "second", event_id: "evt-2", log_stream_name: "stream-a" },
            ]
          : [
              { timestamp, message: "first", event_id: "evt-1", log_stream_name: "stream-a" },
              { timestamp, message: "second", event_id: "evt-2", log_stream_name: "stream-a" },
              { timestamp, message: "third", event_id: "evt-3", log_stream_name: "stream-a" },
            ];
        return Promise.resolve(json({ logs }));
      }
      return mockFetch(input, init);
    };
    globalThis.setTimeout = (fn, _ms, ...args) => {
      sleeps += 1;
      queueMicrotask(() => {
        if (sleeps >= 2) process.emit("SIGINT");
        fn(...args);
      });
      return 0;
    };

    try {
      captureStart();
      await run("logs", ["prj_test123", "hello", "--follow"]);
      captureStop();
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
      globalThis.setTimeout = prevSetTimeout;
    }

    const output = stdout.join("\n");
    assert.equal((output.match(/first/g) || []).length, 1);
    assert.equal((output.match(/second/g) || []).length, 1);
    assert.equal((output.match(/third/g) || []).length, 1);
    const logCalls = calls.filter((c) => /\/logs\?/.test(c.path));
    assert.ok(logCalls.length >= 2, `expected at least two log polls, got ${JSON.stringify(logCalls)}`);
    assert.equal(
      new URL(logCalls[1].url).searchParams.get("since"),
      String(new Date(timestamp).getTime()),
    );
  });
});

describe("function deploy argv validation", () => {
  it("functions deploy rejects empty dependency entries before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const codePath = join(tempDir, "handler-deps.mjs");
    writeFileSync(codePath, "export default async () => new Response('ok')");

    for (const deps of ["axios,", "axios,,date-fns", "axios,   "]) {
      calls = [];
      const err = await expectExit1(() =>
        run("deploy", ["prj_test123", "hello", "--file", codePath, "--deps", deps]));

      assert.equal(err.code, "BAD_USAGE");
      assert.equal(err.details.flag, "--deps");
      assert.equal(calls.length, 0, `bad --deps ${JSON.stringify(deps)} must not hit the network`);
    }
  });
});

describe("function update argv validation", () => {
  it("functions update rejects --schedule with --schedule-remove before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("update", ["prj_test123", "hello", "--schedule", "0 * * * *", "--schedule-remove"]));

    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /mutually exclusive/);
    assert.equal(calls.length, 0, "conflicting schedule flags must not hit the network");
  });
});

describe("function list/delete argv validation", () => {
  it("functions list rejects extra args and flags before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    let err = await expectExit1(() => run("list", ["prj_test123", "extra"]));
    assert.equal(err.code, "BAD_USAGE");
    assert.equal(calls.length, 0, "extra list arg must not hit the network");

    calls = [];
    err = await expectExit1(() => run("list", ["prj_test123", "--json"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--json");
    assert.equal(calls.length, 0, "unknown list flag must not hit the network");
  });

  it("functions delete rejects extra args and flags before network", async () => {
    const { run } = await import("./cli/lib/functions.mjs");

    let err = await expectExit1(() => run("delete", ["prj_test123", "hello", "extra"]));
    assert.equal(err.code, "BAD_USAGE");
    assert.equal(calls.length, 0, "extra delete arg must not hit the network");

    calls = [];
    err = await expectExit1(() => run("delete", ["prj_test123", "hello", "--force"]));
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details.flag, "--force");
    assert.equal(calls.length, 0, "unknown delete flag must not hit the network");
  });
});

describe("numeric flag validation", () => {
  it("blob ls validates --limit before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    for (const value of ["notanumber", "0", "999999"]) {
      calls = [];
      const err = await expectExit1(() => run("ls", ["--project", "prj_test123", "--limit", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--limit/);
      assert.equal(calls.length, 0, `bad --limit ${value} must not hit network`);
    }
  });

  it("blob sign validates --ttl before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    for (const value of ["abc", "-1", "99999999"]) {
      calls = [];
      const err = await expectExit1(() => run("sign", ["reports/a.pdf", "--project", "prj_test123", "--ttl", value]));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--ttl/);
      assert.equal(calls.length, 0, `bad --ttl ${value} must not hit network`);
    }
  });

  it("blob put validates --concurrency before upload init (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "upload.txt");
    writeFileSync(file, "hello");
    const err = await expectExit1(() =>
      run("put", [file, "--project", "prj_test123", "--concurrency", "0"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--concurrency/);
    assert.equal(calls.length, 0, "bad --concurrency must not init an upload");
  });

  it("blob put validates --content-type before upload init (GH-237)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "bad-mime.txt");
    writeFileSync(file, "hello");
    for (const value of ["", "image", "/svg", "image/"]) {
      calls = [];
      const argv = value === ""
        ? [file, "--project", "prj_test123", "--content-type"]
        : [file, "--project", "prj_test123", "--content-type", value];
      const err = await expectExit1(() => run("put", argv));
      assert.equal(err.code, "BAD_FLAG");
      assert.match(err.message, /--content-type/);
      assert.equal(calls.length, 0, `bad --content-type ${JSON.stringify(value)} must not init an upload`);
    }
  });

  it("blob put sends explicit --content-type to upload init (GH-237)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "extensionless-asset");
    writeFileSync(file, "<svg></svg>");
    let initBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        initBody = JSON.parse(String(info.init.body));
        return Promise.resolve(json({
          upload_id: "upload_mime",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.example.test/upload_mime/p1", byte_start: 0, byte_end: 10 }],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_mime/p1" && info.method === "PUT") {
        return Promise.resolve(new Response("", { status: 200, headers: { etag: "\"etag-1\"" } }));
      }
      if (info.path === "/storage/v1/uploads/upload_mime/complete" && info.method === "POST") {
        return Promise.resolve(json({
          key: "assets/logo",
          size_bytes: 11,
          sha256: null,
          visibility: "public",
          content_type: "image/svg+xml",
          url: "https://pr-test.run402.com/_blob/assets/logo",
          immutable_url: null,
        }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("put", [
        file,
        "--project", "prj_test123",
        "--key", "assets/logo",
        "--content-type", "image/svg+xml",
        "--no-resume",
      ]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }

    assert.equal(initBody?.content_type, "image/svg+xml");
    assert.equal(initBody?.key, "assets/logo");
  });

  it("blob put sends required object and part checksums by default (GH-308, GH-312, GH-314)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "checksum-upload.txt");
    writeFileSync(file, "hello world");
    let initBody = null;
    let completeBody = null;
    let putHeaders = null;
    const expectedSha = createHash("sha256").update("hello world").digest("hex");
    const expectedPartChecksum = createHash("sha256").update("hello world").digest("base64");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        initBody = JSON.parse(String(info.init.body));
        return Promise.resolve(json({
          upload_id: "upload_checksum",
          mode: "multipart",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.example.test/upload_checksum/p1", byte_start: 0, byte_end: 10 }],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_checksum/p1" && info.method === "PUT") {
        putHeaders = info.init.headers ?? {};
        return Promise.resolve(new Response("", { status: 200, headers: { etag: "\"etag-1\"" } }));
      }
      if (info.path === "/storage/v1/uploads/upload_checksum/complete" && info.method === "POST") {
        completeBody = JSON.parse(String(info.init.body));
        return Promise.resolve(json({
          key: "checksum-upload.txt",
          size_bytes: 11,
          sha256: expectedSha,
          visibility: "public",
          content_type: "text/plain",
          url: "https://pr-test.run402.com/_blob/checksum-upload.txt",
          immutable_url: null,
        }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--no-resume"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }

    assert.equal(initBody?.sha256, expectedSha);
    assert.equal(initBody?.immutable, false);
    assert.equal(putHeaders?.["x-amz-checksum-sha256"], expectedPartChecksum);
    assert.deepEqual(completeBody?.parts, [
      { part_number: 1, etag: "\"etag-1\"", sha256: expectedSha },
    ]);
  });

  it("blob put does not complete multipart uploads until every in-flight part settles (GH-315)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "concurrency-upload.txt");
    writeFileSync(file, "abcdefghi");
    let part2Resolved = false;
    let completeBeforePart2 = false;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        return Promise.resolve(json({
          upload_id: "upload_concurrency",
          mode: "multipart",
          part_count: 3,
          parts: [
            { part_number: 1, url: "https://s3.example.test/upload_concurrency/p1", byte_start: 0, byte_end: 2 },
            { part_number: 2, url: "https://s3.example.test/upload_concurrency/p2", byte_start: 3, byte_end: 5 },
            { part_number: 3, url: "https://s3.example.test/upload_concurrency/p3", byte_start: 6, byte_end: 8 },
          ],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_concurrency/p2" && info.method === "PUT") {
        return new Promise((resolve) => {
          setTimeout(() => {
            part2Resolved = true;
            resolve(new Response("", { status: 200, headers: { etag: "\"etag-2\"" } }));
          }, 100);
        });
      }
      if (info.url.startsWith("https://s3.example.test/upload_concurrency/p") && info.method === "PUT") {
        const partNumber = info.url.endsWith("/p1") ? "1" : "3";
        return Promise.resolve(new Response("", { status: 200, headers: { etag: `"etag-${partNumber}"` } }));
      }
      if (info.path === "/storage/v1/uploads/upload_concurrency/complete" && info.method === "POST") {
        completeBeforePart2 = !part2Resolved;
        return Promise.resolve(json({
          key: "concurrency-upload.txt",
          size_bytes: 9,
          sha256: createHash("sha256").update("abcdefghi").digest("hex"),
          visibility: "public",
          content_type: "text/plain",
          url: "https://pr-test.run402.com/_blob/concurrency-upload.txt",
          immutable_url: null,
        }));
      }
      return mockFetch(input, init);
    };
    captureStart();
    try {
      await run("put", [file, "--project", "prj_test123", "--concurrency", "2", "--no-resume"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }

    assert.equal(completeBeforePart2, false, "complete must wait for all in-flight parts");
  });

  it("blob resumable state is private, checksum-bearing, and does not persist presigned URLs (GH-316, GH-317)", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "run402-blob-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = stateHome;
    const { run } = await import("./cli/lib/assets.mjs?state-private");
    const file = join(tempDir, "state-upload.txt");
    writeFileSync(file, "hello state");
    const expectedSha = createHash("sha256").update("hello state").digest("hex");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        return Promise.resolve(json({
          upload_id: "upload_state",
          mode: "multipart",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.example.test/upload_state/p1", byte_start: 0, byte_end: 10 }],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_state/p1" && info.method === "PUT") {
        return Promise.resolve(new Response("denied", { status: 403, statusText: "Forbidden" }));
      }
      return mockFetch(input, init);
    };

    try {
      const err = await expectExit1(() => run("put", [file, "--project", "prj_test123"]));
      assert.match(err.message, /Part 1 PUT failed/);

      const stateDir = join(stateHome, ".run402", "uploads");
      const files = readdirSync(stateDir).filter((name) => name.endsWith(".json"));
      assert.deepEqual(files, ["upload_state.json"]);
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      const statePath = join(stateDir, "upload_state.json");
      assert.equal(statSync(statePath).mode & 0o777, 0o600);
      const raw = readFileSync(statePath, "utf8");
      assert.equal(raw.includes("https://s3.example.test"), false, "state must not persist presigned URLs");
      const state = JSON.parse(raw);
      assert.equal(state.sha256, expectedSha);
      assert.equal(state.file_size, 11);
      assert.equal(typeof state.file_mtime_ms, "number");
    } finally {
      globalThis.fetch = prevFetch;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  it("blob put discards cached upload sessions when the local file changed (GH-316)", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "run402-blob-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = stateHome;
    const { run } = await import("./cli/lib/assets.mjs?state-fingerprint");
    const stateDir = join(stateHome, ".run402", "uploads");
    const file = join(tempDir, "state-changed.txt");
    writeFileSync(file, "new file");
    const absFile = join(tempDir, "state-changed.txt");
    const staleState = {
      upload_id: "upload_stale",
      project_id: "prj_test123",
      local_path: absFile,
      key: "state-changed.txt",
      mode: "multipart",
      part_size_bytes: 3,
      part_count: 1,
      file_size: 999,
      file_mtime_ms: 1,
      parts_done: {},
      sha256: "0".repeat(64),
    };
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(file, "new file");
    const prevFetch = globalThis.fetch;
    let fetchedStale = false;
    let initUploadId = null;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads/upload_stale" && info.method === "GET") {
        fetchedStale = true;
        return Promise.resolve(json({ upload_id: "upload_stale", status: "active" }));
      }
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        initUploadId = "upload_fresh";
        return Promise.resolve(json({
          upload_id: "upload_fresh",
          mode: "single",
          part_count: 1,
          parts: [{ part_number: 1, url: "https://s3.example.test/upload_fresh/p1", byte_start: 0, byte_end: 7 }],
        }, 201));
      }
      if (info.url === "https://s3.example.test/upload_fresh/p1" && info.method === "PUT") {
        return Promise.resolve(new Response("", { status: 200, headers: { etag: "\"etag-fresh\"" } }));
      }
      if (info.path === "/storage/v1/uploads/upload_fresh/complete" && info.method === "POST") {
        return Promise.resolve(json({
          key: "state-changed.txt",
          size_bytes: 8,
          sha256: createHash("sha256").update("new file").digest("hex"),
          visibility: "public",
          content_type: "text/plain",
          url: "https://pr-test.run402.com/_blob/state-changed.txt",
          immutable_url: null,
        }));
      }
      return mockFetch(input, init);
    };

    try {
      rmSync(stateDir, { recursive: true, force: true });
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateDir, "upload_stale.json"), JSON.stringify(staleState, null, 2), { mode: 0o600 });
      captureStart();
      await run("put", [file, "--project", "prj_test123"]);
      captureStop();
      assert.equal(fetchedStale, false, "changed-file state should be discarded before polling stale session");
      assert.equal(initUploadId, "upload_fresh");
      assert.equal(existsSync(join(stateDir, "upload_stale.json")), false);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  it("blob put surfaces upload-init gateway errors as structured JSON (GH-186)", async () => {
    const { run } = await import("./cli/lib/assets.mjs");
    const file = join(tempDir, "upload-init-fails.txt");
    writeFileSync(file, "hello");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const info = requestInfo(input, init);
      calls.push(info);
      if (info.path === "/storage/v1/uploads" && info.method === "POST") {
        return Promise.resolve(json({
          error: "Invalid apikey",
          message: "Invalid apikey",
          code: "INVALID_AUTH",
          trace_id: "trc_init",
        }, 401));
      }
      return mockFetch(input, init);
    };
    const err = await expectExit1(() =>
      run("put", [file, "--project", "prj_test123", "--concurrency", "1"]));
    globalThis.fetch = prevFetch;

    assert.equal(err.http, 401);
    assert.equal(err.code, "INVALID_AUTH");
    assert.equal(err.trace_id, "trc_init");
    assert.ok(!/\\\"code\\\"/.test(err.message ?? ""), `message should not contain stringified JSON: ${err.message}`);
  });

  it("functions update validates --memory before network (GH-186)", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const err = await expectExit1(() =>
      run("update", ["prj_test123", "hello", "--memory", "abc"]));

    assert.equal(err.code, "BAD_FLAG");
    assert.match(err.message, /--memory/);
    assert.equal(calls.length, 0, "bad --memory must not hit network");
  });
});

describe("project-id heuristic", () => {
  it("projects info refuses non-prj first positional instead of using active project (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const err = await expectExit1(() => run("info", ["proj-001"]));

    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /proj-001/);
    assert.equal(calls.length, 0);
  });

  it("projects sql keeps one-arg query active-project shorthand but rejects bad-id plus extra query (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");

    captureStart();
    await run("sql", ["SELECT 1"]);
    captureStop();
    assert.equal(calls.some((c) => /\/projects\/v1\/admin\/prj_test123\/sql$/.test(c.path)), true);

    calls = [];
    const err = await expectExit1(() => run("sql", ["badly-typed-id", "DELETE FROM users"]));
    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /badly-typed-id/);
    assert.equal(calls.length, 0);
  });

  it("projects sql refuses a non-prj positional before --file (GH-184)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const sqlFile = join(tempDir, "danger.sql");
    writeFileSync(sqlFile, "SELECT 1");

    const err = await expectExit1(() => run("sql", ["proj-001", "--file", sqlFile]));
    assert.equal(err.code, "BAD_PROJECT_ID");
    assert.match(err.message, /proj-001/);
    assert.equal(calls.length, 0);
  });
});
