import { test } from "node:test";
import assert from "node:assert/strict";

import { manifestFileMissingError, manifestNotFoundError } from "./deploy-manifest.js";

function checkAction(actions: Array<Record<string, unknown>> | undefined) {
  return (actions ?? []).find((action) => action.type === "check_manifest");
}

test("MANIFEST_FILE_MISSING ends with a check_manifest next action naming run402 up --check", () => {
  const err = manifestFileMissingError(
    [{ field_path: "site.replace[\"sigil.webp\"].path", path: "assets/sigil.webp", kind: "file" }],
    { manifestPath: "run402.json" },
  );
  const actions = err.nextActions as Array<Record<string, unknown>>;
  assert.equal(actions[0]?.type, "create_file", "the per-file fix stays first");
  const check = checkAction(actions);
  assert.ok(check, "expected a check_manifest next action");
  assert.deepEqual(check.argv, ["run402", "up", "--manifest", "run402.json", "--check"]);
  assert.match(String(check.why), /no gateway call/i);
});

test("MANIFEST_NOT_FOUND offers the same check after the manifest is created", () => {
  const err = manifestNotFoundError("app/run402.json", "loading manifest");
  const actions = err.nextActions as Array<Record<string, unknown>>;
  assert.equal(actions[0]?.type, "create_manifest");
  const check = checkAction(actions);
  assert.ok(check, "expected a check_manifest next action");
  assert.deepEqual(check.argv, ["run402", "up", "--manifest", "app/run402.json", "--check"]);
});
