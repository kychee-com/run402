import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitFor } from "./wait.js";

describe("waitFor — the one poll loop (attention-architecture Wave E)", () => {
  it("an already-settled wait costs one fetch and zero sleeps", async () => {
    let fetches = 0;
    const started = Date.now();
    const out = await waitFor(
      async () => {
        fetches++;
        return "acknowledged";
      },
      (s) => s === "acknowledged",
      { pollMs: 60_000, timeoutMs: 3_600_000 },
    );
    assert.equal(out.settled, true);
    assert.equal(out.polls, 1);
    assert.equal(fetches, 1);
    assert.ok(Date.now() - started < 500, "no sleep before the first fetch");
  });

  it("polls until the predicate accepts, reporting each state to onPoll", async () => {
    const states = ["open", "open", "acknowledged"];
    const seen: string[] = [];
    const out = await waitFor(
      async () => states.shift()!,
      (s) => s === "acknowledged",
      { pollMs: 1_000, timeoutMs: 30_000, onPoll: (s) => seen.push(s as string) },
    );
    assert.equal(out.settled, true);
    assert.equal(out.polls, 3);
    assert.deepEqual(seen, ["open", "open", "acknowledged"], "every observed state reaches the observer");
  });

  it("SILENCE IS AN ANSWER: timeout RETURNS the last state, never throws", async () => {
    const out = await waitFor(
      async () => "open",
      (s) => s === "acknowledged",
      { pollMs: 1_000, timeoutMs: 500 },
    );
    assert.equal(out.settled, false, "the caller can see nobody answered");
    assert.equal(out.state, "open", "the still-unsettled state is handed back to be looked at");
    assert.equal(out.polls, 1, "a budget smaller than one poll interval stops after the initial fetch");
  });

  it("an API failure is NOT silence — a fetch rejection propagates", async () => {
    await assert.rejects(
      () =>
        waitFor(
          async () => {
            throw new Error("gateway unreachable");
          },
          () => true,
        ),
      /gateway unreachable/,
    );
  });
});
