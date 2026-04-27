/**
 * Unit tests for `NodeSites.deployDir` over the v1.32 plan/commit transport.
 *
 * The tests build a temp directory, run `deployDir` against a fake `Client`
 * that records each `request` (plan, commit, getDeployment) and a fake
 * `fetch` that records each S3 PUT. Together they cover:
 *
 *   - manifest digest is computed via the gateway-compatible canonicalize
 *   - `present: true` and `satisfied_by_plan: true` skip the upload
 *   - `missing` entries trigger a single-PUT with the correct
 *     `x-amz-checksum-sha256` header
 *   - `status: "copying"` triggers the poll loop
 *   - LocalError is raised for the same edge cases as before (missing dir,
 *     symlinks, empty after ignore)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { NodeSites, normalizeRelPath, _collectFilesForTest, type DeployEvent } from "./sites-node.js";
import { LocalError, Run402Error, ApiError } from "../errors.js";
import { computeManifestDigest, buildCanonicalManifest } from "./canonicalize.js";
import type { Client } from "../kernel.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shaHex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function shaBase64(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("base64");
}

interface RecordedRequest {
  path: string;
  method?: string;
  body?: unknown;
}
interface RecordedPut {
  url: string;
  body: Uint8Array;
  checksum: string | null;
}

interface FakeWiring {
  client: Client;
  requests: RecordedRequest[];
  puts: RecordedPut[];
  /** Override what `request(path, opts)` returns. Default: handle plan/commit/getDeployment shapes. */
  setHandler(fn: (req: RecordedRequest) => unknown): void;
  /** Override what `fetch(url, init)` returns for S3 PUTs. Default: 200 OK. */
  setS3Handler(fn: (url: string, body: Uint8Array, checksum: string | null) => Response): void;
}

function makeWiring(): FakeWiring {
  const requests: RecordedRequest[] = [];
  const puts: RecordedPut[] = [];

  let handler: (req: RecordedRequest) => unknown = () => {
    throw new Error("test did not install a request handler");
  };
  let s3Handler: (url: string, body: Uint8Array, checksum: string | null) => Response = () =>
    new Response(null, { status: 200 });

  const fetchFn: typeof globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = new Headers(init?.headers ?? undefined);
    const checksum = headers.get("x-amz-checksum-sha256");
    const body = init?.body as Uint8Array;
    puts.push({ url, body, checksum });
    return s3Handler(url, body, checksum);
  }) as typeof globalThis.fetch;

  const client: Client = {
    apiBase: "https://api.example.test",
    credentials: {
      async getAuth() { return { "SIGN-IN-WITH-X": "test" }; },
      async getProject() { return null; },
    },
    async request<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
      const req: RecordedRequest = { path, method: opts.method, body: opts.body };
      requests.push(req);
      return handler(req) as T;
    },
    getProject() { return Promise.resolve(null); },
    fetch: fetchFn,
  };

  return {
    client,
    requests,
    puts,
    setHandler(fn) { handler = fn; },
    setS3Handler(fn) { s3Handler = fn; },
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "run402-deploy-dir-test-"));
}

// ─── Walk + hash logic ────────────────────────────────────────────────────────

describe("collectFiles (walk + hash)", () => {
  it("walks nested directories with POSIX paths and per-file sha256", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "assets", "style.css"), "body{}");

      const files = await _collectFilesForTest(root);
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      assert.deepEqual(Object.keys(byPath).sort(), ["assets/style.css", "index.html"]);
      assert.equal(byPath["index.html"].sha256, shaHex("<html></html>"));
      assert.equal(byPath["index.html"].size, "<html></html>".length);
      assert.equal(byPath["index.html"].content_type, "text/html; charset=utf-8");
      assert.equal(byPath["assets/style.css"].content_type, "text/css; charset=utf-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes binary files identically to their byte sha256", async () => {
    const root = makeTempDir();
    try {
      const binary = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x90, 0xa0]);
      writeFileSync(join(root, "logo.png"), binary);
      const files = await _collectFilesForTest(root);
      assert.equal(files.length, 1);
      assert.equal(files[0].sha256, shaHex(binary));
      assert.equal(files[0].content_type, "image/png");
      assert.equal(files[0].size, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips .git, node_modules, and .DS_Store at any depth", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");
      writeFileSync(join(root, ".DS_Store"), "garbage");
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      mkdirSync(join(root, "node_modules", "lodash"), { recursive: true });
      writeFileSync(join(root, "node_modules", "lodash", "index.js"), "module.exports={}");
      mkdirSync(join(root, "assets", "node_modules"), { recursive: true });
      writeFileSync(join(root, "assets", "node_modules", "junk.js"), "junk");
      writeFileSync(join(root, "assets", ".DS_Store"), "garbage");
      writeFileSync(join(root, "assets", "app.css"), "body{}");

      const paths = (await _collectFilesForTest(root)).map((f) => f.path).sort();
      assert.deepEqual(paths, ["assets/app.css", "index.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError when the directory does not exist", async () => {
    const missing = join(tmpdir(), "run402-nope-" + Date.now());
    await assert.rejects(
      () => _collectFilesForTest(missing),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        assert.ok(err instanceof Run402Error);
        assert.match((err as Error).message, /cannot read directory/);
        return true;
      },
    );
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
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") return;
        throw err;
      }
      await assert.rejects(
        () => _collectFilesForTest(root),
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

describe("normalizeRelPath", () => {
  it("returns POSIX paths unchanged on POSIX", () => {
    assert.equal(normalizeRelPath("assets/images/logo.png"), "assets/images/logo.png");
  });
});

// ─── deployDir: plan + commit happy paths ────────────────────────────────────

describe("NodeSites.deployDir — plan/commit transport", () => {
  it("plans with the correct manifest_digest, uploads missing files, commits", async () => {
    const root = makeTempDir();
    try {
      const indexHtml = "<html><body>hi</body></html>";
      const styleCss = "body{color:red}";
      writeFileSync(join(root, "index.html"), indexHtml);
      writeFileSync(join(root, "style.css"), styleCss);

      const indexSha = shaHex(indexHtml);
      const styleSha = shaHex(styleCss);

      const expectedDigest = await computeManifestDigest(
        buildCanonicalManifest([
          { path: "index.html", sha256: indexSha, size: indexHtml.length, content_type: "text/html; charset=utf-8" },
          { path: "style.css", sha256: styleSha, size: styleCss.length, content_type: "text/css; charset=utf-8" },
        ]),
      );

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          const body = req.body as { project: string; manifest_digest: string; manifest: { files: Array<{ path: string }> } };
          assert.equal(body.project, "prj_abc");
          assert.equal(body.manifest_digest, expectedDigest);
          // Manifest must be sorted by path.
          assert.deepEqual(body.manifest.files.map((f) => f.path), ["index.html", "style.css"]);
          return {
            plan_id: "plan_001",
            files: [
              {
                sha256: indexSha,
                missing: true,
                upload_id: "u1",
                mode: "single",
                key: "cas/index",
                staging_key: "_staging/plan_001/" + indexSha,
                part_size_bytes: indexHtml.length,
                part_count: 1,
                parts: [{ part_number: 1, url: "https://s3.example/cas/index?sig=1", byte_start: 0, byte_end: indexHtml.length - 1 }],
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
              {
                // already on the project — no upload needed
                sha256: styleSha,
                present: true,
                size: styleCss.length,
                content_type: "text/css; charset=utf-8",
              },
            ],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          assert.deepEqual(req.body, { project: "prj_abc", plan_id: "plan_001" });
          return {
            deployment_id: "dpl_xyz",
            url: "https://dpl-xyz.sites.run402.com",
            status: "applied",
            bytes_total: indexHtml.length + styleCss.length,
            bytes_uploaded: indexHtml.length,
          };
        }
        throw new Error(`unexpected request to ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      const result = await sites.deployDir({ project: "prj_abc", dir: root });

      assert.equal(result.deployment_id, "dpl_xyz");
      assert.equal(result.url, "https://dpl-xyz.sites.run402.com");
      assert.equal(result.bytes_total, indexHtml.length + styleCss.length);
      assert.equal(result.bytes_uploaded, indexHtml.length);

      // Exactly one S3 PUT — the missing file.
      assert.equal(wiring.puts.length, 1);
      const put = wiring.puts[0];
      assert.equal(put.url, "https://s3.example/cas/index?sig=1");
      assert.equal(Buffer.from(put.body).toString("utf-8"), indexHtml);
      // Single-PUT must carry the whole-object SHA in base64.
      assert.equal(put.checksum, shaBase64(indexHtml));

      // Plan + commit, no extra calls.
      const paths = wiring.requests.map((r) => r.path);
      assert.deepEqual(paths, ["/deploy/v1/plan", "/deploy/v1/commit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats satisfied_by_plan: true the same as present: true (no upload)", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html>x</html>");
      writeFileSync(join(root, "extra.txt"), "y");

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          const body = req.body as { manifest: { files: Array<{ sha256: string }> } };
          return {
            plan_id: "plan_002",
            files: body.manifest.files.map((f) => ({
              sha256: f.sha256,
              satisfied_by_plan: true as const,
              size: 0,
              content_type: "text/html; charset=utf-8",
            })),
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_a", url: "https://dpl-a.sites.run402.com", status: "noop" };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      const r = await sites.deployDir({ project: "prj_x", dir: root });
      assert.equal(r.deployment_id, "dpl_a");
      assert.equal(wiring.puts.length, 0, "no S3 PUTs when every file is satisfied_by_plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("polls /deployments/v1/:id until ready when commit returns copying", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");

      let pollCount = 0;
      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          // No missing files — keep the test focused on commit poll behavior.
          return {
            plan_id: "plan_p",
            files: [{
              sha256: shaHex("<html></html>"),
              present: true,
              size: 13,
              content_type: "text/html; charset=utf-8",
            }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_p", url: "https://dpl-p.sites.run402.com", status: "copying" };
        }
        if (req.path === "/deployments/v1/dpl_p") {
          pollCount++;
          if (pollCount < 2) {
            return { id: "dpl_p", name: "dpl_p", url: "https://dpl-p.sites.run402.com", status: "copying", files_count: 1, total_size: 13 };
          }
          return { id: "dpl_p", name: "dpl_p", url: "https://dpl-p.sites.run402.com", status: "ready", files_count: 1, total_size: 13 };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      const r = await sites.deployDir({ project: "prj_p", dir: root });
      assert.equal(r.deployment_id, "dpl_p");
      assert.equal(r.url, "https://dpl-p.sites.run402.com");
      assert.ok(pollCount >= 2, "should have polled at least twice before ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws ApiError if the polled deployment ends in failed state", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_f",
            files: [{ sha256: shaHex("<html></html>"), present: true, size: 13, content_type: "text/html; charset=utf-8" }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_f", url: "https://dpl-f.sites.run402.com", status: "copying" };
        }
        if (req.path === "/deployments/v1/dpl_f") {
          return { id: "dpl_f", name: "dpl_f", url: "https://dpl-f.sites.run402.com", status: "failed", files_count: 1, total_size: 13 };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      await assert.rejects(
        () => sites.deployDir({ project: "prj_f", dir: root }),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.match((err as Error).message, /failed state/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws ApiError directly when commit returns failed", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_x",
            files: [{ sha256: shaHex("<html></html>"), present: true, size: 13, content_type: "text/html; charset=utf-8" }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_x", url: "https://dpl-x.sites.run402.com", status: "failed" };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      await assert.rejects(
        () => sites.deployDir({ project: "prj_x", dir: root }),
        (err: unknown) => err instanceof ApiError && /commit failed/i.test((err as Error).message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-plans once and retries the upload when S3 returns 403 (URL expired)", async () => {
    const root = makeTempDir();
    try {
      const html = "<html>retry</html>";
      writeFileSync(join(root, "index.html"), html);
      const sha = shaHex(html);

      let planCalls = 0;
      let putCalls = 0;
      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          planCalls++;
          const url = planCalls === 1
            ? "https://s3.example/cas/x?sig=stale"
            : "https://s3.example/cas/x?sig=fresh";
          return {
            plan_id: "plan_r",
            files: [{
              sha256: sha,
              missing: true,
              upload_id: "u1",
              mode: "single",
              key: "cas/x",
              staging_key: "_staging/plan_r/" + sha,
              part_size_bytes: html.length,
              part_count: 1,
              parts: [{ part_number: 1, url, byte_start: 0, byte_end: html.length - 1 }],
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_r", url: "https://dpl-r.sites.run402.com", status: "applied" };
        }
        throw new Error(`unexpected ${req.path}`);
      });
      wiring.setS3Handler((url) => {
        putCalls++;
        if (url.includes("sig=stale")) return new Response("expired", { status: 403 });
        return new Response(null, { status: 200 });
      });

      const sites = new NodeSites(wiring.client);
      const r = await sites.deployDir({ project: "prj_r", dir: root });
      assert.equal(r.deployment_id, "dpl_r");
      assert.equal(planCalls, 2, "should have re-planned after the 403");
      assert.equal(putCalls, 2, "should have retried the PUT against the fresh URL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError without issuing a request when the dir is empty after ignore", async () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      writeFileSync(join(root, ".DS_Store"), "junk");

      const wiring = makeWiring();
      const sites = new NodeSites(wiring.client);
      await assert.rejects(
        () => sites.deployDir({ project: "prj_e", dir: root }),
        (err: unknown) => err instanceof LocalError && /no deployable files/.test((err as Error).message),
      );
      assert.equal(wiring.requests.length, 0);
      assert.equal(wiring.puts.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError without issuing a request when the dir does not exist", async () => {
    const missing = join(tmpdir(), "run402-nope-" + Date.now());
    const wiring = makeWiring();
    const sites = new NodeSites(wiring.client);
    await assert.rejects(
      () => sites.deployDir({ project: "prj_m", dir: missing }),
      (err: unknown) => err instanceof LocalError,
    );
    assert.equal(wiring.requests.length, 0);
    assert.equal(wiring.puts.length, 0);
  });
});

// ─── deployDir: progress events via onEvent ──────────────────────────────────

describe("NodeSites.deployDir — onEvent progress events", () => {
  it("emits plan, upload, commit events in order with correct counters", async () => {
    const root = makeTempDir();
    try {
      const indexHtml = "<html>idx</html>";
      const aboutHtml = "<html>abt</html>";
      const presentTxt = "shared";
      writeFileSync(join(root, "index.html"), indexHtml);
      writeFileSync(join(root, "about.html"), aboutHtml);
      writeFileSync(join(root, "present.txt"), presentTxt);

      const indexSha = shaHex(indexHtml);
      const aboutSha = shaHex(aboutHtml);
      const presentSha = shaHex(presentTxt);

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_e",
            files: [
              {
                sha256: indexSha,
                missing: true,
                upload_id: "u-idx",
                mode: "single",
                key: "cas/idx",
                staging_key: "_staging/plan_e/" + indexSha,
                part_size_bytes: indexHtml.length,
                part_count: 1,
                parts: [{ part_number: 1, url: "https://s3.example/idx?sig=1", byte_start: 0, byte_end: indexHtml.length - 1 }],
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
              {
                sha256: aboutSha,
                missing: true,
                upload_id: "u-abt",
                mode: "single",
                key: "cas/abt",
                staging_key: "_staging/plan_e/" + aboutSha,
                part_size_bytes: aboutHtml.length,
                part_count: 1,
                parts: [{ part_number: 1, url: "https://s3.example/abt?sig=1", byte_start: 0, byte_end: aboutHtml.length - 1 }],
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
              {
                sha256: presentSha,
                present: true,
                size: presentTxt.length,
                content_type: "text/plain; charset=utf-8",
              },
            ],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_e", url: "https://dpl-e.sites.run402.com", status: "applied" };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const events: DeployEvent[] = [];
      const sites = new NodeSites(wiring.client);
      await sites.deployDir({
        project: "prj_e",
        dir: root,
        onEvent: (e) => events.push(e),
      });

      // plan once, then upload×2, then commit. Order matters.
      const phases = events.map((e) => e.phase);
      assert.deepEqual(phases, ["plan", "upload", "upload", "commit"]);

      const plan = events[0];
      assert.equal(plan.phase, "plan");
      if (plan.phase === "plan") {
        assert.equal(plan.manifest_size, 3, "manifest_size = total files in manifest, not just missing");
      }

      const up1 = events[1];
      const up2 = events[2];
      assert.equal(up1.phase, "upload");
      assert.equal(up2.phase, "upload");
      if (up1.phase === "upload" && up2.phase === "upload") {
        // total = 2 (only missing entries trigger upload events)
        assert.equal(up1.total, 2);
        assert.equal(up2.total, 2);
        // done counter increments 1, 2
        assert.equal(up1.done, 1);
        assert.equal(up2.done, 2);
        // file paths come from the local manifest, not the plan response
        assert.ok(["index.html", "about.html"].includes(up1.file));
        assert.ok(["index.html", "about.html"].includes(up2.file));
        // sha256 round-trips
        assert.ok([indexSha, aboutSha].includes(up1.sha256));
      }

      // No upload event for the present.txt entry
      const uploadFiles = events.filter((e) => e.phase === "upload").map((e) => (e as { file: string }).file);
      assert.ok(!uploadFiles.includes("present.txt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits poll events with monotonically increasing elapsed_ms when commit returns copying", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html></html>");

      let pollCount = 0;
      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_pp",
            files: [{
              sha256: shaHex("<html></html>"),
              present: true,
              size: 13,
              content_type: "text/html; charset=utf-8",
            }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_pp", url: "https://dpl-pp.sites.run402.com", status: "copying" };
        }
        if (req.path === "/deployments/v1/dpl_pp") {
          pollCount++;
          if (pollCount < 3) {
            return { id: "dpl_pp", name: "dpl_pp", url: "https://dpl-pp.sites.run402.com", status: "copying", files_count: 1, total_size: 13 };
          }
          return { id: "dpl_pp", name: "dpl_pp", url: "https://dpl-pp.sites.run402.com", status: "ready", files_count: 1, total_size: 13 };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const events: DeployEvent[] = [];
      const sites = new NodeSites(wiring.client);
      await sites.deployDir({
        project: "prj_pp",
        dir: root,
        onEvent: (e) => events.push(e),
      });

      const polls = events.filter((e) => e.phase === "poll") as Array<Extract<DeployEvent, { phase: "poll" }>>;
      assert.ok(polls.length >= 3, `expected at least 3 poll events, got ${polls.length}`);
      // Last poll should report the final ready status.
      assert.equal(polls[polls.length - 1].status, "ready");
      // First two polls should report copying.
      assert.equal(polls[0].status, "copying");
      // elapsed_ms is monotonic non-decreasing.
      for (let i = 1; i < polls.length; i++) {
        assert.ok(polls[i].elapsed_ms >= polls[i - 1].elapsed_ms);
      }
      // commit event fires before any poll event.
      const commitIdx = events.findIndex((e) => e.phase === "commit");
      const firstPollIdx = events.findIndex((e) => e.phase === "poll");
      assert.ok(commitIdx >= 0 && commitIdx < firstPollIdx);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a callback that throws does not abort the deploy or skip subsequent events", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html>x</html>");
      const sha = shaHex("<html>x</html>");

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_t",
            files: [{
              sha256: sha,
              missing: true,
              upload_id: "u",
              mode: "single",
              key: "cas/x",
              staging_key: "_staging/plan_t/" + sha,
              part_size_bytes: "<html>x</html>".length,
              part_count: 1,
              parts: [{ part_number: 1, url: "https://s3.example/x?sig=1", byte_start: 0, byte_end: "<html>x</html>".length - 1 }],
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_t", url: "https://dpl-t.sites.run402.com", status: "applied" };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      let invocations = 0;
      const sites = new NodeSites(wiring.client);
      const result = await sites.deployDir({
        project: "prj_t",
        dir: root,
        onEvent: () => {
          invocations++;
          throw new Error("intentional");
        },
      });

      assert.equal(result.deployment_id, "dpl_t");
      // Each phase still attempts the callback (plan + 1 upload + commit = 3).
      assert.equal(invocations, 3, "every event still invokes the callback even after a throw");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits no events when onEvent is omitted", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "index.html"), "<html>n</html>");

      const wiring = makeWiring();
      wiring.setHandler((req) => {
        if (req.path === "/deploy/v1/plan") {
          return {
            plan_id: "plan_n",
            files: [{
              sha256: shaHex("<html>n</html>"),
              present: true,
              size: 14,
              content_type: "text/html; charset=utf-8",
            }],
          };
        }
        if (req.path === "/deploy/v1/commit") {
          return { deployment_id: "dpl_n", url: "https://dpl-n.sites.run402.com", status: "applied" };
        }
        throw new Error(`unexpected ${req.path}`);
      });

      const sites = new NodeSites(wiring.client);
      // No onEvent — just confirm it returns successfully and the request
      // sequence is unchanged from the legacy test (plan + commit, no extras).
      const r = await sites.deployDir({ project: "prj_n", dir: root });
      assert.equal(r.deployment_id, "dpl_n");
      assert.deepEqual(wiring.requests.map((q) => q.path), ["/deploy/v1/plan", "/deploy/v1/commit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
