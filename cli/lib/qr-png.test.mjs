// The pinned digests were produced by this encoder and matched module for
// module against the `qrcode` package (at the same version and mask) when
// it replaced that package, over every version 1-40, all eight masks, and
// both alphanumeric and byte mode.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { encodeQr, qrPng } from "./qr-png.mjs";

const INVOICE = "LIGHTNING:LNBC20U1PJ9X7ZSPP5" + "QZ7C8RT2XJ".repeat(28);

function digest(modules) {
  return createHash("sha256").update(modules.map((row) => row.map((d) => (d ? 1 : 0)).join("")).join("")).digest("hex");
}

describe("encodeQr", () => {
  for (const [text, version, mask, sha] of [
    ["HELLO WORLD", 1, 0, "9f15327b648fdbb6e3878c9a72183cc1f76f880c1b3e4f53fd7859bb5b4f2421"],
    ["lightning:lnbc1 – ünïcode", 3, 3, "8dc8f3d73627d16d3d998fc17724f950d7e5e80ac8a74eea041a495d6eadcf20"],
    [INVOICE, 10, 2, "e52883f489d0a22b6ee8f05919747653f58d9cc3224139886223905fa970708a"],
  ]) {
    it(`encodes ${JSON.stringify(text.slice(0, 20))} as version ${version}, mask ${mask}`, () => {
      const qr = encodeQr(text);
      assert.equal(qr.version, version);
      assert.equal(qr.mask, mask);
      assert.equal(qr.size, version * 4 + 17);
      assert.equal(digest(qr.modules), sha);
    });
  }

  it("refuses a payload larger than version 40 holds", () => {
    assert.throws(() => encodeQr("A".repeat(4000)), /QR payload too long/);
  });
});

describe("qrPng", () => {
  it("writes a grayscale PNG whose pixels are the modules", () => {
    const png = qrPng(INVOICE, { width: 512, margin: 2 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    const width = png.readUInt32BE(16);
    assert.equal(width, 512);
    assert.equal(png.readUInt32BE(20), 512);
    const idatLength = png.readUInt32BE(33);
    assert.equal(png.toString("ascii", 37, 41), "IDAT");
    const rows = inflateSync(png.subarray(41, 41 + idatLength));
    assert.equal(rows.length, (width + 1) * width);
    const { size, modules } = encodeQr(INVOICE);
    const scale = width / (size + 4);
    for (const [mx, my] of [[0, 0], [3, 3], [7, 7], [size - 1, size - 1], [10, 20]]) {
      const px = Math.floor((mx + 2.5) * scale);
      const py = Math.floor((my + 2.5) * scale);
      assert.equal(rows[py * (width + 1) + 1 + px] === 0, modules[my][mx], `module ${mx},${my}`);
    }
    assert.equal(rows[1], 0xff, "the margin is light");
  });
});
