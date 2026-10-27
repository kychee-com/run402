import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("./cli/cli.mjs", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "run402-app-repos-cli-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SERVICE_KEY = "svc_secret_kiwi_123";
const BASE = `${API}/projects/v1/prj_kiwi/app-repos`;
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let calls = [];
let stdout = [];
let stderr = [];
let run;
let credentialTarget;
let parseCredentialInput;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function repo(name) {
  return {
    repo_name: name,
    head: HEAD,
    seq: 2,
    commit_count: 2,
    size_bytes: 512,
    size: "512 B",
    clone_url: `${BASE}/${name}.git`,
    created_at: "2026-10-27T08:00:00.000Z",
    updated_at: "2026-10-27T09:00:00.000Z",
  };
}

const LOG = {
  commits: [{
    commit: HEAD,
    parent: null,
    seq: 2,
    author: { name: "Ada", email: "u_1@users.prj_kiwi.run402.com" },
    committer: { name: "kiwi", email: "prj_kiwi@app-repos.run402.com" },
    message: "Update people/p-x.json\n\nRun402-Actor: u_1",
    committed_at: "2026-10-27T09:00:00.000Z",
    paths: ["people/p-x.json"],
    paths_total: 1,
    actor_user_id: "u_1",
  }],
  head: HEAD,
  has_more: true,
  next_cursor: "cur_2",
};

const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";

async function mockFetch(input, init) {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = ((isRequest ? input.method : init?.method) || "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(isRequest ? input.headers : (init?.headers ?? {})).entries());
  if (!url.startsWith(API)) {
    return json({ jsonrpc: "2.0", id: 1, result: USDC_BALANCE_HEX });
  }
  const rawBody = isRequest ? await input.clone().text() : init?.body;
  const body = rawBody ? JSON.parse(rawBody) : undefined;
  calls.push({ url, method, headers, body });
  if (url === BASE && method === "GET") return json({ app_repos: [repo("default")] });
  if (url === BASE && method === "POST") return json(repo(body.repo_name), 201);
  if (url === `${BASE}/taken` && method === "GET") return json(repo("taken"));
  if (url === `${BASE}/user-42?confirm=user-42` && method === "DELETE") return json({ deleted: true, repo_name: "user-42" });
  if (url === `${BASE}/default?confirm=default` && method === "DELETE") {
    return json({ code: "APP_REPO_DEFAULT_UNDELETABLE", message: "The default app repo cannot be deleted." }, 403);
  }
  if (url.startsWith(`${BASE}/default/commits`) && method === "GET") return json(LOG);
  if (url === `${BASE}/default/files/site.json` || url === `${BASE}/notes/files/site.json?at=${HEAD}`) {
    return new Response('{"title":"Kiwi"}\n', { status: 200, headers: { "content-type": "application/json", etag: '"b1"', "x-run402-commit": HEAD } });
  }
  if (url === `${BASE}/default/files/logo.bin`) {
    return new Response(new Uint8Array([0xff, 0x00, 0xfe]), { status: 200, headers: { "content-type": "application/octet-stream", etag: '"b2"', "x-run402-commit": HEAD } });
  }
  if (url === `${BASE}/default/files/missing.txt`) {
    return json({ code: "APP_REPO_PATH_NOT_FOUND", message: "No file at missing.txt" }, 404);
  }
  if (url.startsWith(`${BASE}/default/tree`) || url.startsWith(`${BASE}/notes/tree`)) {
    return json({ commit: HEAD, path: "people", entries: [{ name: "p-x.json", path: "people/p-x.json", type: "file", size: 20, oid: "b3" }] });
  }
  if (url.startsWith(`${BASE}/nope`)) {
    return json({ code: "APP_REPO_NOT_FOUND", message: "No app repo nope in this project.", next_actions: [{ type: "create_app_repo" }] }, 404);
  }
  return json({ error: `unexpected ${method} ${url}` }, 500);
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

async function runCaptured(sub, args) {
  captureStart();
  let threw = null;
  try {
    await run(sub, args);
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  return { threw, out: stdout.join("\n"), err: stderr.join("\n") };
}

function writeKeystore(dir) {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(join(dir, "credentials", "project-keys.v1.json"), JSON.stringify({
    version: 1,
    source: "local_cache",
    projects: { prj_kiwi: { anon_key: "anon_kiwi", service_key: SERVICE_KEY } },
  }));
}

before(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
  writeKeystore(configDir);
  process.chdir(tempDir);
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run, credentialTarget, parseCredentialInput } = await import("./cli/lib/app-repos.mjs"));
});

after(() => {
  process.chdir(originalCwd);
  captureStop();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
});

describe("run402 app-repos (control plane)", () => {
  it("list prints the project's repos", async () => {
    const { threw, out, err } = await runCaptured("list", ["--project", "prj_kiwi"]);
    assert.equal(threw, null, err);
    assert.equal(calls[0].url, BASE);
    assert.equal(JSON.parse(out).app_repos[0].repo_name, "default");
  });

  it("create POSTs the name and --from", async () => {
    const { threw, out, err } = await runCaptured("create", ["user-42", "--from", "template", "--project", "prj_kiwi"]);
    assert.equal(threw, null, err);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { repo_name: "user-42", from: "template" });
    assert.equal(JSON.parse(out).repo_name, "user-42");
  });

  it("create without a name is BAD_USAGE before any request", async () => {
    const { threw, err } = await runCaptured("create", ["--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/BAD_USAGE/.test(err));
  });

  it("delete needs --confirm naming the repo", async () => {
    const refused = await runCaptured("delete", ["user-42", "--project", "prj_kiwi"]);
    assert.equal(refused.threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/CONFIRMATION_REQUIRED/.test(refused.err));
    const { threw, out } = await runCaptured("delete", ["user-42", "--confirm", "user-42", "--project", "prj_kiwi"]);
    assert.equal(threw, null);
    assert.equal(calls[0].method, "DELETE");
    assert.deepEqual(JSON.parse(out), { deleted: true, repo_name: "user-42" });
  });

  it("delete default surfaces the gateway's refusal", async () => {
    const { threw, err } = await runCaptured("delete", ["default", "--confirm", "default", "--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.ok(/APP_REPO_DEFAULT_UNDELETABLE/.test(err), err);
  });

  it("log defaults to the default repo and passes --path/--cursor/--limit", async () => {
    const { threw, out } = await runCaptured("log", ["--path", "people/p-x.json", "--cursor", "cur_1", "--limit", "5", "--project", "prj_kiwi"]);
    assert.equal(threw, null);
    assert.equal(calls[0].url, `${BASE}/default/commits?path=people%2Fp-x.json&cursor=cur_1&limit=5`);
    const printed = JSON.parse(out);
    assert.equal(printed.commits[0].actor_user_id, "u_1");
    assert.equal(printed.next_cursor, "cur_2");
  });

  it("log rejects a --limit over 100 before any request", async () => {
    const { threw, err } = await runCaptured("log", ["--limit", "500", "--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/BAD_FLAG/.test(err));
  });

  it("cat <path> reads the default repo and prints text", async () => {
    const { threw, out } = await runCaptured("cat", ["site.json", "--project", "prj_kiwi"]);
    assert.equal(threw, null);
    assert.equal(calls[0].url, `${BASE}/default/files/site.json`);
    const printed = JSON.parse(out);
    assert.equal(printed.text, '{"title":"Kiwi"}\n');
    assert.equal(printed.commit, HEAD);
    assert.equal(printed.oid, "b1");
  });

  it("cat <name> <path> --at reads a named repo at a commit", async () => {
    const { threw, out } = await runCaptured("cat", ["notes", "site.json", "--at", HEAD, "--project", "prj_kiwi"]);
    assert.equal(threw, null);
    assert.equal(calls[0].url, `${BASE}/notes/files/site.json?at=${HEAD}`);
    assert.equal(JSON.parse(out).repo_name, "notes");
  });

  it("cat prints base64 for bytes that are not UTF-8", async () => {
    const { threw, out } = await runCaptured("cat", ["logo.bin", "--project", "prj_kiwi"]);
    assert.equal(threw, null);
    const printed = JSON.parse(out);
    assert.equal(printed.encoding, "base64");
    assert.equal(printed.base64, "/wD+");
    assert.equal(printed.text, undefined);
  });

  it("cat of a missing file is APP_REPO_PATH_NOT_FOUND, exit 1", async () => {
    const { threw, out, err } = await runCaptured("cat", ["missing.txt", "--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(out, "");
    assert.ok(/APP_REPO_PATH_NOT_FOUND/.test(err));
  });

  it("ls <name> <dir> lists a directory; --repo and --path are the flag forms", async () => {
    const a = await runCaptured("ls", ["default", "people", "--project", "prj_kiwi"]);
    assert.equal(a.threw, null);
    const b = await runCaptured("ls", ["--repo", "notes", "--path", "people", "--at", HEAD, "--project", "prj_kiwi"]);
    assert.equal(b.threw, null);
    assert.deepEqual(calls.map((c) => c.url), [`${BASE}/default/tree/people`, `${BASE}/notes/tree/people?at=${HEAD}`]);
    assert.equal(JSON.parse(a.out).entries[0].type, "file");
  });

  it("a missing repo surfaces APP_REPO_NOT_FOUND with its next action", async () => {
    const { threw, err } = await runCaptured("log", ["nope", "--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.ok(/APP_REPO_NOT_FOUND/.test(err));
    assert.ok(/create_app_repo/.test(err));
  });

  it("an unknown subcommand is UNKNOWN_SUBCOMMAND naming the verbs", async () => {
    const { threw, err } = await runCaptured("lst", ["--project", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    const envelope = JSON.parse(err.split("\n").find((line) => line.startsWith("{")));
    assert.equal(envelope.code, "UNKNOWN_SUBCOMMAND");
    assert.deepEqual(envelope.details.known_subcommands, ["cat", "clone", "create", "delete", "list", "log", "ls"]);
  });

  it("rejects an unknown flag before calling the gateway", async () => {
    const { threw, err } = await runCaptured("list", ["--projct", "prj_kiwi"]);
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(calls.length, 0);
    assert.ok(/UNKNOWN_FLAG/.test(err));
  });
});

describe("run402 app-repos credential (pure parsing)", () => {
  it("parses git's key=value lines up to the blank line", () => {
    assert.deepEqual(parseCredentialInput("protocol=https\nhost=api.run402.com\npath=a/b\n\nignored=1\n"), {
      protocol: "https", host: "api.run402.com", path: "a/b",
    });
  });

  it("matches only app-repo paths on the configured API base", () => {
    const base = "https://api.run402.com";
    assert.deepEqual(
      credentialTarget({ protocol: "https", host: "api.run402.com", path: "projects/v1/prj_kiwi/app-repos/default.git" }, base),
      { projectId: "prj_kiwi", repoName: "default" },
    );
    assert.deepEqual(
      credentialTarget({ protocol: "https", host: "api.run402.com", path: "projects/v1/prj_kiwi/app-repos/user-42.git/info/refs" }, base),
      { projectId: "prj_kiwi", repoName: "user-42" },
    );
    assert.equal(credentialTarget({ protocol: "https", host: "github.com", path: "projects/v1/prj_kiwi/app-repos/default.git" }, base), null);
    assert.equal(credentialTarget({ protocol: "http", host: "api.run402.com", path: "projects/v1/prj_kiwi/app-repos/default.git" }, base), null);
    assert.equal(credentialTarget({ protocol: "https", host: "api.run402.com", path: "vaults/v1/x" }, base), null);
    assert.equal(credentialTarget({ protocol: "https", host: "api.run402.com" }, base), null);
    assert.deepEqual(
      credentialTarget({ protocol: "http", host: "127.0.0.1:4022", path: "projects/v1/prj_a/app-repos/default.git" }, "http://127.0.0.1:4022"),
      { projectId: "prj_a", repoName: "default" },
    );
  });
});

// ── Subprocess: the helper as git runs it, and clone with a stand-in git ────

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function runCli(argv, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

describe("run402 app-repos credential (git's credential-helper protocol)", () => {
  let server;
  let apiBase;
  let subConfig;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/projects/v1/prj_kiwi/app-repos/default") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(repo("default")));
        return;
      }
      res.statusCode = 500;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    apiBase = `http://127.0.0.1:${server.address().port}`;
    subConfig = mkdtempSync(join(tmpdir(), "run402-app-repos-sub-"));
    writeFileSync(join(subConfig, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
    writeKeystore(subConfig);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(subConfig, { recursive: true, force: true });
  });

  function subEnv(extra = {}) {
    return { RUN402_CONFIG_DIR: subConfig, RUN402_API_BASE: apiBase, HOME: subConfig, RUN402_GRANT_KEY: "", ...extra };
  }

  it("get prints the project's service key for its app-repo URL, and nothing else", async () => {
    const host = new URL(apiBase).host;
    const { code, out, err } = await runCli(["app-repos", "credential", "get"], {
      env: subEnv(),
      input: `protocol=http\nhost=${host}\npath=projects/v1/prj_kiwi/app-repos/default.git\n\n`,
    });
    assert.equal(code, 0, err);
    assert.equal(out, `username=run402\npassword=${SERVICE_KEY}\n`);
    assert.ok(!err.includes(SERVICE_KEY));
  });

  it("get prefers RUN402_GRANT_KEY when it is set", async () => {
    const host = new URL(apiBase).host;
    const { code, out } = await runCli(["app-repos", "credential", "get"], {
      env: subEnv({ RUN402_GRANT_KEY: "gk_live_abc" }),
      input: `protocol=http\nhost=${host}\npath=projects/v1/prj_kiwi/app-repos/default.git\n\n`,
    });
    assert.equal(code, 0);
    assert.equal(out, "username=run402\npassword=gk_live_abc\n");
  });

  it("get prints nothing for another host, or a project with no key here", async () => {
    const other = await runCli(["app-repos", "credential", "get"], {
      env: subEnv(),
      input: "protocol=https\nhost=github.com\npath=projects/v1/prj_kiwi/app-repos/default.git\n\n",
    });
    assert.equal(other.code, 0);
    assert.equal(other.out, "");
    const host = new URL(apiBase).host;
    const unknown = await runCli(["app-repos", "credential", "get"], {
      env: subEnv(),
      input: `protocol=http\nhost=${host}\npath=projects/v1/prj_other/app-repos/default.git\n\n`,
    });
    assert.equal(unknown.code, 0);
    assert.equal(unknown.out, "");
    assert.ok(/no key for project prj_other/.test(unknown.err));
  });

  it("store and erase are no-ops", async () => {
    for (const op of ["store", "erase"]) {
      const { code, out } = await runCli(["app-repos", "credential", op], { env: subEnv(), input: "protocol=https\nhost=x\npassword=y\n\n" });
      assert.equal(code, 0);
      assert.equal(out, "");
    }
  });

  it("git credential fill reaches the key through the URL-scoped helper", { skip: !gitAvailable && "git is not installed" }, () => {
    const url = `${apiBase}/projects/v1/prj_kiwi/app-repos/default.git`;
    const helper = `!"${process.execPath}" "${CLI_PATH}" app-repos credential`;
    const result = spawnSync("git", [
      "-c", `credential.${url}.helper=`,
      "-c", `credential.${url}.helper=${helper}`,
      "-c", `credential.${url}.useHttpPath=true`,
      "credential", "fill",
    ], {
      input: `url=${url}\n\n`,
      encoding: "utf8",
      cwd: subConfig,
      env: { ...process.env, ...subEnv(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`password=${SERVICE_KEY}`));
  });

  it("clone runs git with the helper scoped to the repo URL and no secret in the URL", async () => {
    const bin = mkdtempSync(join(tmpdir(), "run402-fake-git-"));
    const record = join(bin, "args.json");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("git version 2.45.0"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
fs.mkdirSync(args[args.length - 1], { recursive: true });
`);
    chmodSync(join(bin, "git"), 0o755);
    const dest = join(bin, "content");
    try {
      const { code, out, err } = await runCli(["app-repos", "clone", "default", dest, "--project", "prj_kiwi"], {
        env: subEnv({ PATH: `${bin}${delimiter}${process.env.PATH}` }),
      });
      assert.equal(code, 0, err);
      const printed = JSON.parse(out);
      const url = `${apiBase}/projects/v1/prj_kiwi/app-repos/default.git`;
      assert.equal(printed.clone_url, url);
      assert.equal(printed.dir, dest);
      const args = JSON.parse(readFileSync(record, "utf8"));
      assert.equal(args[0], "clone");
      assert.deepEqual(args.slice(-2), [url, dest]);
      assert.ok(args.includes(`credential.${url}.helper=`), JSON.stringify(args));
      assert.ok(args.some((a) => a.startsWith(`credential.${url}.helper=!`) && a.endsWith("app-repos credential")), JSON.stringify(args));
      assert.ok(args.includes(`credential.${url}.useHttpPath=true`));
      assert.ok(!JSON.stringify(args).includes(SERVICE_KEY));
      assert.ok(!out.includes(SERVICE_KEY) && !err.includes(SERVICE_KEY));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  // The helper must run the CLI that ran the clone: a stale global run402
  // without app-repos would answer git with "Unknown command".
  async function cloneHelperWith(run402OnPath) {
    const bin = mkdtempSync(join(tmpdir(), "run402-fake-git-"));
    const record = join(bin, "args.json");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("git version 2.45.0"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
fs.mkdirSync(args[args.length - 1], { recursive: true });
`);
    chmodSync(join(bin, "git"), 0o755);
    run402OnPath(join(bin, "run402"));
    try {
      const { code, out, err } = await runCli(["app-repos", "clone", "default", join(bin, "content"), "--project", "prj_kiwi"], {
        env: subEnv({ PATH: `${bin}${delimiter}${process.env.PATH}` }),
      });
      assert.equal(code, 0, err);
      const url = `${apiBase}/projects/v1/prj_kiwi/app-repos/default.git`;
      const helper = JSON.parse(readFileSync(record, "utf8")).find((a) => a.startsWith(`credential.${url}.helper=!`));
      return { helper, printed: JSON.parse(out) };
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it("clone's helper runs this CLI, not a different run402 on PATH", async () => {
    const { helper, printed } = await cloneHelperWith((path) => {
      writeFileSync(path, "#!/bin/sh\necho stale\n");
      chmodSync(path, 0o755);
    });
    assert.ok(helper.includes(CLI_PATH), helper);
    assert.ok(!/[! ]run402 app-repos credential$/.test(helper), helper);
    assert.equal(printed.next_actions?.[0]?.type, "install_cli");
  });

  it("clone's helper names run402 when run402 on PATH is this CLI", async () => {
    const { helper, printed } = await cloneHelperWith((path) => symlinkSync(CLI_PATH, path));
    assert.ok(/[! ]run402 app-repos credential$/.test(helper), helper);
    assert.ok(!helper.includes(CLI_PATH), helper);
    assert.equal(printed.next_actions, undefined);
  });

  it("clone refuses an existing destination before running git", async () => {
    const { code, err } = await runCli(["app-repos", "clone", "default", subConfig, "--project", "prj_kiwi"], { env: subEnv() });
    assert.equal(code, 1);
    assert.ok(/already exists/.test(err));
    assert.ok(existsSync(subConfig));
  });
});
