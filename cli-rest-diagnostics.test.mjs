import { test } from "node:test";
import assert from "node:assert/strict";
import { reportSdkError } from "./cli/lib/sdk-errors.mjs";
import { RestPermissionDenied, ApiError } from "./cli/sdk/dist/index.js";
test("CLI preserves normalized permission diagnostic and the native upstream body", () => {
  const originalError = console.error, originalExit = process.exit;
  let output;
  console.error = line => { output = JSON.parse(line); };
  process.exit = () => { throw new Error("exit"); };
  const body = { code: "42501", message: "permission denied for table lights" };
  try {
    assert.throws(() => reportSdkError(new RestPermissionDenied(new ApiError("denied", 401, body, "querying REST"), "POST", "lights")), /exit/);
    assert.equal(output.code, "REST_PERMISSION_DENIED");
    assert.equal(output.http, 401);
    assert.equal(output.details.source, "postgrest");
    assert.deepEqual(output.upstream_body, body);
  } finally { console.error = originalError; process.exit = originalExit; }
});
