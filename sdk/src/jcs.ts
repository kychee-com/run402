/**
 * RFC 8785 JSON Canonicalization Scheme, in-house so the SDK carries no
 * third-party canonicalizer: every published dependency installs on a
 * customer's machine, and each one is a supply-chain door.
 *
 * Byte-for-byte the output of `json-canonicalize` 2.0.0's `canonicalize`,
 * which this replaced: members sorted by UTF-16 code units (the default
 * string sort), strings and numbers written as `JSON.stringify` writes them
 * (ECMAScript number serialization is exactly RFC 8785's), `undefined`
 * members omitted, `undefined` array entries written as `null`, a value with
 * `toJSON` written as `JSON.stringify` writes it, a circular reference
 * refused. `jcs.test.ts` pins the parity with outputs recorded from 2.0.0.
 */
import { LocalError } from "./errors.js";

export function canonicalize(value: unknown): string {
  let out = "";
  const ancestors: object[] = [];

  const write = (node: unknown): void => {
    if (node === null || typeof node !== "object" || (node as { toJSON?: unknown }).toJSON != null) {
      out += JSON.stringify(node);
      return;
    }
    if (ancestors.includes(node)) throw new LocalError("Circular reference detected", "canonicalizing JSON (RFC 8785)");
    ancestors.push(node);
    if (Array.isArray(node)) {
      out += "[";
      for (let i = 0; i < node.length; i += 1) {
        if (i > 0) out += ",";
        const entry: unknown = node[i];
        write(entry === undefined ? null : entry);
      }
      out += "]";
    } else {
      const record = node as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      out += "{";
      keys.forEach((key, i) => {
        if (i > 0) out += ",";
        out += JSON.stringify(key);
        out += ":";
        write(record[key]);
      });
      out += "}";
    }
    ancestors.pop();
  };

  write(value);
  return out;
}
