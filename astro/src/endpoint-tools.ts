/**
 * Endpoint tools: an Astro endpoint the site already calls, declared as an
 * MCP tool beside its handler.
 *
 *   // src/pages/api/notes.ts
 *   export const tools = {
 *     list_notes: { method: "GET",  description: "…", input: { type: "object", … } },
 *     add_note:   { method: "POST", description: "…", input: { type: "object", … } },
 *   };
 *   export const GET: APIRoute = …;
 *   export const POST: APIRoute = …;
 *
 * Astro compiles every endpoint into one server bundle, so the declarations
 * are read here, at build, from each server-rendered endpoint's SOURCE file,
 * by parsing and never by running it. The result goes into
 * `dist/run402/adapter.json`, and `buildAstroReleaseSlice` puts it on the
 * `ssr` function's release entry as `tools`.
 *
 * There is one extractor, in `@run402/sdk/node`, the peer this package
 * already imports. It owns every rule (what a static literal is, which
 * method an endpoint's tool takes, how a route becomes a path) and every
 * code; this module only chooses the files, hands them over, and turns a
 * refusal into a build error with its file and line.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** One endpoint tool as `adapter.json` records it: the release entry's shape. */
export interface AdapterManifestTool {
  name: string;
  title?: string;
  description: string;
  input: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The endpoint's route, `[param]` written `{param}`, with the project's `base`. */
  path: string;
}

/** An endpoint route as recorded at `astro:routes:resolved`. */
export interface EndpointRouteRecord {
  /** Astro's route, e.g. `/api/notes/[note_id]`. */
  pattern: string;
  /** The source file, relative to the project root, e.g. `src/pages/api/notes/[note_id].ts`. */
  entrypoint: string;
  prerender: boolean;
  /** Astro's matcher for the route; tells whether it answers only with a trailing slash. */
  patternRegex?: RegExp;
}

interface ToolProblem {
  code: string;
  message: string;
  file: string | null;
  line?: number;
  field_path: string;
  tool?: string;
}

/** The part of `@run402/sdk/node` this module calls. */
export interface ToolExtractorModule {
  extractToolDeclarations?: (
    source: string,
    options: {
      file: string;
      endpoint: { route: string; base?: string; trailingSlash?: boolean; prerendered?: boolean };
    },
  ) => { ok: true; tools: AdapterManifestTool[] } | { ok: false; problem: ToolProblem };
}

/**
 * A tool declaration the build cannot carry. `code` is the code the SDK and
 * the gateway use for the same condition (`MCP_TOOL_NOT_STATIC`,
 * `MCP_TOOL_SCHEMA_INVALID`, `MCP_TOOL_NAME_INVALID`,
 * `MCP_TOOL_NAME_DUPLICATE`, `MCP_TOOL_ROUTE_ELSEWHERE`,
 * `MCP_TOOL_PATH_UNSUPPORTED`), or `R402_ASTRO_SDK_VERSION_TOO_OLD` when the
 * installed `@run402/sdk` cannot read declarations at all.
 */
export class Run402AstroToolDeclarationError extends Error {
  readonly code: string;
  readonly file: string;
  readonly line?: number;
  readonly fieldPath?: string;
  readonly tool?: string;
  readonly docs: string;

  constructor(opts: { code: string; message: string; file: string; line?: number; fieldPath?: string; tool?: string }) {
    const where = opts.line !== undefined ? `${opts.file}:${opts.line}` : opts.file;
    super(`[${opts.code}] ${opts.message} (${where}${opts.fieldPath ? `, ${opts.fieldPath}` : ""})`);
    this.name = "Run402AstroToolDeclarationError";
    this.code = opts.code;
    this.file = opts.file;
    if (opts.line !== undefined) this.line = opts.line;
    if (opts.fieldPath !== undefined) this.fieldPath = opts.fieldPath;
    if (opts.tool !== undefined) this.tool = opts.tool;
    this.docs = `https://docs.run402.com/errors#${opts.code}`;
  }
}

/** Cheap pre-check, the extractor's own: a file with no `export` and no `tool` word declares none. */
function mayDeclareTools(source: string): boolean {
  return /\bexport\b/.test(source) && /\btools?\b/.test(source);
}

/**
 * Whether the route answers only with a trailing slash. Astro's own matcher
 * decides (it already accounts for `trailingSlash` and file extensions); the
 * config value is the fallback when no matcher was recorded.
 */
function needsTrailingSlash(route: EndpointRouteRecord, trailingSlash: string | undefined): boolean {
  if (route.patternRegex instanceof RegExp) {
    const probe = route.pattern.replace(/\[[^\]]+\]/g, "x");
    if (route.patternRegex.test(probe)) return false;
    if (route.patternRegex.test(`${probe}/`)) return true;
  }
  return trailingSlash === "always" && !/\.[^/.]+$/.test(route.pattern);
}

async function loadSdkExtractor(): Promise<ToolExtractorModule> {
  // The SDK is an optional peer: a variable specifier keeps it out of this
  // package's own module graph until an endpoint actually declares a tool.
  const sdkModuleId = "@run402/sdk/node";
  return (await import(/* @vite-ignore */ sdkModuleId)) as ToolExtractorModule;
}

export interface LiftEndpointToolsOptions {
  /** The project root; endpoint files are read relative to it. */
  root: string;
  /** Astro's `base`. */
  base?: string;
  /** Astro's `trailingSlash`. */
  trailingSlash?: string;
  /** Every project endpoint route, prerendered ones included. */
  routes: EndpointRouteRecord[];
  /** Test seam: the module that holds `extractToolDeclarations`. Default `@run402/sdk/node`. */
  loadExtractor?: () => Promise<ToolExtractorModule>;
}

/**
 * Read `tool` / `tools` from every endpoint file and return the tools of the
 * build, in route order then source order. Throws
 * {@link Run402AstroToolDeclarationError} on the first declaration that cannot
 * be carried: the build fails, naming the file and the line.
 */
export async function liftEndpointTools(opts: LiftEndpointToolsOptions): Promise<AdapterManifestTool[]> {
  const seen = new Set<string>();
  const candidates: Array<{ route: EndpointRouteRecord; source: string }> = [];
  const routes = [...opts.routes].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  for (const route of routes) {
    const key = `${route.entrypoint}\u0000${route.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let source: string;
    try {
      source = await readFile(path.resolve(opts.root, route.entrypoint), "utf-8");
    } catch {
      // A route with no file of its own on disk (a virtual entrypoint) declares nothing.
      continue;
    }
    if (mayDeclareTools(source)) candidates.push({ route, source });
  }
  if (candidates.length === 0) return [];

  let extract: ToolExtractorModule["extractToolDeclarations"];
  try {
    extract = (await (opts.loadExtractor ?? loadSdkExtractor)()).extractToolDeclarations;
  } catch {
    extract = undefined;
  }
  if (typeof extract !== "function") {
    throw new Run402AstroToolDeclarationError({
      code: "R402_ASTRO_SDK_VERSION_TOO_OLD",
      message:
        "This endpoint may declare an MCP tool, and reading the declaration needs a `@run402/sdk` that exports " +
        "`extractToolDeclarations` from `@run402/sdk/node`. Install or upgrade it: `npm install @run402/sdk@latest`.",
      file: candidates[0]!.route.entrypoint,
    });
  }

  const tools: AdapterManifestTool[] = [];
  const owners = new Map<string, string>();
  for (const { route, source } of candidates) {
    const result = extract(source, {
      file: route.entrypoint,
      endpoint: {
        route: route.pattern,
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        trailingSlash: needsTrailingSlash(route, opts.trailingSlash),
        prerendered: route.prerender,
      },
    });
    if (!result.ok) {
      const p = result.problem;
      throw new Run402AstroToolDeclarationError({
        code: p.code,
        message: p.message,
        file: p.file ?? route.entrypoint,
        ...(p.line !== undefined ? { line: p.line } : {}),
        fieldPath: p.field_path,
        ...(p.tool !== undefined ? { tool: p.tool } : {}),
      });
    }
    for (const tool of result.tools) {
      const first = owners.get(tool.name);
      if (first !== undefined) {
        throw new Run402AstroToolDeclarationError({
          code: "MCP_TOOL_NAME_DUPLICATE",
          message:
            first === route.entrypoint
              ? `Two tools are named \`${tool.name}\` in this file. A tool name is unique in a release; rename one.`
              : `Two tools are named \`${tool.name}\`: ${first} declares one and so does this file. A tool name is unique in a release; rename one.`,
          file: route.entrypoint,
          tool: tool.name,
        });
      }
      owners.set(tool.name, route.entrypoint);
      tools.push(tool);
    }
  }
  return tools;
}
