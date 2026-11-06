import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalize } from "./jcs.js";

// Expected outputs were recorded from json-canonicalize 2.0.0 before the SDK
// dropped it. Non-ASCII is spelled <XXXX> and a backslash-u
// escape %XXXX so this file stays plain ASCII.
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const BS = ch(92);
const ascii = (text: string) =>
  text.replace(/%([0-9a-f]{4})/g, (_, hex: string) => `${BS}u${hex}`).replace(/<([0-9a-f]{4})>/g, (_, hex: string) => ch(parseInt(hex, 16)));

const RECORDED: [name: string, input: unknown, expected: string][] = [
  ["numbers", [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345680000, 5e-324, 1.7976931348623157e308, 333333333.33333329, 4.5, 2e-3, 1e-27],
    "[0,0,1,-1,1.5,1e+21,1e-7,123456789012345680000,5e-324,1.7976931348623157e+308,333333333.3333333,4.5,0.002,1e-27]"],
  ["non-finite", [NaN, Infinity, -Infinity], "[null,null,null]"],
  ["strings", ["", "a", ch(0x2028, 0x2029), ch(0xd800), ch(0xd83d, 0xde00), ch(0, 0x1f, 0x22, 0x5c, 0x2f), ch(0x20ac),
    ch(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f)],
    ascii(`["","a","<2028><2029>","%d800","<d83d><de00>","%0000%001f${BS}"${BS}${BS}/","<20ac>","<20ac>$%000f${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"]`)],
  ["member order", { b: 1, a: 2, A: 3, "": 4, [ch(0xe9)]: 5, [ch(0xd83d, 0xde00)]: 6, [ch(0xe000)]: 7, "10": 8, "9": 9, "1": 10 },
    ascii(`{"":4,"1":10,"10":8,"9":9,"A":3,"a":2,"b":1,"<00e9>":5,"<d83d><de00>":6,"<e000>":7}`)],
  ["undefined", { x: undefined, y: [1, undefined, null] }, `{"y":[1,null,null]}`],
  ["toJSON", { d: new Date(0), o: { toJSON() { return { b: 1, a: 2 }; } } }, `{"d":"1970-01-01T00:00:00.000Z","o":{"b":1,"a":2}}`],
  ["nested", { n: [{ z: 1, a: [{}] }], l: [null, true, false] }, `{"l":[null,true,false],"n":[{"a":[{}],"z":1}]}`],
];

describe("canonicalize (RFC 8785)", () => {
  for (const [name, input, expected] of RECORDED) {
    it(`matches json-canonicalize 2.0.0: ${name}`, () => {
      assert.equal(canonicalize(input), expected);
    });
  }

  it("sorts members by UTF-16 code units, not code points (RFC 8785 section 3.2.3)", () => {
    // U+E000 (one unit, 0xE000) sorts after U+1F600 (surrogates 0xD83D 0xDE00).
    assert.equal(canonicalize({ [ch(0xe000)]: 1, [ch(0xd83d, 0xde00)]: 2 }), ascii(`{"<d83d><de00>":2,"<e000>":1}`));
  });

  it("writes a member named __proto__ as an ordinary member", () => {
    const value = JSON.parse(`{"__proto__":{"x":1},"a":0}`) as unknown;
    assert.equal(canonicalize(value), `{"__proto__":{"x":1},"a":0}`);
  });

  it("writes a shared, non-circular reference each time it appears", () => {
    const shared = { k: 1 };
    assert.equal(canonicalize({ a: shared, b: [shared] }), `{"a":{"k":1},"b":[{"k":1}]}`);
  });

  it("refuses a circular reference", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    assert.throws(() => canonicalize(loop), /Circular reference/);
    const arrayLoop: unknown[] = [];
    arrayLoop.push(arrayLoop);
    assert.throws(() => canonicalize(arrayLoop), /Circular reference/);
  });
});
