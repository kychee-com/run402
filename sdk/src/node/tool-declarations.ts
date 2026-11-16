/**
 * The tool-declaration extractor: source in, declarations out.
 *
 * A function file or an Astro endpoint file declares MCP tools beside its
 * handler with `export const tool = { … }` (one) or
 * `export const tools = { name: { … }, … }` (several), as static literals.
 * This module reads that export by PARSING the file. It never imports,
 * evaluates or runs the source, so a file whose top level throws, reads
 * secrets or opens sockets is read exactly like any other.
 *
 * It is the only extractor: `@run402/sdk/node` calls it for every function
 * source a deploy reads, and `@run402/astro` calls it for every
 * server-rendered endpoint file at build. The gateway reads no source.
 *
 * How a file is read:
 *
 *   1. As JavaScript, with acorn. A plain or bundled file parses here.
 *   2. Otherwise types are erased with `module.stripTypeScriptTypes` in strip
 *      mode, which replaces them with spaces, so every line stays where it
 *      was and a reported line is exact.
 *   3. A file with syntax that cannot be erased (an `enum`) is read in
 *      transform mode, where lines move, so its refusals carry no line.
 *
 * The export's initializer is then evaluated as a JSON-literal subset: object,
 * array, string, number, boolean and null literals only. An identifier, a
 * call, a spread, a computed key or a template substitution is
 * `MCP_TOOL_NOT_STATIC`.
 */

import * as nodeModule from "node:module";
import { parse as parseJs, type Node as AcornNode } from "acorn";

import {
  checkFunctionToolEntry,
  isValidMcpToolName,
  toolDeclarationError,
  type FunctionToolLiftInput,
  type McpToolErrorCode,
  type ToolDeclarationProblem,
} from "../function-tools.js";
import { FUNCTION_TOOL_METHODS } from "../namespaces/deploy.types.js";
import type { FunctionToolMethod, FunctionToolSpec } from "../namespaces/deploy.types.js";

/** Set for an Astro endpoint file: the request its tools name is the endpoint's own. */
export interface EndpointToolContext {
  /** The endpoint's route as Astro writes it, e.g. `/api/notes/[note_id]`. */
  route: string;
  /** The project's `base`. Default `/`. */
  base?: string;
  /** True when the route answers only with a trailing slash (`trailingSlash: "always"`). */
  trailingSlash?: boolean;
  /** True when Astro prerenders the route, so a static file answers its path. */
  prerendered?: boolean;
}

export interface ExtractToolDeclarationsOptions {
  /** The file's name or path, reported in a refusal. Omit for an inline source. */
  file?: string | null;
  /** Read the file as an Astro endpoint; omitted, it is a function's entry file. */
  endpoint?: EndpointToolContext;
}

export type ToolExtraction =
  | { ok: true; tools: FunctionToolSpec[] }
  | { ok: false; problem: ToolDeclarationProblem };

type EsNode = AcornNode & Record<string, any>;

/** Thrown and caught inside this module only. */
class Refusal extends Error {
  constructor(
    readonly code: McpToolErrorCode,
    readonly fieldPath: string,
    message: string,
    readonly node?: EsNode | null,
    readonly tool?: string,
  ) {
    super(message);
  }

  /** A refusal already described as data, at the node it is about. */
  static at(
    node: EsNode | null | undefined,
    problem: { code: McpToolErrorCode; field_path: string; message: string },
    tool?: string,
  ): Refusal {
    return new Refusal(problem.code, problem.field_path, problem.message, node, tool);
  }
}

const ENDPOINT_HANDLERS = new Set<string>([...FUNCTION_TOOL_METHODS, "ALL"]);

// ─── reading the file ────────────────────────────────────────────────────────

/**
 * Cheap pre-check so the common case (no tool export) never pays for a
 * parse. A false positive costs only the parse.
 */
function mayDeclareTools(source: string): boolean {
  return /\bexport\b/.test(source) && /\btools?\b/.test(source);
}

/** Whether an unparseable file still plainly exports `tool` or `tools`. */
function plainlyExportsTools(source: string): "tool" | "tools" | null {
  const declared = /\bexport\s+(?:declare\s+)?(?:const|let|var)\s+(tools?)\b/.exec(source);
  if (declared) return declared[1] as "tool" | "tools";
  const clause = /\bexport\s*\{[^}]*?\b(?:as\s+)?(tools?)\s*[,}]/.exec(source);
  return clause ? (clause[1] as "tool" | "tools") : null;
}

function parseModule(source: string): EsNode {
  return parseJs(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: true }) as EsNode;
}

type StripMode = "strip" | "transform";
type StripTypes = (code: string, options: { mode: StripMode }) => string;

/**
 * `stripTypeScriptTypes` announces itself with a one-time ExperimentalWarning
 * on stderr. Drop exactly that warning for the duration of the call; every
 * other warning still reaches the process.
 */
function stripTypesQuietly(strip: StripTypes, source: string, mode: StripMode): string {
  const emit = process.emitWarning;
  process.emitWarning = function quietStripWarning(this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type;
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const name = typeof warning === "string" ? undefined : warning?.name;
    if ((type === "ExperimentalWarning" || name === "ExperimentalWarning") && /stripTypeScriptTypes|type strip/i.test(message)) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return strip(source, { mode });
  } finally {
    process.emitWarning = emit;
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.replace(/\s*\(\d+:\d+\)$/, "");
}

type ParsedFile =
  | { program: EsNode; exactLines: boolean }
  | { unreadable: string };

function readFile(source: string): ParsedFile {
  let jsError: unknown;
  try {
    return { program: parseModule(source), exactLines: true };
  } catch (err) {
    jsError = err;
  }
  const strip = (nodeModule as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
  if (typeof strip !== "function") {
    return { unreadable: `${firstLine(jsError)}; this Node (${process.version}) cannot erase TypeScript types, so use Node 22.13 or later` };
  }
  let stripped: string;
  let exactLines = true;
  try {
    stripped = stripTypesQuietly(strip, source, "strip");
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return { unreadable: firstLine(err) };
    try {
      stripped = stripTypesQuietly(strip, source, "transform");
      exactLines = false;
    } catch (transformErr) {
      return { unreadable: firstLine(transformErr) };
    }
  }
  try {
    return { program: parseModule(stripped), exactLines };
  } catch (err) {
    return { unreadable: firstLine(err) };
  }
}

// ─── finding the export ──────────────────────────────────────────────────────

type ExportName = "tool" | "tools";

interface Declared {
  /** The initializer, or null when the export is not a readable binding. */
  init: EsNode | null;
  /** Why it is not readable, when `init` is null. */
  why?: string;
  node: EsNode;
}

interface ModuleExports {
  names: Set<string>;
  tool?: Declared;
  tools?: Declared;
}

/** True when the module assigns to `name` anywhere (`=`, `+=`, `++`, destructuring, `for (name of …)`). */
function isReassigned(program: EsNode, name: string): boolean {
  const targets = (node: EsNode | null): boolean => {
    if (!node) return false;
    switch (node.type) {
      case "Identifier": return node.name === name;
      case "ArrayPattern": return (node.elements as Array<EsNode | null>).some(targets);
      case "ObjectPattern": return (node.properties as EsNode[]).some((p) => targets(p.type === "RestElement" ? p : p.value));
      case "RestElement": return targets(node.argument);
      case "AssignmentPattern": return targets(node.left);
      default: return false;
    }
  };
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!node || typeof node !== "object" || typeof (node as EsNode).type !== "string") return false;
    const n = node as EsNode;
    if (n.type === "AssignmentExpression" && targets(n.left)) return true;
    if (n.type === "UpdateExpression" && targets(n.argument)) return true;
    if ((n.type === "ForInStatement" || n.type === "ForOfStatement") && n.left.type !== "VariableDeclaration" && targets(n.left)) return true;
    return Object.entries(n).some(([key, value]) => key !== "type" && key !== "loc" && typeof value === "object" && visit(value));
  };
  return visit(program.body);
}

/** Names a binding pattern introduces (`{ a, b: [c] }` → a, c). */
function patternNames(pattern: EsNode | null, out: string[] = []): string[] {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier": out.push(pattern.name); break;
    case "ObjectPattern": for (const p of pattern.properties as EsNode[]) patternNames(p.type === "RestElement" ? p.argument : p.value, out); break;
    case "ArrayPattern": for (const el of pattern.elements as Array<EsNode | null>) patternNames(el, out); break;
    case "RestElement": patternNames(pattern.argument, out); break;
    case "AssignmentPattern": patternNames(pattern.left, out); break;
    default: break;
  }
  return out;
}

function specifierName(node: EsNode): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

const writeInline = (name: string): string => `Write it in this file as \`export const ${name} = { … }\` with literal values.`;

/**
 * Walk the module's top level for its exported names and for the `tool` and
 * `tools` exports. A bundle writes `var t = {…}; export { t as tools }`, so an
 * export specifier is followed to its local top-level binding; a `let` or
 * `var` binding counts only when the module never reassigns it.
 */
function moduleExports(program: EsNode): ModuleExports {
  const out: ModuleExports = { names: new Set() };
  const locals = new Map<string, { kind: string; init: EsNode | null; node: EsNode }>();
  for (const stmt of program.body as EsNode[]) {
    const decl = stmt.type === "ExportNamedDeclaration" && stmt.declaration ? (stmt.declaration as EsNode) : stmt;
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations as EsNode[]) {
      if (d.id.type === "Identifier") locals.set(d.id.name, { kind: decl.kind, init: d.init, node: d });
    }
  }
  const record = (name: string, declared: Declared): void => {
    out.names.add(name);
    if ((name === "tool" || name === "tools") && out[name] === undefined) out[name] = declared;
  };
  const fromLocal = (exported: string, localName: string, node: EsNode): Declared => {
    const local = locals.get(localName);
    if (!local) {
      return { init: null, node, why: `\`${exported}\` is not a literal declared in this file. ${writeInline(exported)}` };
    }
    if (local.kind !== "const" && isReassigned(program, localName)) {
      return { init: null, node, why: `\`${exported}\` is reassigned, so its value cannot be read without running the file. Declare it once with \`const\`.` };
    }
    if (!local.init) {
      return { init: null, node, why: `\`${exported}\` has no value. ${writeInline(exported)}` };
    }
    return { init: local.init, node: local.node };
  };

  for (const stmt of program.body as EsNode[]) {
    if (stmt.type === "ExportAllDeclaration") {
      if (stmt.exported) {
        const name = specifierName(stmt.exported);
        record(name, { init: null, node: stmt, why: `\`${name}\` is re-exported from another module, which is not read. ${writeInline(name)}` });
      }
      continue;
    }
    if (stmt.type !== "ExportNamedDeclaration") continue;
    if (stmt.declaration) {
      const decl = stmt.declaration as EsNode;
      if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations as EsNode[]) {
          if (d.id.type === "Identifier") {
            record(d.id.name, fromLocal(d.id.name, d.id.name, d));
          } else {
            for (const name of patternNames(d.id)) {
              record(name, { init: null, node: d, why: `\`${name}\` is destructured from another value. ${writeInline(name)}` });
            }
          }
        }
      } else if (decl.id?.name) {
        const kind = decl.type === "ClassDeclaration" ? "a class" : "a function";
        record(decl.id.name, { init: null, node: decl, why: `\`${decl.id.name}\` is ${kind}; a tool declaration is an object literal. ${writeInline(decl.id.name)}` });
      }
      continue;
    }
    for (const spec of stmt.specifiers as EsNode[]) {
      const exported = specifierName(spec.exported);
      if (stmt.source) {
        record(exported, { init: null, node: spec, why: `\`${exported}\` is re-exported from another module, which is not read. ${writeInline(exported)}` });
      } else {
        record(exported, fromLocal(exported, specifierName(spec.local), spec));
      }
    }
  }
  return out;
}

// ─── evaluating the literal ──────────────────────────────────────────────────

function joinPath(base: string, key: string | number): string {
  return typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;
}

function propertyKey(prop: EsNode, path: string): string {
  if (prop.type === "SpreadElement") throw new Refusal("MCP_TOOL_NOT_STATIC", path, "A spread (`...`) is not allowed in a tool declaration; write the fields inline.", prop);
  if (prop.computed) throw new Refusal("MCP_TOOL_NOT_STATIC", path, "A computed key (`[key]: …`) is not allowed in a tool declaration; write the key itself.", prop);
  if (prop.kind !== "init" || prop.method) throw new Refusal("MCP_TOOL_NOT_STATIC", path, "A getter, setter or method is not allowed in a tool declaration; every field is a literal value.", prop);
  if (prop.key.type === "Identifier") return prop.key.name as string;
  if (prop.key.type === "Literal" && (typeof prop.key.value === "string" || typeof prop.key.value === "number")) return String(prop.key.value);
  throw new Refusal("MCP_TOOL_NOT_STATIC", path, "An object key must be an identifier or a string.", prop);
}

/** Evaluate a JSON-literal subset of an ESTree expression, recording the line of every value by path. */
function literalValue(node: EsNode, path: string, lines: Map<string, EsNode>): unknown {
  lines.set(path, node);
  const notStatic = (message: string): Refusal => new Refusal("MCP_TOOL_NOT_STATIC", path, message, node);
  switch (node.type) {
    case "Literal": {
      if (node.regex) throw notStatic("A regular expression is not a JSON value; write the pattern as a string.");
      if (typeof node.value === "bigint" || node.bigint !== undefined) throw notStatic("A BigInt is not a JSON value; write a number.");
      return node.value;
    }
    case "TemplateLiteral": {
      if (node.expressions.length > 0) throw notStatic("A template literal with a `${…}` substitution is not static; write the whole string.");
      return (node.quasis as EsNode[]).map((quasi) => quasi.value.cooked).join("");
    }
    case "UnaryExpression": {
      const arg = node.argument as EsNode;
      if (node.operator === "-" && arg.type === "Literal" && typeof arg.value === "number") return -arg.value;
      // A minifier writes `true` as `!0` and `false` as `!1`.
      if (node.operator === "!" && arg.type === "Literal" && (arg.value === 0 || arg.value === 1)) return arg.value === 0;
      throw notStatic(`The operator \`${node.operator}\` is not allowed in a tool declaration; write the value itself.`);
    }
    case "ArrayExpression": {
      return (node.elements as Array<EsNode | null>).map((element, index) => {
        const at = joinPath(path, index);
        if (element === null) throw new Refusal("MCP_TOOL_NOT_STATIC", at, "An array hole is not a JSON value.", node);
        if (element.type === "SpreadElement") throw new Refusal("MCP_TOOL_NOT_STATIC", at, "A spread (`...`) is not allowed in a tool declaration; write the items inline.", element);
        return literalValue(element, at, lines);
      });
    }
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as EsNode[]) {
        const key = propertyKey(prop, path);
        const at = joinPath(path, key);
        if (prop.shorthand) throw new Refusal("MCP_TOOL_NOT_STATIC", at, `\`${key}\` refers to a variable; write the value inline.`, prop);
        if (key === "__proto__") throw new Refusal("MCP_TOOL_NOT_STATIC", at, "`__proto__` is not allowed in a tool declaration.", prop);
        out[key] = literalValue(prop.value as EsNode, at, lines);
      }
      return out;
    }
    case "Identifier": {
      if (node.name === "undefined") throw notStatic("`undefined` is not a JSON value; leave the field out.");
      throw notStatic(`\`${node.name}\` refers to a variable; write the value inline.`);
    }
    case "CallExpression":
    case "NewExpression":
      throw notStatic("A function call is not static; write the value inline.");
    default:
      throw notStatic(`A ${node.type} is not a static value; a tool declaration holds only object, array, string, number, boolean and null literals.`);
  }
}

/** The node recorded for `path`, or for its nearest recorded ancestor. */
function nodeAt(lines: Map<string, EsNode>, path: string): EsNode | undefined {
  let at = path;
  for (;;) {
    const node = lines.get(at);
    if (node) return node;
    const cut = Math.max(at.lastIndexOf("."), at.lastIndexOf("["));
    if (cut <= 0) return undefined;
    at = at.slice(0, cut);
  }
}

// ─── an endpoint's request ───────────────────────────────────────────────────

/**
 * An Astro route as a tool path: `[param]` becomes `{param}`, and the
 * project's `base` is applied. A rest segment (`[...rest]`) or a parameter
 * that is only part of a segment (`post-[id]`) has no tool path.
 */
export function endpointToolPath(
  route: string,
  opts: { base?: string; trailingSlash?: boolean } = {},
): { ok: true; path: string; params: string[] } | { ok: false; segment: string } {
  const params: string[] = [];
  const parts: string[] = [];
  for (const segment of route.split("/")) {
    if (segment === "") continue;
    const whole = /^\[([^[\]]+)\]$/.exec(segment);
    if (whole && !whole[1]!.startsWith("...")) {
      params.push(whole[1]!);
      parts.push(`{${whole[1]}}`);
    } else if (/[[\]]/.test(segment)) {
      return { ok: false, segment };
    } else {
      parts.push(segment);
    }
  }
  const base = (opts.base ?? "/").replace(/\/+$/, "");
  const prefix = base === "" || base.startsWith("/") ? base : `/${base}`;
  let path = `${prefix}${parts.length > 0 ? `/${parts.join("/")}` : ""}`;
  if (path === "") path = "/";
  if (opts.trailingSlash && !path.endsWith("/") && !/\.[^/.]+$/.test(path)) path += "/";
  return { ok: true, path, params };
}

function endpointMethod(
  stated: FunctionToolMethod | undefined,
  handlers: string[],
  fieldPath: string,
  tool: string | undefined,
  node: EsNode | undefined,
): FunctionToolMethod {
  const exported = handlers.filter((name) => name !== "ALL");
  const answersAll = handlers.includes("ALL");
  const list = handlers.length > 0 ? handlers.join(", ") : "none";
  const at = `${fieldPath}.method`;
  if (stated !== undefined) {
    if (exported.includes(stated) || answersAll) return stated;
    throw new Refusal("MCP_TOOL_SCHEMA_INVALID", at, `\`method\` is "${stated}", but this file exports no \`${stated}\` handler (it exports: ${list}). Name a handler the file exports, or add \`export const ${stated}\`.`, node, tool);
  }
  if (exported.length === 1 && !answersAll) return exported[0] as FunctionToolMethod;
  if (handlers.length === 0) {
    throw new Refusal("MCP_TOOL_SCHEMA_INVALID", at, `This file exports no ${FUNCTION_TOOL_METHODS.join(", ")} or ALL handler, so the tool has no request to make. Export the handler the tool calls.`, node, tool);
  }
  throw new Refusal("MCP_TOOL_SCHEMA_INVALID", at, `State \`method\`: this file exports ${list}, so the tool's request is ambiguous.`, node, tool);
}

// ─── the extractor ───────────────────────────────────────────────────────────

function declarations(program: EsNode, endpoint: EndpointToolContext | undefined): FunctionToolSpec[] {
  const exports = moduleExports(program);
  const { tool, tools } = exports;
  if (!tool && !tools) return [];
  if (tool && tools) {
    const second = (tools.node.start as number) > (tool.node.start as number) ? "tools" : "tool";
    throw new Refusal("MCP_TOOL_SCHEMA_INVALID", second, "A file exports `tool` (one declaration) or `tools` (several, by name), never both. Move the single declaration into `tools`.", exports[second]!.node);
  }
  const exportName: ExportName = tool ? "tool" : "tools";
  const declared = (tool ?? tools)!;

  let pathParams: string[] | undefined;
  let endpointPath: string | undefined;
  let handlers: string[] = [];
  if (endpoint) {
    if (endpoint.prerendered) {
      throw Refusal.at(declared.node, {
        code: "MCP_TOOL_ROUTE_ELSEWHERE",
        field_path: exportName,
        message: `This endpoint is prerendered, so a static file answers \`${endpoint.route}\` and a tool call would never reach the handler. Add \`export const prerender = false\` to serve it on request, or remove the tool.`,
      });
    }
    const converted = endpointToolPath(endpoint.route, endpoint);
    if (!converted.ok) {
      throw Refusal.at(declared.node, {
        code: "MCP_TOOL_PATH_UNSUPPORTED",
        field_path: exportName,
        message: `The route \`${endpoint.route}\` has the segment \`${converted.segment}\`, which cannot be a tool's path: a tool names one request, so a parameter stands for one whole segment and a rest segment is not allowed. Declare the tool on an endpoint whose route has only \`[param]\` segments.`,
      });
    }
    endpointPath = converted.path;
    pathParams = converted.params;
    handlers = [...ENDPOINT_HANDLERS].filter((name) => exports.names.has(name));
  }

  if (!declared.init) throw new Refusal("MCP_TOOL_NOT_STATIC", exportName, declared.why ?? `\`${exportName}\` must be a literal object.`, declared.node);

  const lines = new Map<string, EsNode>();

  const finish = (value: unknown, fieldPath: string, name: string | undefined): FunctionToolSpec => {
    const entry = value as Record<string, unknown>;
    if (endpoint && entry && typeof entry === "object" && !Array.isArray(entry) && "path" in entry) {
      throw new Refusal("MCP_TOOL_SCHEMA_INVALID", `${fieldPath}.path`, `\`path\` is never written in an endpoint file: the tool's path is the endpoint's own route (\`${endpointPath}\`). Remove \`path\`.`, nodeAt(lines, `${fieldPath}.path`), name);
    }
    const checked = checkFunctionToolEntry(value, fieldPath, pathParams ? { pathParams } : {});
    if (!checked.ok) throw Refusal.at(nodeAt(lines, checked.problem.field_path) ?? declared.node, checked.problem, name);
    const { name: ownName, ...rest } = checked.tool;
    const toolName = name ?? ownName;
    if (!endpoint) return { ...(toolName !== undefined ? { name: toolName } : {}), ...rest };
    if (toolName === undefined) {
      throw new Refusal("MCP_TOOL_NAME_INVALID", `${fieldPath}.name`, "An endpoint's `tool` must state its `name` (a file's route is not a tool name). Add `name: \"…\"`, or use `tools = { name: { … } }`.", nodeAt(lines, fieldPath));
    }
    const method = endpointMethod(rest.method, handlers, fieldPath, toolName, nodeAt(lines, `${fieldPath}.method`) ?? nodeAt(lines, fieldPath));
    return {
      name: toolName,
      ...(rest.title !== undefined ? { title: rest.title } : {}),
      description: rest.description,
      input: rest.input,
      ...(rest.annotations !== undefined ? { annotations: rest.annotations } : {}),
      method,
      path: endpointPath!,
    };
  };

  if (exportName === "tool") {
    return [finish(literalValue(declared.init, "tool", lines), "tool", undefined)];
  }

  if (declared.init.type === "ArrayExpression") {
    throw new Refusal("MCP_TOOL_SCHEMA_INVALID", "tools", "`tools` must be an object whose keys are the tool names: `export const tools = { list_notes: { … } }`.", declared.init);
  }
  if (declared.init.type !== "ObjectExpression") {
    // Reports the variable, call or other form the same way a field would.
    literalValue(declared.init, "tools", lines);
    throw new Refusal("MCP_TOOL_SCHEMA_INVALID", "tools", "`tools` must be an object whose keys are the tool names.", declared.init);
  }
  const out: FunctionToolSpec[] = [];
  const seen = new Set<string>();
  lines.set("tools", declared.init);
  for (const prop of declared.init.properties as EsNode[]) {
    const name = propertyKey(prop, "tools");
    const fieldPath = `tools.${name}`;
    if (!isValidMcpToolName(name)) {
      throw new Refusal("MCP_TOOL_NAME_INVALID", fieldPath, `\`${name}\` is not a valid MCP tool name: 1 to 128 of A-Z, a-z, 0-9, \`_\`, \`-\` and \`.\`.`, prop, name);
    }
    if (seen.has(name)) {
      throw new Refusal("MCP_TOOL_NAME_DUPLICATE", fieldPath, `\`tools\` names \`${name}\` twice. A tool name is unique in a release.`, prop, name);
    }
    seen.add(name);
    if (prop.shorthand) throw new Refusal("MCP_TOOL_NOT_STATIC", fieldPath, `\`${name}\` refers to a variable; write the declaration inline.`, prop, name);
    let value: unknown;
    try {
      value = literalValue(prop.value as EsNode, fieldPath, lines);
    } catch (err) {
      if (err instanceof Refusal && err.tool === undefined) throw new Refusal(err.code, err.fieldPath, err.message, err.node, name);
      throw err;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value) && "name" in value) {
      throw new Refusal("MCP_TOOL_SCHEMA_INVALID", `${fieldPath}.name`, `Under \`tools\` the key is the tool's name; remove \`name\` from \`${name}\`.`, nodeAt(lines, `${fieldPath}.name`), name);
    }
    out.push(finish(value, fieldPath, name));
  }
  return out;
}

/**
 * Read the tools a source file declares, by parsing it. Returns the
 * declarations as release entries (`[]` when the file declares none), or the
 * one refusal an author has to fix, with its code, file, exact line when
 * there is one, and field path.
 *
 * A function's entry file: a single `tool` is one entry with the fields as
 * written; `tools` is one entry per key, the key as `name`. An Astro endpoint
 * file (`options.endpoint`): every entry carries `name`, `method` (the one
 * handler the file exports unless stated) and `path` (the endpoint's route).
 */
export function extractToolDeclarations(source: string, options: ExtractToolDeclarationsOptions = {}): ToolExtraction {
  const file = options.file ?? null;
  if (!mayDeclareTools(source)) return { ok: true, tools: [] };
  const parsed = readFile(source);
  if ("unreadable" in parsed) {
    const exported = plainlyExportsTools(source);
    if (exported === null) return { ok: true, tools: [] };
    return {
      ok: false,
      problem: {
        code: "MCP_TOOL_NOT_STATIC",
        message: `This file could not be parsed (${parsed.unreadable}), so its \`${exported}\` export cannot be read without running it. Keep the declaration in a plain JavaScript or TypeScript file: move JSX, decorators or other compiled syntax into a module this file imports.`,
        file,
        field_path: exported,
      },
    };
  }
  try {
    return { ok: true, tools: declarations(parsed.program, options.endpoint) };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    const line = parsed.exactLines ? (err.node?.loc?.start.line as number | undefined) : undefined;
    return {
      ok: false,
      problem: {
        code: err.code,
        message: err.message,
        file,
        ...(line !== undefined ? { line } : {}),
        field_path: err.fieldPath,
        ...(err.tool !== undefined ? { tool: err.tool } : {}),
      },
    };
  }
}

/**
 * The reader `@run402/sdk/node` installs: the tools one function's entry
 * source declares, or a {@link Run402DeployError} thrown before any request.
 */
export function liftFunctionTools(input: FunctionToolLiftInput): FunctionToolSpec[] {
  const extraction = extractToolDeclarations(input.source, { file: input.file });
  if (!extraction.ok) {
    throw toolDeclarationError(extraction.problem, { functionName: input.functionName, sourceField: input.sourceField });
  }
  const unnamed = extraction.tools.find((tool) => tool.name === undefined);
  if (unnamed && !isValidMcpToolName(input.functionName)) {
    throw toolDeclarationError(
      {
        code: "MCP_TOOL_NAME_INVALID",
        message: `A \`tool\` with no \`name\` is named after its function, and \`${input.functionName}\` is not a valid MCP tool name (1 to 128 of A-Z, a-z, 0-9, \`_\`, \`-\` and \`.\`). Add \`name: "…"\` to the declaration.`,
        file: input.file,
        field_path: "tool.name",
      },
      { functionName: input.functionName, sourceField: input.sourceField },
    );
  }
  return extraction.tools;
}
