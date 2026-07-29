import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const HERE = new URL(".", import.meta.url);
const HELPER = new URL("./scripts/buzz-publish-proof.mjs", HERE);
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/buzz-v0.4.26-managed-agent-kind1.json", HERE), "utf8"));

function runHelper({ event = FIXTURE.event, beginText, publishOutput } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "run402-buzz-helper-"));
  const begin = join(directory, "begin.json");
  const output = join(directory, "event.json");
  const fakeBuzz = join(directory, "buzz");
  writeFileSync(fakeBuzz, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "social" && args[1] === "publish") process.stdout.write(process.env.FAKE_PUBLISH);
else if (args[0] === "social" && args[1] === "event") process.stdout.write(process.env.FAKE_EVENT);
else process.exit(2);
`);
  chmodSync(fakeBuzz, 0o700);
  writeFileSync(begin, beginText ?? JSON.stringify({
    visibility: "public",
    nostr_pubkey: FIXTURE.expected_agent_pubkey,
    proof_content: FIXTURE.expected_content,
  }));
  const result = spawnSync(process.execPath, [HELPER.pathname, "--begin", begin, "--event", output], {
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_PUBLISH: publishOutput ?? JSON.stringify({ id: event.id }),
      FAKE_EVENT: JSON.stringify([event]),
    },
  });
  return { directory, output, result };
}

describe("Buzz public proof helper", () => {
  it("accepts the released managed-agent kind-1 fixture and writes the exact public envelope", () => {
    const { output, result } = runHelper();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), FIXTURE.event);
    assert.equal(JSON.parse(result.stdout).pubkey, FIXTURE.expected_agent_pubkey);
  });

  it("accepts the released prose event-id receipt fallback", () => {
    const { result } = runHelper({ publishOutput: `Published event ${FIXTURE.event.id}\n` });
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects unsafe tags and the wrong signing principal", () => {
    const unsafe = structuredClone(FIXTURE.event);
    unsafe.tags = [["e", "1".repeat(64)]];
    const unsafeResult = runHelper({ event: unsafe }).result;
    assert.equal(unsafeResult.status, 1);
    assert.equal(JSON.parse(unsafeResult.stderr).code, "IDENTITY_LINK_UNSAFE_TAGS");

    const wrong = structuredClone(FIXTURE.event);
    wrong.pubkey = "f".repeat(64);
    const wrongResult = runHelper({ event: wrong }).result;
    assert.equal(wrongResult.status, 1);
    assert.equal(JSON.parse(wrongResult.stderr).code, "WRONG_NOSTR_PRINCIPAL");
  });

  it("rejects duplicate or secret-shaped begin fields before invoking a signer", () => {
    const duplicate = runHelper({ beginText: `{"visibility":"public","nostr_pubkey":"${FIXTURE.expected_agent_pubkey}","proof_content":"x","proof_content":"y"}` }).result;
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stderr).code, "IDENTITY_LINK_DUPLICATE_FIELD");

    const secret = runHelper({ beginText: JSON.stringify({
      visibility: "public",
      nostr_pubkey: FIXTURE.expected_agent_pubkey,
      proof_content: "x",
      nested: { private_key: "forbidden" },
    }) }).result;
    assert.equal(secret.status, 1);
    assert.equal(JSON.parse(secret.stderr).code, "IDENTITY_LINK_SECRET_INPUT_FORBIDDEN");
  });

  it("uses argument-array process spawning with no shell", () => {
    const source = readFileSync(HELPER, "utf8");
    assert.match(source, /spawnSync\("buzz", args, \{[^}]*shell: false/s);
    assert.doesNotMatch(source, /execSync|execFileSync|\bshell:\s*true\b/);
  });
});
