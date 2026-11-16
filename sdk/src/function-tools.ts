/**
 * MCP tools on a function's release entry (`functions.<name>.tools`).
 *
 * A function file or an Astro endpoint file declares its tools beside the
 * handler, as static literals:
 *
 *   export const tool  = { description: "…", input: { type: "object", … } };
 *   export const tools = { list_notes: { … }, add_note: { … } };
 *
 * Deploy tooling reads the export by parsing, never by running it (the Node
 * extractor, `node/tool-declarations.ts`), and carries it in the release. The
 * gateway takes a function's tools only from its release entry: an omitted
 * `tools` means none, as with `triggers`.
 *
 * This module is the isomorphic half: the rules one entry obeys (shared by
 * the extractor and by the spec check for `tools` passed as data), the
 * refusal's shape, the error a deploy throws for it, and the slot the Node
 * entry point installs its source reader into.
 */

import { Run402DeployError } from "./errors.js";
import { FUNCTION_TOOL_METHODS } from "./namespaces/deploy.types.js";
import type { FunctionToolAnnotations, FunctionToolMethod, FunctionToolSpec } from "./namespaces/deploy.types.js";

/** Codes a tool declaration is refused with before any request, and by the gateway at plan with HTTP 422. */
export type McpToolErrorCode =
  | "MCP_TOOL_NOT_STATIC"
  | "MCP_TOOL_SCHEMA_INVALID"
  | "MCP_TOOL_NAME_INVALID"
  | "MCP_TOOL_NAME_DUPLICATE"
  | "MCP_TOOL_ROUTE_ELSEWHERE"
  | "MCP_TOOL_PATH_UNSUPPORTED";

/** Why a tool declaration is refused, as data. */
export interface ToolDeclarationProblem {
  code: McpToolErrorCode;
  message: string;
  /** The source file as the caller named it; null for an inline source or for `tools` passed as data. */
  file: string | null;
  /** 1-based line in `file`. Present only when it is exact. */
  line?: number;
  /** Where in the export or the spec, e.g. `tools.add_note.input.type`. */
  field_path: string;
  /** The tool's name, when the declaration got far enough to have one. */
  tool?: string;
}

export const MCP_TOOL_DESCRIPTION_MAX = 1024;
export const MCP_TOOL_TITLE_MAX = 128;
/** Serialized size ceiling for one declaration (description plus schema). */
export const MCP_TOOL_DECLARATION_MAX_BYTES = 64 * 1024;

const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_ANNOTATION_KEYS: ReadonlyArray<keyof FunctionToolAnnotations> = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
];
const TOOL_ENTRY_FIELDS = new Set(["name", "title", "description", "input", "annotations", "method", "path"]);

/** MCP tool names: 1 to 128 of `A-Z a-z 0-9 _ - .`. */
export function isValidMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_RE.test(name);
}

type EntryProblem = Pick<ToolDeclarationProblem, "code" | "message" | "field_path">;

export type FunctionToolEntryCheck =
  | { ok: true; tool: FunctionToolSpec }
  | { ok: false; problem: EntryProblem };

function join(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Split a tool path into its `{param}` names. A `{param}` stands for one whole
 * path segment; a wildcard, a rest segment, or a parameter that is only part
 * of a segment has no tool binding.
 */
export function toolPathParams(path: string): { ok: true; params: string[] } | { ok: false; code: "MCP_TOOL_SCHEMA_INVALID" | "MCP_TOOL_PATH_UNSUPPORTED"; message: string } {
  if (!path.startsWith("/")) {
    return { ok: false, code: "MCP_TOOL_SCHEMA_INVALID", message: "`path` must start with `/`." };
  }
  if (/[?#\s]/.test(path)) {
    return { ok: false, code: "MCP_TOOL_SCHEMA_INVALID", message: "`path` is a path only: no query string, fragment or whitespace." };
  }
  const params: string[] = [];
  for (const segment of path.split("/")) {
    if (!/[{}*]/.test(segment)) continue;
    const whole = /^\{([^{}/*]+)\}$/.exec(segment);
    if (!whole || whole[1]!.startsWith("...")) {
      return {
        ok: false,
        code: "MCP_TOOL_PATH_UNSUPPORTED",
        message: `The path segment \`${segment}\` cannot be a tool's path: a tool names one request, so a \`{param}\` stands for one whole segment and a wildcard or rest segment is not allowed.`,
      };
    }
    if (params.includes(whole[1]!)) {
      return { ok: false, code: "MCP_TOOL_SCHEMA_INVALID", message: `\`path\` names \`{${whole[1]}}\` twice.` };
    }
    params.push(whole[1]!);
  }
  return { ok: true, params };
}

/** Each `{param}` of the path must be a required `string` or `integer` property of `input`. */
function checkPathParams(input: Record<string, unknown>, params: readonly string[], fieldPath: string): EntryProblem | null {
  if (params.length === 0) return null;
  const properties = isPlainObject(input.properties) ? input.properties : {};
  const required = Array.isArray(input.required) ? input.required : [];
  for (const param of params) {
    const property = properties[param];
    if (!isPlainObject(property)) {
      return {
        code: "MCP_TOOL_SCHEMA_INVALID",
        field_path: join(fieldPath, `input.properties.${param}`),
        message: `The path parameter \`{${param}}\` must be a property of \`input\`: add \`${param}: { type: "string" }\` to \`input.properties\` and \`"${param}"\` to \`input.required\`.`,
      };
    }
    if (typeof property.type === "string" && property.type !== "string" && property.type !== "integer") {
      return {
        code: "MCP_TOOL_SCHEMA_INVALID",
        field_path: join(fieldPath, `input.properties.${param}.type`),
        message: `The path parameter \`{${param}}\` must be a \`string\` or an \`integer\` in \`input\` (it fills one path segment).`,
      };
    }
    if (!required.includes(param)) {
      return {
        code: "MCP_TOOL_SCHEMA_INVALID",
        field_path: join(fieldPath, "input.required"),
        message: `The path parameter \`{${param}}\` must be required: add \`"${param}"\` to \`input.required\`.`,
      };
    }
  }
  return null;
}

/**
 * Check one tool entry, already a plain value, against the rules every
 * carrier shares, and return it with its fields in a fixed order.
 * `pathParams` overrides the parameters read from `path` (an Astro endpoint's
 * path is its route, never a field of the declaration).
 */
export function checkFunctionToolEntry(
  value: unknown,
  fieldPath: string,
  opts: { pathParams?: readonly string[] } = {},
): FunctionToolEntryCheck {
  const fail = (code: McpToolErrorCode, at: string, message: string): FunctionToolEntryCheck => ({
    ok: false,
    problem: { code, field_path: at, message },
  });
  const invalid = (at: string, message: string): FunctionToolEntryCheck => fail("MCP_TOOL_SCHEMA_INVALID", at, message);

  if (!isPlainObject(value)) return invalid(fieldPath, "A tool declaration must be an object.");
  for (const key of Object.keys(value)) {
    if (!TOOL_ENTRY_FIELDS.has(key)) {
      return invalid(join(fieldPath, key), `Unknown field \`${key}\`; a tool declares description, input, title, annotations, name, method and path.`);
    }
  }

  const { description, title, input, annotations, name, method, path } = value;
  if (typeof description !== "string" || description.trim().length === 0) {
    return invalid(join(fieldPath, "description"), "`description` must be a non-empty string: it is what tells an assistant when to call the tool.");
  }
  if (description.length > MCP_TOOL_DESCRIPTION_MAX) {
    return invalid(join(fieldPath, "description"), `\`description\` must be at most ${MCP_TOOL_DESCRIPTION_MAX} characters (it is ${description.length}).`);
  }
  if (title !== undefined && (typeof title !== "string" || title.length === 0 || title.length > MCP_TOOL_TITLE_MAX)) {
    return invalid(join(fieldPath, "title"), `\`title\` must be a string of 1 to ${MCP_TOOL_TITLE_MAX} characters.`);
  }
  if (!isPlainObject(input)) {
    return invalid(join(fieldPath, "input"), "`input` must be a JSON Schema object: `{ type: \"object\", properties: { … } }`.");
  }
  if (input.type !== "object") {
    return invalid(join(fieldPath, "input.type"), "`input.type` must be \"object\": a tool's arguments are a JSON object.");
  }

  let cleanAnnotations: FunctionToolAnnotations | undefined;
  if (annotations !== undefined) {
    if (!isPlainObject(annotations)) return invalid(join(fieldPath, "annotations"), "`annotations` must be an object.");
    cleanAnnotations = {};
    for (const [key, hint] of Object.entries(annotations)) {
      if (!(TOOL_ANNOTATION_KEYS as readonly string[]).includes(key)) {
        return invalid(join(fieldPath, `annotations.${key}`), `Unknown annotation \`${key}\`; allowed: ${TOOL_ANNOTATION_KEYS.join(", ")}.`);
      }
      if (typeof hint !== "boolean") {
        return invalid(join(fieldPath, `annotations.${key}`), `\`annotations.${key}\` must be true or false.`);
      }
      cleanAnnotations[key as keyof FunctionToolAnnotations] = hint;
    }
  }

  if (name !== undefined && (typeof name !== "string" || !isValidMcpToolName(name))) {
    return fail("MCP_TOOL_NAME_INVALID", join(fieldPath, "name"), `\`name\` must be a valid MCP tool name: 1 to 128 of A-Z, a-z, 0-9, \`_\`, \`-\` and \`.\`.`);
  }
  if (method !== undefined && !(FUNCTION_TOOL_METHODS as readonly unknown[]).includes(method)) {
    return invalid(join(fieldPath, "method"), `\`method\` must be one of ${FUNCTION_TOOL_METHODS.join(", ")}, in upper case.`);
  }

  let params = opts.pathParams;
  if (path !== undefined) {
    if (typeof path !== "string") return invalid(join(fieldPath, "path"), "`path` must be a string such as `/api/notes/{note_id}`.");
    const parsed = toolPathParams(path);
    if (!parsed.ok) return fail(parsed.code, join(fieldPath, "path"), parsed.message);
    params = params ?? parsed.params;
  }
  const paramProblem = checkPathParams(input, params ?? [], fieldPath);
  if (paramProblem) return { ok: false, problem: paramProblem };

  const tool: FunctionToolSpec = {
    ...(name !== undefined ? { name: name as string } : {}),
    ...(title !== undefined ? { title: title as string } : {}),
    description,
    input,
    ...(cleanAnnotations ? { annotations: cleanAnnotations } : {}),
    ...(method !== undefined ? { method: method as FunctionToolMethod } : {}),
    ...(path !== undefined ? { path: path as string } : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(tool)).byteLength;
  if (bytes > MCP_TOOL_DECLARATION_MAX_BYTES) {
    return invalid(fieldPath, `A tool declaration must serialize to at most ${MCP_TOOL_DECLARATION_MAX_BYTES} bytes (this one is ${bytes}).`);
  }
  return { ok: true, tool };
}

/** One group of tools and where it came from: a function of a spec, or a source file of a build. */
export interface ToolNameGroup {
  /** The function name or the file, as the refusal should name it. */
  owner: string;
  tools: ReadonlyArray<Pick<FunctionToolSpec, "name">>;
  /** The name a tool with no `name` takes (a function file's single `tool`: the function name). */
  defaultName?: string;
}

/** The first tool name two tools of one build share, with the two owners in the order given. */
export function findDuplicateToolName(groups: readonly ToolNameGroup[]): { name: string; owners: [string, string] } | null {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const tool of group.tools) {
      const name = tool.name ?? group.defaultName;
      if (name === undefined) continue;
      const first = seen.get(name);
      if (first !== undefined) return { name, owners: [first, group.owner] };
      seen.set(name, group.owner);
    }
  }
  return null;
}

/** `src/pages/api/notes.ts:12`, `functions.replace.api.source:12`, or just the name when there is no exact line. */
export function toolProblemLocation(problem: Pick<ToolDeclarationProblem, "file" | "line">, fallback?: string): string | null {
  const where = problem.file ?? fallback ?? null;
  if (where === null) return null;
  return problem.line !== undefined ? `${where}:${problem.line}` : where;
}

/**
 * The error a deploy throws for a refused tool declaration, before any
 * request: the gateway's code for the same condition, `resource`
 * `functions.<function>.tools[.<tool>]`, the file, line and field path under
 * `details`, and an `edit_request` next action.
 */
export function toolDeclarationError(
  problem: ToolDeclarationProblem,
  where: { functionName: string; sourceField?: string; functions?: string[] },
): Run402DeployError {
  const resource = problem.tool !== undefined
    ? `functions.${where.functionName}.tools.${problem.tool}`
    : `functions.${where.functionName}.tools`;
  const location = toolProblemLocation(problem, where.sourceField);
  const message = location ? `${problem.message} (${location}, ${problem.field_path})` : `${problem.message} (${problem.field_path})`;
  const details = {
    function: where.functionName,
    ...(where.functions ? { functions: where.functions } : {}),
    ...(problem.tool !== undefined ? { tool: problem.tool } : {}),
    file: problem.file,
    // An inline source has no file: name the spec field that holds it.
    ...(problem.file === null && where.sourceField ? { source_field: where.sourceField } : {}),
    ...(problem.line !== undefined ? { line: problem.line } : {}),
    field_path: problem.field_path,
  };
  return new Run402DeployError(message, {
    code: problem.code,
    phase: "validate",
    resource,
    retryable: false,
    fix: problem.file !== null
      ? {
          action: "edit_file",
          path: problem.file,
          ...(problem.line !== undefined ? { line: problem.line } : {}),
          field_path: problem.field_path,
        }
      : { action: "set_field", path: where.sourceField ?? resource, field_path: problem.field_path },
    body: {
      code: problem.code,
      message,
      details,
      next_actions: [
        {
          type: "edit_request",
          ...(problem.file !== null ? { file: problem.file } : {}),
          ...(problem.line !== undefined ? { line: problem.line } : {}),
          field_path: problem.field_path,
          why: problem.file !== null
            ? "Edit the tool declaration in that file, then deploy again. Nothing was sent."
            : "Edit the function's tools, then deploy again. Nothing was sent.",
        },
      ],
    },
    context: "reading tool declarations",
  });
}

/** What the installed reader is given: one function's entry source, as text. */
export interface FunctionToolLiftInput {
  functionName: string;
  source: string;
  /** The source's path on disk, when it has one. */
  file: string | null;
  /** The spec field the source came from, e.g. `functions.replace.api.source`. */
  sourceField: string;
}

/** Reads the tools a function's entry source declares; throws {@link Run402DeployError} on a refused declaration. */
export type FunctionToolLifter = (input: FunctionToolLiftInput) => FunctionToolSpec[];

let installedLifter: FunctionToolLifter | null = null;

/**
 * Install the reader `apply` calls for every function source it reads when
 * the entry names no `tools`. Reading a declaration means parsing JavaScript,
 * which is Node-only, so `@run402/sdk/node` installs it when it loads; with
 * none installed, `tools` is forwarded only when the caller passes it.
 */
export function installFunctionToolLifter(lifter: FunctionToolLifter | null): void {
  installedLifter = lifter;
}

export function installedFunctionToolLifter(): FunctionToolLifter | null {
  return installedLifter;
}
