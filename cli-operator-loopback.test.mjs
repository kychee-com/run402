// Regression test for the `operator login --loopback` hang: after a successful
// loopback-PKCE login the CLI must EXIT, not linger on the 127.0.0.1 server's
// keep-alive socket. We spawn the real CLI against a mock gateway, drive the
// loopback callback ourselves, and assert the process exits within a timeout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("operator login --loopback exits after a successful login (no hang)", async () => {
  // Mock gateway: token exchange returns a control-plane session; everything
  // else (incl. the best-effort whoami) returns a benign JSON object.
  const gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/control-plane/cli/token")) {
        res.end(JSON.stringify({
          control_plane_session_token: "cps_test",
          token_type: "Bearer",
          expires_in: 1800,
          provenance: "loopback_pkce",
          principal_id: "prn_test",
          amr: [],
        }));
      } else {
        res.end("{}");
      }
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${gateway.address().port}`;
  const configDir = mkdtempSync(join(tmpdir(), "run402-loopback-"));

  const child = spawn(
    process.execPath,
    ["cli/cli.mjs", "operator", "login", "--loopback", "--no-open"],
    {
      cwd: __dirname,
      env: { ...process.env, RUN402_API_BASE: apiBase, RUN402_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let hit = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (hit) return;
    const redir = stderr.match(/redirect_uri=([^&\s]+)/);
    const state = stderr.match(/[?&]state=([^&\s]+)/);
    if (redir && state) {
      hit = true;
      const cbUrl = `${decodeURIComponent(redir[1])}?code=testcode&state=${state[1]}`;
      get(cbUrl, (r) => r.resume()).on("error", () => {});
    }
  });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI hung — did not exit within 10s after a successful loopback login"));
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  gateway.close();
  rmSync(configDir, { recursive: true, force: true });
  assert.equal(exitCode, 0, `operator login --loopback should exit 0; got ${exitCode}. stderr:\n${stderr}`);
});
