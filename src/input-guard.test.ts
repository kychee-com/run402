import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { argumentError, guardToolArguments, strictInput } from "./input-guard.js";
import { upSchema } from "./tools/up.js";
import { runSchema } from "./tools/run.js";
import { toolErrorSchema } from "./structured.js";

describe("argumentError", () => {
  const up = strictInput(upSchema);

  it("passes declared arguments", () => {
    assert.equal(argumentError("up", up, {}), null);
    assert.equal(argumentError("up", up, undefined), null);
  });

  it("refuses an unknown argument and names the closest declared one", () => {
    const declared = Object.keys(upSchema);
    const near = declared[0]!;
    const typo = near.slice(0, -1) + near.slice(-1).repeat(2);
    const error = argumentError("up", up, { bogus: 1, [typo]: "x" })!;
    toolErrorSchema.parse(error);
    assert.equal(error.code, "UNKNOWN_ARGUMENT");
    assert.match(error.message, /^up does not take the arguments /);
    const next = error.next_actions[0]!;
    assert.equal(next.type, "edit_request");
    assert.deepEqual((next.unknown as string[]).sort(), ["bogus", typo].sort());
    assert.ok((next.did_you_mean as Record<string, string[]>)[typo]!.includes(near));
    assert.deepEqual(next.accepted, declared);
  });

  it("reports a wrongly typed argument as INVALID_ARGUMENTS", () => {
    const error = argumentError("run", strictInput(runSchema), { code: 42 })!;
    toolErrorSchema.parse(error);
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.deepEqual((error.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path), ["code"]);
  });
});

describe("guardToolArguments", () => {
  function fakeTransport() {
    const sent: JSONRPCMessage[] = [];
    const dispatched: JSONRPCMessage[] = [];
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (m: JSONRPCMessage) => { sent.push(m); },
      onmessage: (m: JSONRPCMessage) => { dispatched.push(m); },
    } as unknown as Transport;
    guardToolArguments(transport, { up: strictInput(upSchema) });
    return { transport, sent, dispatched };
  }

  it("answers an unknown argument with a structured error and does not dispatch", () => {
    const { transport, sent, dispatched } = fakeTransport();
    transport.onmessage!({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "up", arguments: { bogus: true } } });
    assert.equal(dispatched.length, 0);
    const reply = sent[0] as { id: number; result: { isError: boolean; structuredContent: { status: string; error: { code: string } } } };
    assert.equal(reply.id, 7);
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.structuredContent.status, "error");
    assert.equal(reply.result.structuredContent.error.code, "UNKNOWN_ARGUMENT");
  });

  it("passes valid calls and other messages through", () => {
    const { transport, sent, dispatched } = fakeTransport();
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "up", arguments: {} } });
    transport.onmessage!({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    transport.onmessage!({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unregistered", arguments: { x: 1 } } });
    assert.equal(sent.length, 0);
    assert.equal(dispatched.length, 3);
  });
});
