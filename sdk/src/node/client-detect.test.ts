import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { declaredAgentName, detectClientName } from "./client-detect.js";

describe("detectClientName", () => {
  it("returns null when nothing specific is known", () => {
    assert.equal(detectClientName({}), null);
  });

  it("detects claude-code from CLAUDECODE", () => {
    assert.equal(detectClientName({ CLAUDECODE: "1" }), "claude-code");
  });

  it("detects codex from CODEX_HOME", () => {
    assert.equal(detectClientName({ CODEX_HOME: "/tmp/codex" }), "codex");
  });

  it("detects cursor from CURSOR_AGENT", () => {
    assert.equal(detectClientName({ CURSOR_AGENT: "1" }), "cursor");
  });

  it("detects grok from GROK_AGENT", () => {
    assert.equal(detectClientName({ GROK_AGENT: "1" }), "grok");
  });

  it("detects grok from GROK_SESSION_ID", () => {
    assert.equal(detectClientName({ GROK_SESSION_ID: "01abc" }), "grok");
  });

  it("claude-code wins when several harness markers are present", () => {
    assert.equal(
      detectClientName({ CLAUDECODE: "1", GROK_AGENT: "1", CURSOR_AGENT: "1" }),
      "claude-code",
    );
  });
});

describe("declaredAgentName", () => {
  it("trims RUN402_AGENT_NAME and treats blank as absent", () => {
    assert.equal(declaredAgentName({ RUN402_AGENT_NAME: " Grok " }), "Grok");
    assert.equal(declaredAgentName({ RUN402_AGENT_NAME: "   " }), null);
    assert.equal(declaredAgentName({}), null);
  });
});
