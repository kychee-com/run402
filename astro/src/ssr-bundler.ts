/**
 * `@run402/astro/ssr-bundler` (internal) — esbuild wrapper that turns
 * Astro's multi-file server output (`dist/run402/server/entry.mjs` +
 * its chunks + node-modules deps) into a single bundled ESM string ready
 * to ship as a `FunctionSpec.source`.
 *
 * Why bundling matters: the Run402 gateway currently rejects multi-file
 * function specs ("multi-file function spec (files + entrypoint) is not
 * yet supported by the gateway; bundle locally with esbuild and pass
 * `source` instead" — see `validateFunctionSpec` in apply-v1). The SSR
 * adapter emits multi-file Astro output; the release-slice helper
 * collapses that into a single file here.
 *
 * Bundle config:
 *   - format: 'esm', target: 'node22', platform: 'node' — match the
 *     Lambda runtime the gateway provisions for class:'ssr' functions.
 *   - bundle: true — collapse every reachable import.
 *   - external: Node built-ins (with and without `node:` prefix) +
 *     `@run402/functions` (the gateway aliases this at runtime to its
 *     installed public Core package via esbuild's `alias`; bundling our
 *     own copy would shadow that contract).
 *   - define `process.env.NODE_ENV` as the build's own `NODE_ENV`
 *     (recorded in `adapter.json` by the adapter). CommonJS packages
 *     such as react and react-dom choose their development or
 *     production build on that value; defining it lets esbuild drop the
 *     unused branch, so a production build ships only production code.
 *     It must match the build: a development build compiles JSX against
 *     `react/jsx-dev-runtime`, whose production module has no `jsxDEV`.
 *   - minify: true by default — the function's source counts against
 *     the tier's code-size cap, and parsing less code shortens cold
 *     start. `minify: false` keeps the output readable for debugging.
 *   - charset: 'utf8' — non-ASCII text (a dataset in Hebrew, say) stays
 *     as UTF-8 instead of a six-byte \uXXXX escape per character, which
 *     can nearly double the source a non-English site ships.
 *   - keepNames: true — preserves component / handler names in stack
 *     traces, minified or not.
 *   - banner: createRequire shim — esbuild's ESM wrapper can still
 *     contain CommonJS dependency code that calls require("util") or
 *     another Node builtin. Node ESM has no ambient require, so provide
 *     one scoped to the bundled module URL.
 */

import { build, type BuildOptions } from "esbuild";

/**
 * Node built-in modules that should always be external. The Lambda
 * runtime resolves these natively. esbuild also has a `--platform=node`
 * default external list that covers most of these, but we declare them
 * explicitly so the behavior is deterministic across esbuild versions.
 */
const NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

const RUN402_PLATFORM_EXTERNALS = [
  // `@run402/functions` is bundled at gateway-deploy time via the
  // gateway's own esbuild alias to its installed public Core package —
  // bundling our own copy here would shadow that runtime contract. See
  // AGENTS.md: "the gateway bundles its installed copy of this library
  // into every function zip via esbuild alias at deploy time — it is
  // platform code, not a user dependency."
  "@run402/functions",
];

const NODE_ESM_REQUIRE_SHIM =
  `import { createRequire as __run402CreateRequire } from "node:module";\n` +
  `const require = __run402CreateRequire(import.meta.url);\n`;

export interface BundleSsrOptions {
  /** Absolute path to the Astro server output directory, e.g.
   *  `<projectRoot>/dist/run402/server`. */
  serverDir: string;
  /** Filename within `serverDir` that is the entrypoint, e.g. `"entry.mjs"`. */
  entrypoint: string;
  /** Optional extra externals (passed to esbuild verbatim). */
  externalAdditions?: readonly string[];
  /**
   * `NODE_ENV` the Astro build ran under (`adapter.json`'s `nodeEnv`).
   * When set, `process.env.NODE_ENV` is defined as this value in the
   * bundle. When absent (a manifest from an adapter that did not record
   * it), the bundle reads `NODE_ENV` at runtime.
   */
  nodeEnv?: string;
  /** Minify the bundle. Defaults to `true`. */
  minify?: boolean;
}

export interface BundleSsrResult {
  /** The bundled ESM source as a UTF-8 string. Ready to ship as
   *  `FunctionSpec.source` — `ContentSource` accepts string directly. */
  code: string;
  /** UTF-8 byte length of `code`: the size the gateway checks against
   *  the tier's per-function code-size cap. */
  byteLength: number;
  /** esbuild warnings, if any. Surfaced to callers who want to log. */
  warnings: { text: string; location?: { file?: string; line?: number } | null }[];
}

/**
 * Bundle the Astro SSR entry into a single ESM file.
 *
 * Throws if esbuild itself errors (e.g. unresolved import that's neither
 * a Node built-in nor a `@run402/*` platform module). The caller is
 * expected to surface those errors with a structured envelope.
 */
export async function bundleSsrEntry(
  opts: BundleSsrOptions,
): Promise<BundleSsrResult> {
  const externals = [
    // node: prefixed and bare-name versions. esbuild treats them as
    // distinct strings — declaring both removes a class of "unresolved
    // node:fs" misses on some Astro configurations.
    ...NODE_BUILTINS,
    ...NODE_BUILTINS.map((name) => `node:${name}`),
    ...RUN402_PLATFORM_EXTERNALS,
    ...(opts.externalAdditions ?? []),
  ];

  const buildOpts: BuildOptions = {
    entryPoints: [`${opts.serverDir}/${opts.entrypoint}`],
    bundle: true,
    format: "esm",
    target: "node22",
    platform: "node",
    external: externals,
    write: false,
    minify: opts.minify ?? true,
    charset: "utf8",
    keepNames: true,
    ...(opts.nodeEnv !== undefined
      ? { define: { "process.env.NODE_ENV": JSON.stringify(opts.nodeEnv) } }
      : {}),
    banner: {
      js: NODE_ESM_REQUIRE_SHIM,
    },
    sourcemap: false,
    // Astro server bundles use top-level await for prerender data. Node
    // 22 supports it natively at module top-level for ESM, so we leave
    // it on. esbuild's default would split if needed; we just trust
    // Node's loader.
    legalComments: "inline",
    // Resolve packages from the server dir's enclosing node_modules so
    // the bundler sees Astro's installed deps (and any user-installed
    // packages reachable from the entry). esbuild walks `node_modules`
    // up from the entryPoint by default, but absoluteWorkingDir makes
    // the resolution deterministic across cwds.
    absWorkingDir: opts.serverDir,
  };

  const result = await build(buildOpts);

  const out = result.outputFiles?.[0];
  if (!out) {
    throw new Error(
      `Run402 SSR bundling produced no output. esbuild may have silently failed against ` +
        `${opts.serverDir}/${opts.entrypoint}.`,
    );
  }

  return {
    code: out.text,
    byteLength: out.contents.byteLength,
    warnings: result.warnings.map((w) => ({
      text: w.text,
      location: w.location
        ? { file: w.location.file, line: w.location.line }
        : null,
    })),
  };
}
