/**
 * MCP Server E2E Test
 *
 * Spawns the MCP server as a child process, sends JSON-RPC messages over stdin,
 * and verifies responses on stdout.
 *
 * Usage:
 *   npx tsx test/mcp-e2e.ts
 *   BASE_URL=https://api.run402.com npx tsx test/mcp-e2e.ts
 */
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = process.env.BASE_URL || "https://api.run402.com";

let proc: ChildProcess;
let buffer = "";
let messageId = 0;
let tempDir: string;

function nextId(): number {
  return ++messageId;
}

function send(msg: Record<string, unknown>): void {
  const json = JSON.stringify({ jsonrpc: "2.0", ...msg });
  proc.stdin!.write(json + "\n");
}

function waitForResponse(id: number, timeoutMs = 15000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for response id=${id}`)),
      timeoutMs,
    );

    function check() {
      // Try to parse complete JSON objects from buffer
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timer);
            // Remove processed line from buffer
            lines.splice(i, 1);
            buffer = lines.join("\n");
            proc.stdout!.removeListener("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // Not valid JSON yet, wait for more data
        }
      }
    }

    function onData(data: Buffer) {
      buffer += data.toString();
      check();
    }

    proc.stdout!.on("data", onData);
    // Check existing buffer first
    check();
  });
}

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  PASS: ${msg}`);
}

async function main() {
  tempDir = mkdtempSync(join(tmpdir(), "run402-mcp-e2e-"));
  console.log(`\nMCP E2E Test — server at ${BASE_URL}\n`);
  console.log(`Temp dir: ${tempDir}\n`);

  // Start MCP server
  proc = spawn("node", ["--import", "tsx", "packages/mcp/src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      RUN402_API_BASE: BASE_URL,
      RUN402_CONFIG_DIR: tempDir,
    },
  });

  proc.stderr!.on("data", (data) => {
    // Log stderr but don't fail (SDK may log warnings)
    const msg = data.toString().trim();
    if (msg) console.error(`  [stderr] ${msg}`);
  });

  // Give server time to start
  await new Promise((r) => setTimeout(r, 1000));

  try {
    // 1. Initialize handshake
    console.log("1. MCP Initialize");
    const initId = nextId();
    send({
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-e2e-test", version: "1.0.0" },
      },
    });
    const initRes = await waitForResponse(initId);
    assert(
      (initRes.result as Record<string, unknown>).protocolVersion !== undefined,
      "Initialize returns protocolVersion",
    );

    // Send initialized notification (required by protocol)
    send({ method: "notifications/initialized" });

    // 2. List tools
    console.log("\n2. List tools");
    const listId = nextId();
    send({ id: listId, method: "tools/list", params: {} });
    const listRes = await waitForResponse(listId);
    const tools = ((listRes.result as Record<string, unknown>).tools as Array<{ name: string }>);
    const toolNames = tools.map((t) => t.name).sort();

    assert(toolNames.length === 5, `Found ${toolNames.length} tools`);
    assert(toolNames.includes("provision_postgres_project"), "Has provision tool");
    assert(toolNames.includes("run_sql"), "Has run_sql tool");
    assert(toolNames.includes("rest_query"), "Has rest_query tool");
    assert(toolNames.includes("upload_file"), "Has upload_file tool");
    assert(toolNames.includes("renew_project"), "Has renew_project tool");

    // 3. Call provision — expect 402 (no wallet configured on server)
    console.log("\n3. Provision (expect 402/payment needed)");
    const provisionId = nextId();
    send({
      id: provisionId,
      method: "tools/call",
      params: {
        name: "provision_postgres_project",
        arguments: { tier: "prototype" },
      },
    });
    const provisionRes = await waitForResponse(provisionId);
    const provResult = (provisionRes.result as Record<string, unknown>);
    const provContent = (provResult.content as Array<{ type: string; text: string }>);
    // Should be payment info or error (not a crash)
    assert(provContent.length > 0, "Provision returns content");
    assert(
      provContent[0]!.text.includes("Payment Required") ||
      provContent[0]!.text.includes("Error"),
      "Provision shows payment info or error",
    );

    // 4. Test tools with pre-seeded keystore (if TEST_PROJECT_ID is set)
    const testProjectId = process.env.TEST_PROJECT_ID;
    const testAnonKey = process.env.TEST_ANON_KEY;
    const testServiceKey = process.env.TEST_SERVICE_KEY;

    if (testProjectId && testServiceKey) {
      console.log(`\n4. Testing with project ${testProjectId}`);

      // Pre-seed keystore
      writeFileSync(
        join(tempDir, "projects.json"),
        JSON.stringify({
          projects: {
            [testProjectId]: {
              anon_key: testAnonKey || "",
              service_key: testServiceKey,
              tier: "prototype",
              expires_at: "2099-01-01T00:00:00Z",
            },
          },
        }),
        { mode: 0o600 },
      );

      // 4a. run_sql SELECT 1
      console.log("\n4a. run_sql SELECT 1");
      const sqlId = nextId();
      send({
        id: sqlId,
        method: "tools/call",
        params: {
          name: "run_sql",
          arguments: { project_id: testProjectId, sql: "SELECT 1 AS test" },
        },
      });
      const sqlRes = await waitForResponse(sqlId);
      const sqlContent = ((sqlRes.result as Record<string, unknown>).content as Array<{ text: string }>);
      assert(
        sqlContent[0]!.text.includes("1") && !sqlContent[0]!.text.includes("Error"),
        "SQL SELECT 1 returns result",
      );

      // 4b. rest_query GET (may return empty or data)
      if (testAnonKey) {
        console.log("\n4b. rest_query GET");
        const restId = nextId();
        send({
          id: restId,
          method: "tools/call",
          params: {
            name: "rest_query",
            arguments: {
              project_id: testProjectId,
              table: "nonexistent_table_test",
              method: "GET",
            },
          },
        });
        const restRes = await waitForResponse(restId);
        const restContent = ((restRes.result as Record<string, unknown>).content as Array<{ text: string }>);
        assert(restContent.length > 0, "rest_query returns content (even if error)");
      }

      // 4c. upload_file
      if (testAnonKey) {
        console.log("\n4c. upload_file");
        const uploadId = nextId();
        send({
          id: uploadId,
          method: "tools/call",
          params: {
            name: "upload_file",
            arguments: {
              project_id: testProjectId,
              bucket: "test",
              path: `e2e-test-${Date.now()}.txt`,
              content: "MCP E2E test content",
              content_type: "text/plain",
            },
          },
        });
        const uploadRes = await waitForResponse(uploadId);
        const uploadContent = ((uploadRes.result as Record<string, unknown>).content as Array<{ text: string }>);
        assert(uploadContent.length > 0, "upload_file returns content");
      }

      // 4d. renew_project (expect 402)
      console.log("\n4d. renew_project (expect 402)");
      const renewId = nextId();
      send({
        id: renewId,
        method: "tools/call",
        params: {
          name: "renew_project",
          arguments: { project_id: testProjectId },
        },
      });
      const renewRes = await waitForResponse(renewId);
      const renewContent = ((renewRes.result as Record<string, unknown>).content as Array<{ text: string }>);
      assert(renewContent.length > 0, "renew_project returns content");
    } else {
      console.log("\n4. Skipping live tool tests (set TEST_PROJECT_ID + TEST_SERVICE_KEY to enable)");
    }

    console.log("\nAll tests passed!\n");
  } catch (err) {
    console.error("\nTest failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    proc.kill();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
