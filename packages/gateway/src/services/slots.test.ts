import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
      connect: () => mockPoolConnect(),
    },
  },
});

mock.module("../config.js", {
  namedExports: { MAX_SCHEMA_SLOTS: 2000 },
});

const { allocateSlot, initSlots } = await import("./slots.js");

describe("allocateSlot", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("reuses an archived slot when available", async () => {
    mockPoolQuery = async () => ({ rows: [{ schema_slot: "p0042" }] });
    const slot = await allocateSlot();
    assert.equal(slot, "p0042");
  });

  it("allocates a new slot from sequence when no archived slots", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) return { rows: [] }; // DELETE ... RETURNING (no reusable)
      return { rows: [{ n: 7 }] }; // nextval
    };
    const slot = await allocateSlot();
    assert.equal(slot, "p0007");
  });

  it("pads slot number to 4 digits", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) return { rows: [] };
      return { rows: [{ n: 1234 }] };
    };
    const slot = await allocateSlot();
    assert.equal(slot, "p1234");
  });

  it("returns null when sequence is exhausted", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) return { rows: [] };
      const err = new Error("reached maximum value of sequence");
      (err as any).code = "55000";
      throw err;
    };
    const slot = await allocateSlot();
    assert.equal(slot, null);
  });

  it("rethrows non-sequence errors", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) return { rows: [] };
      throw new Error("connection lost");
    };
    await assert.rejects(() => allocateSlot(), { message: "connection lost" });
  });
});

describe("initSlots", () => {
  it("creates sequence and advances past existing slots", async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (q: string, params?: any[]) => {
        queries.push(typeof q === "string" ? q : "tagged");
        if (queries.length === 2) return { rows: [{ max_slot: 42 }] };
        if (queries.length === 4) return { rows: [{ last_value: 42 }] };
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;

    await initSlots();
    assert.ok(queries.length >= 3);
  });

  it("skips setval when no existing projects", async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (q: string) => {
        queries.push("q");
        if (queries.length === 2) return { rows: [{ max_slot: null }] };
        if (queries.length === 3) return { rows: [{ last_value: 1 }] };
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;

    await initSlots();
    // Should have 3 queries (CREATE SEQUENCE, SELECT max, SELECT last_value)
    // No setval because max_slot is null
    assert.equal(queries.length, 3);
  });
});
