export class StrictJsonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.details = details;
  }
}

/** Parse JSON while rejecting duplicate object keys before object construction. */
export function parseStrictJson(text, label = "JSON") {
  if (typeof text !== "string") {
    throw new StrictJsonError("IDENTITY_LINK_INVALID_JSON", `${label} must be text`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new StrictJsonError("IDENTITY_LINK_INVALID_JSON", `${label} must not contain a UTF-8 BOM`);
  }

  let index = 0;
  const fail = (message, details = {}) => {
    throw new StrictJsonError("IDENTITY_LINK_INVALID_JSON", `${label} ${message}`, { offset: index, ...details });
  };
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail("contains an invalid string");
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) fail("contains an unescaped control character");
      if (text[index] === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); }
        catch { fail("contains an invalid string escape"); }
      }
      if (text[index] === "\\") {
        index += 1;
        if (index >= text.length) fail("contains an unterminated string escape");
        if (text[index] === "u") {
          const escape = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(escape)) fail("contains an invalid Unicode escape");
          index += 5;
          continue;
        }
        if (!'["\\/bfnrt]'.includes(text[index])) fail("contains an invalid string escape");
        index += 1;
        continue;
      }
      index += 1;
    }
    fail("contains an unterminated string");
  };
  const parseValue = (path = "$") => {
    whitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      whitespace();
      const value = Object.create(null);
      const seen = new Set();
      if (text[index] === "}") { index += 1; return value; }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (seen.has(key)) {
          throw new StrictJsonError(
            "IDENTITY_LINK_DUPLICATE_FIELD",
            `${label} contains a duplicate field`,
            { field: `${path}.${key}` },
          );
        }
        seen.add(key);
        whitespace();
        if (text[index] !== ":") fail("is missing an object colon", { field: `${path}.${key}` });
        index += 1;
        value[key] = parseValue(`${path}.${key}`);
        whitespace();
        if (text[index] === "}") { index += 1; return value; }
        if (text[index] !== ",") fail("is missing an object comma", { field: `${path}.${key}` });
        index += 1;
      }
      fail("contains an unterminated object");
    }
    if (char === "[") {
      index += 1;
      whitespace();
      const value = [];
      if (text[index] === "]") { index += 1; return value; }
      while (index < text.length) {
        value.push(parseValue(`${path}[${value.length}]`));
        whitespace();
        if (text[index] === "]") { index += 1; return value; }
        if (text[index] !== ",") fail("is missing an array comma", { field: path });
        index += 1;
      }
      fail("contains an unterminated array");
    }
    if (char === '"') return parseString();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return value; }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail("contains a non-finite number");
      return value;
    }
    fail("contains an invalid value", { field: path });
  };

  whitespace();
  const value = parseValue();
  whitespace();
  if (index !== text.length) fail("contains trailing bytes");
  return value;
}
