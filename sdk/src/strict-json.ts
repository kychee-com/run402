/**
 * A strict RFC 8259 JSON parser that keeps every object member, duplicates
 * included, so the vault and identity-link strict profiles can refuse what
 * `JSON.parse` silently collapses. In-house so the SDK carries no JSON
 * parser dependency.
 *
 * It yields the node shape `@humanwhocodes/momoa` did (`Document`, `Object`
 * with `members[{ name, value }]`, `Array` with `elements[{ value }]`,
 * `String`, `Number`, `Boolean`, `Null`), which the callers walk unchanged.
 * Accepts exactly RFC 8259 text: no comments, no trailing commas, no byte
 * order mark, whitespace only space, tab, line feed and carriage return.
 * Throws `StrictJsonSyntaxError` on anything else.
 */

export type StringNode = { type: "String"; value: string };
export type NumberNode = { type: "Number"; value: number };
export type BooleanNode = { type: "Boolean"; value: boolean };
export type NullNode = { type: "Null" };
export type MemberNode = { type: "Member"; name: StringNode; value: ValueNode };
export type ObjectNode = { type: "Object"; members: MemberNode[] };
export type ElementNode = { type: "Element"; value: ValueNode };
export type ArrayNode = { type: "Array"; elements: ElementNode[] };
export type ValueNode = StringNode | NumberNode | BooleanNode | NullNode | ObjectNode | ArrayNode;
export type DocumentNode = { type: "Document"; body: ValueNode };
export type Node = DocumentNode | ValueNode;

export class StrictJsonSyntaxError extends SyntaxError {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "StrictJsonSyntaxError";
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const MAX_DEPTH = 512;

export function parse(text: string): DocumentNode {
  let i = 0;

  const fail = (message: string): never => {
    throw new StrictJsonSyntaxError(message, i);
  };
  const skipWhitespace = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };
  const expectLiteral = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail("unexpected token");
  };

  const parseString = (): StringNode => {
    i += 1; // opening quote
    let value = "";
    let runStart = i;
    while (true) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        value += text.slice(runStart, i);
        i += 1;
        return { type: "String", value };
      }
      if (c < 0x20) fail("control character in string");
      if (c !== 0x5c) {
        i += 1;
        continue;
      }
      value += text.slice(runStart, i);
      const escape = text[i + 1];
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (escape !== undefined && Object.hasOwn(ESCAPES, escape)) {
        value += ESCAPES[escape];
        i += 2;
      } else {
        fail("invalid escape");
      }
      runStart = i;
    }
  };

  const parseValue = (depth: number): ValueNode => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skipWhitespace();
    const c = text[i];
    if (c === "{") {
      i += 1;
      const members: MemberNode[] = [];
      skipWhitespace();
      if (text[i] === "}") {
        i += 1;
        return { type: "Object", members };
      }
      while (true) {
        skipWhitespace();
        if (text[i] !== '"') fail("expected member name");
        const name = parseString();
        skipWhitespace();
        if (text[i] !== ":") fail("expected ':'");
        i += 1;
        members.push({ type: "Member", name, value: parseValue(depth + 1) });
        skipWhitespace();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "}") { i += 1; return { type: "Object", members }; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i += 1;
      const elements: ElementNode[] = [];
      skipWhitespace();
      if (text[i] === "]") {
        i += 1;
        return { type: "Array", elements };
      }
      while (true) {
        elements.push({ type: "Element", value: parseValue(depth + 1) });
        skipWhitespace();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "]") { i += 1; return { type: "Array", elements }; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (c === "t") { expectLiteral("true"); return { type: "Boolean", value: true }; }
    if (c === "f") { expectLiteral("false"); return { type: "Boolean", value: false }; }
    if (c === "n") { expectLiteral("null"); return { type: "Null" }; }
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) return fail("unexpected token");
    i += match[0].length;
    return { type: "Number", value: Number(match[0]) };
  };

  const body = parseValue(0);
  skipWhitespace();
  if (i !== text.length) fail("unexpected text after the value");
  return { type: "Document", body };
}

/** The value a node denotes. A later duplicate member wins, as with `JSON.parse`; `__proto__` is an own property. */
export function evaluate(node: Node): unknown {
  switch (node.type) {
    case "Document":
      return evaluate(node.body);
    case "Object": {
      const out: Record<string, unknown> = {};
      for (const member of node.members) {
        Object.defineProperty(out, member.name.value, { value: evaluate(member.value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case "Array":
      return node.elements.map((element) => evaluate(element.value));
    case "Null":
      return null;
    default:
      return node.value;
  }
}
