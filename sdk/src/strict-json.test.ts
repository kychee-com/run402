import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluate, parse, StrictJsonSyntaxError, type DocumentNode, type Node } from "./strict-json.js";

// Control characters are built with
// String.fromCharCode so this file stays plain ASCII.
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const BS = ch(92);

/** The tree as text, members in order, duplicates kept. */
function shape(node: Node): string {
  switch (node.type) {
    case "Document": return shape(node.body);
    case "Object": return `{${node.members.map((m) => `${JSON.stringify(m.name.value)}:${shape(m.value)}`).join(",")}}`;
    case "Array": return `[${node.elements.map((e) => shape(e.value)).join(",")}]`;
    case "Null": return "null";
    default: return `${node.type}:${JSON.stringify(node.value)}`;
  }
}

const ACCEPTED: [text: string, tree: string][] = [
  ["{}", "{}"],
  ["[]", "[]"],
  ["1", "Number:1"],
  ["-0.0e+00", "Number:0"],
  ["0.5", "Number:0.5"],
  ["1E-5", "Number:0.00001"],
  ["true", "Boolean:true"],
  ["null", "null"],
  [` ${ch(9)}${ch(10)}${ch(13)}{ "a" : [ 1 , { } ] } ${ch(10)}`, `{"a":[Number:1,{}]}`],
  [`"${BS}u00e9"`, `String:${JSON.stringify(ch(0xe9))}`],
  [`"${BS}uD83D${BS}uDE00"`, `String:${JSON.stringify(ch(0xd83d, 0xde00))}`],
  [`"${BS}ud800"`, `String:${JSON.stringify(ch(0xd800))}`],
  [`"${BS}/${BS}b${BS}f${BS}n${BS}r${BS}t${BS}"${BS}${BS}"`, `String:${JSON.stringify("/\b\f\n\r\t\"\\")}`],
  [`{"a":1,"a":2}`, `{"a":Number:1,"a":Number:2}`],
  [`{"":0}`, `{"":Number:0}`],
  ["[[[]]]", "[[[]]]"],
];

const REFUSED = [
  "", " ", "01", "1.", ".5", "+1", "-", "--1", "1e", "tru", "nul", "NaN", "Infinity", "1 2", "[1]x",
  `"${BS}x"`, `"${BS}u12"`, `"a`, `"${ch(9)}"`, `"${ch(10)}"`, `"${ch(0)}"`,
  `{"a":1,}`, "[1,]", "[1 2]", `{a:1}`, `{'a':1}`, `{"a" 1}`,
  "// c\n1", "/* c */1", `${ch(0xfeff)}{}`, `${ch(0xa0)}{}`, `${ch(0x0b)}1`,
];

describe("strict JSON parse", () => {
  for (const [text, tree] of ACCEPTED) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      assert.equal(shape(parse(text)), tree);
      assert.deepEqual(evaluate(parse(text)), JSON.parse(text));
    });
  }

  for (const text of REFUSED) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      assert.throws(() => parse(text), StrictJsonSyntaxError);
    });
  }

  it("keeps __proto__ as an own property, like JSON.parse", () => {
    const value = evaluate(parse(`{"__proto__":{"x":1}}`)) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.deepEqual(Object.keys(value), ["__proto__"]);
    assert.deepEqual(value.__proto__, { x: 1 });
  });

  it("refuses nesting deeper than 512", () => {
    assert.throws(() => parse("[".repeat(600) + "]".repeat(600)), /nesting too deep/);
    assert.doesNotThrow(() => parse("[".repeat(500) + "]".repeat(500)));
  });

  it("returns a Document node", () => {
    const doc: DocumentNode = parse("[1]");
    assert.equal(doc.type, "Document");
  });
});
