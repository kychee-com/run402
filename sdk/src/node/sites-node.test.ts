/**
 * Unit tests for `NodeSites.deployDir` and the internal filesystem walk.
 *
 * The tests build a temp directory, exercise the public `deployDir` method
 * with a mocked kernel client, and assert on both the file-level behavior
 * (walk, ignore list, binary detection, symlink rejection) and the final
 * request shape delegated to the isomorphic `sites.deploy`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSites, normalizeRelPath, collectSiteFiles } from "./sites-node.js";
import { LocalError, Run402Error } from "../errors.js";
import type { Client } from "../kernel.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FakeClient extends Client {
  lastRequest: { path: string; body: unknown } | null;
}

function makeFakeClient(
  respond: (path: string, body: unknown) => unknown = () => ({
    deployment_id: "dpl_test",
    url: "https://dpl.sites.test",
  }),
): FakeClient {
  const client: FakeClient = {
    apiBase: "https://api.example.test",
    lastRequest: null,
    credentials: {
      async getAuth() { return { "SIGN-IN-WITH-X": "test" }; },
      async getProject() { return null; },
    },
    async request<T>(path: string, opts: { body?: unknown }): Promise<T> {
      client.lastRequest = { path, body: opts.body };
      return respond(path, opts.body) as T;
    },
    fetch: globalThis.fetch.bind(globalThis),
  };
  return client;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "run402-deploy-dir-test-"));
}

// ─── Tests: collectSiteFiles (walk logic) ────────────────────────────────────

describe("collectSiteFiles", () => {
  it("walks nested directories and produces POSIX-style relative paths", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      mkdirSync(join(root, "assets", "images"), { recursive: true });
      writeFileSync(join(root, "assets", "style.css"), "body{}");
      writeFileSync(join(root, "assets", "images", "logo.svg"), "<svg/>");

      const files = await collectSiteFiles(root);
      const paths = files.map(f => f.file).sort();
      assert.deepEqual(paths, [
        "assets/images/logo.svg",
        "assets/style.css",
        "index.html",
      ]);
      for (const p of paths) {
        assert.ok(!p.startsWith("/"), `path ${p} must not start with /`);
        assert.ok(!p.startsWith("./"), `path ${p} must not start with ./`);
        assert.ok(!p.includes("\\"), `path ${p} must not contain backslashes`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("encodes UTF-8 text with encoding=utf-8", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<h1>hello</h1>");
      const files = await collectSiteFiles(root);
      assert.equal(files.length, 1);
      assert.equal(files[0].file, "index.html");
      assert.equal(files[0].encoding, "utf-8");
      assert.equal(files[0].data, "<h1>hello</h1>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("base64-encodes binary files that are not valid UTF-8", async () => {
    const root = makeTempDir();
    try {
      // Bytes that are definitely not valid UTF-8 (lone continuation bytes).
      const binary = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x90, 0xa0]);
      writeFileSync(join(root, "logo.png"), binary);
      writeFileSync(join(root, "index.html"), "<html></html>");

      const files = await collectSiteFiles(root);
      const logo = files.find(f => f.file === "logo.png")!;
      const html = files.find(f => f.file === "index.html")!;
      assert.equal(logo.encoding, "base64");
      assert.equal(Buffer.from(logo.data, "base64").equals(binary), true);
      assert.equal(html.encoding, "utf-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips .git, node_modules, and .DS_Store entries at any depth", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      writeFileSync(join(root, ".DS_Store"), "garbage");
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      mkdirSync(join(root, "node_modules", "lodash"), { recursive: true });
      writeFileSync(join(root, "node_modules", "lodash", "index.js"), "module.exports = {}");
      // Nested ignored dir deep inside a legit dir
      mkdirSync(join(root, "assets", "node_modules"), { recursive: true });
      writeFileSync(join(root, "assets", "node_modules", "junk.js"), "junk");
      writeFileSync(join(root, "assets", ".DS_Store"), "garbage");
      writeFileSync(join(root, "assets", "app.css"), "body{}");

      const files = await collectSiteFiles(root);
      const paths = files.map(f => f.file).sort();
      assert.deepEqual(paths, ["assets/app.css", "index.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError when the directory does not exist", async () => {
    const missing = join(tmpdir(), "run402-nope-" + Date.now());
    await assert.rejects(
      () => collectSiteFiles(missing),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        assert.ok(err instanceof Run402Error);
        assert.match((err as Error).message, /cannot read directory/);
        return true;
      },
    );
  });

  it("throws LocalError when the path is not a directory", async () => {
    const root = makeTempDir();
    try {
      const filePath = join(root, "some.txt");
      writeFileSync(filePath, "hello");
      await assert.rejects(
        () => collectSiteFiles(filePath),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match((err as Error).message, /is not a directory/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError when a symlink is found in the tree", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      const target = join(root, "real.txt");
      writeFileSync(target, "hi");
      try {
        symlinkSync(target, join(root, "shortcut"));
      } catch (err) {
        // Some CI filesystems disallow symlinks; skip in that case.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          return; // cannot test symlink behavior here
        }
        throw err;
      }
      await assert.rejects(
        () => collectSiteFiles(root),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match((err as Error).message, /symlink/);
          assert.match((err as Error).message, /shortcut/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Tests: normalizeRelPath ─────────────────────────────────────────────────

describe("normalizeRelPath", () => {
  it("returns POSIX paths unchanged", () => {
    assert.equal(normalizeRelPath("assets/images/logo.png"), "assets/images/logo.png");
    assert.equal(normalizeRelPath("index.html"), "index.html");
  });

  it("converts backslashes to forward slashes when the platform sep is /", () => {
    // On POSIX sep === "/", so inputs without backslashes pass through.
    // This test documents the behavior expected on Windows by probing the
    // branch the function would take with a backslash-containing string.
    // On POSIX, the function returns input unchanged — which is still correct
    // since backslashes are legal filename chars on POSIX and should not be
    // mangled there.
    const posixInput = "nested\\file.txt";
    const result = normalizeRelPath(posixInput);
    // On Windows the function would split on `\\` and join on `/` →
    // "nested/file.txt". On POSIX it keeps the literal backslash. Either is
    // correct for the respective platform. We only assert the POSIX contract.
    if (process.platform === "win32") {
      assert.equal(result, "nested/file.txt");
    } else {
      assert.equal(result, posixInput);
    }
  });
});

// ─── Tests: NodeSites.deployDir (integration with the mocked client) ─────────

describe("NodeSites.deployDir", () => {
  it("assembles a manifest and calls the underlying deploy endpoint", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      writeFileSync(join(root, "style.css"), "body{}");

      const client = makeFakeClient();
      const sites = new NodeSites(client);
      const result = await sites.deployDir({ project: "prj_abc", dir: root });

      assert.equal(result.deployment_id, "dpl_test");
      assert.equal(client.lastRequest?.path, "/deployments/v1");
      const body = client.lastRequest!.body as {
        project: string;
        files: Array<{ file: string; data: string; encoding?: string }>;
        inherit?: boolean;
      };
      assert.equal(body.project, "prj_abc");
      assert.equal(body.files.length, 2);
      const paths = body.files.map(f => f.file).sort();
      assert.deepEqual(paths, ["index.html", "style.css"]);
      assert.equal(body.inherit, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards inherit and target to the underlying deploy call", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");

      const client = makeFakeClient();
      const sites = new NodeSites(client);
      await sites.deployDir({
        project: "prj_abc",
        dir: root,
        inherit: true,
        target: "production",
      });

      const body = client.lastRequest!.body as { inherit?: boolean; target?: string };
      assert.equal(body.inherit, true);
      assert.equal(body.target, "production");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError when the directory is empty after ignore filtering", async () => {
    const root = makeTempDir();
    try {
      // Only ignored entries
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      writeFileSync(join(root, ".DS_Store"), "junk");

      const client = makeFakeClient();
      const sites = new NodeSites(client);
      await assert.rejects(
        () => sites.deployDir({ project: "prj_abc", dir: root }),
        (err: unknown) => {
          assert.ok(err instanceof LocalError);
          assert.match((err as Error).message, /no deployable files/);
          return true;
        },
      );
      assert.equal(client.lastRequest, null, "must not issue a request for empty dirs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError without issuing a request when the dir does not exist", async () => {
    const missing = join(tmpdir(), "run402-nope-" + Date.now());
    const client = makeFakeClient();
    const sites = new NodeSites(client);
    await assert.rejects(
      () => sites.deployDir({ project: "prj_abc", dir: missing }),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        return true;
      },
    );
    assert.equal(client.lastRequest, null, "must not issue a request for missing dirs");
  });
});
