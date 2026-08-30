/**
 * gitvault-owned-dispatcher task 3.1 — the parts a unit can pin: the ticket
 * store's file discipline (0600, atomic, symlink-refusing, silent on every
 * failure) and `sdkFetch`'s test-override deference (design D4). The
 * queue-on-connecting and TLS-resumption behaviors are live properties,
 * measured by the bench and the traced first op.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _TicketStoreForTests, sdkFetch } from "./http-dispatcher.js";

describe("TicketStore — file discipline", () => {
  const root = mkdtempSync(join(tmpdir(), "run402-ticket-store-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("round-trips a ticket at mode 0600 via atomic rename", () => {
    const path = join(root, "a", "tls-session-api.v1.bin");
    const store = new _TicketStoreForTests(path);
    assert.equal(store.get(), undefined, "cold store is empty");
    const ticket = Buffer.from("session-ticket-bytes");
    store.put(ticket);
    assert.deepEqual(readFileSync(path), ticket, "persisted bytes match");
    assert.equal(statSync(path).mode & 0o777, 0o600, "owner-only file");
    const fresh = new _TicketStoreForTests(path);
    assert.deepEqual(fresh.get(), ticket, "a new process reads the ticket back");
  });

  it("refuses a symlinked ticket file", () => {
    const real = join(root, "real.bin");
    writeFileSync(real, Buffer.from("x"));
    const link = join(root, "link.bin");
    symlinkSync(real, link);
    const store = new _TicketStoreForTests(link);
    assert.equal(store.get(), undefined, "symlink is never read");
  });

  it("refuses an oversized ticket in both directions", () => {
    const path = join(root, "big.bin");
    const store = new _TicketStoreForTests(path);
    store.put(Buffer.alloc(17 * 1024));
    assert.equal(statSync(path, { throwIfNoEntry: false }), undefined, "oversized ticket never written");
    writeFileSync(path, Buffer.alloc(17 * 1024));
    assert.equal(new _TicketStoreForTests(path).get(), undefined, "oversized file never read");
  });

  it("an unwritable path is silent", () => {
    const store = new _TicketStoreForTests(join(root, "real.bin", "impossible", "x.bin"));
    store.put(Buffer.from("t"));
    assert.ok(true, "no throw");
  });
});

describe("sdkFetch — test-override deference (design D4)", () => {
  const original = globalThis.fetch;
  after(() => {
    globalThis.fetch = original;
  });

  it("a replaced globalThis.fetch sees the request instead of the dispatcher", async () => {
    let seen: unknown = null;
    globalThis.fetch = (async (input: unknown) => {
      seen = input;
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    const res = await sdkFetch("https://example.invalid/never-dialed");
    assert.equal(seen, "https://example.invalid/never-dialed", "override intercepted the request");
    assert.equal(res.status, 200);
  });
});
