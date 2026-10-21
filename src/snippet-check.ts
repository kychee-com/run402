/**
 * The type check `run` makes before any call.
 *
 * The snippet, wrapped exactly as the sandbox wraps it (`WRAP_HEAD` /
 * `WRAP_TAIL` from `./sandbox.ts`), is type-checked against the declarations
 * of the client the host replays against (`NodeRun402`, from the SDK
 * declarations packaged beside this server in `sdk/dist`), with only the
 * bindings the sandbox installs declared: `r`, `console`, and the builtins.
 * No DOM and no Node types, so `fetch` and `process` stay undeclared, as they
 * are in the sandbox. `strict`, with `noImplicitAny` off: snippets are scratch
 * code, and an untyped helper parameter is not a mistake.
 *
 * The checker is TypeScript 7's API (`@typescript/native/unstable/async`): one
 * native child process per server, started on the first check and kept warm,
 * so a check costs milliseconds. Checks are serialized, because each one
 * rewrites the one snippet file the checker's project holds.
 *
 * The check refuses only what the sandbox cannot run as written. Two shapes
 * type-check badly yet run: an undeclared name read under `typeof` (the
 * sandbox's global-inventory probe), and a member reached through an
 * un-awaited `r` chain, which the replay resolves by awaiting every
 * intermediate. Both are exempt.
 *
 * A missing member on an SDK object (an instance of an SDK class, or `r`
 * itself) is reported with the replay's own `did_you_mean` search, run on
 * types instead of objects: the receiver's closest public members, else where
 * a member of that exact name lives (the receiver's namespaces, then the root,
 * then the root's namespaces). The checker never calls the SDK.
 *
 * When the checker cannot start or answer, the check is skipped and the
 * snippet runs unchecked: a checker fault must not take `run` away.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closestMembers, sdkPrivateMembers, UnknownMember } from "./sandbox-proxy.js";
import { shiftColumn, WRAP_HEAD, WRAP_TAIL } from "./sandbox.js";

/** Starting the checker (spawn, load the SDK's declarations) may take this long before the check is skipped. */
export const SNIPPET_CHECK_START_TIMEOUT_MS = 15_000;
/** One check may take this long before it is skipped. */
export const SNIPPET_CHECK_TIMEOUT_MS = 5_000;

export interface SnippetDiagnostic {
  /** 1-based, in the snippet's own coordinates. */
  line: number;
  column: number;
  /** TypeScript's code, e.g. `TS2551`. */
  code: string;
  message: string;
}

export type SnippetCheck =
  | { status: "passed" }
  | { status: "skipped"; reason: string }
  | {
    status: "refused";
    /** Every error diagnostic, in source order. */
    diagnostics: SnippetDiagnostic[];
    /** Set when the first diagnostic is a member an SDK object does not have. */
    unknownMember?: UnknownMember;
  };

// ─── the TypeScript 7 API, as this module uses it ────────────────────────────

/* The API is labeled unstable, so this module names only the slice it reads. */
interface TsType {
  readonly id: number;
  getSymbol(): Promise<TsSymbol | undefined>;
}
interface TsSymbol {
  readonly name: string;
  readonly flags: number;
}
interface TsDiagnostic {
  readonly pos: number;
  readonly code: number;
  readonly category: number;
  readonly text: string;
  readonly messageChain?: readonly TsDiagnostic[];
}
interface TsNode {
  readonly kind: number;
  readonly parent: TsNode;
  readonly expression?: TsNode;
  readonly name?: TsNode & { readonly text: string };
  readonly text?: string;
}
interface TsChecker {
  getTypeAtLocation(node: TsNode): Promise<TsType | undefined>;
  getPropertiesOfType(type: TsType): Promise<readonly TsSymbol[]>;
  getTypeOfSymbol(symbols: readonly TsSymbol[]): Promise<(TsType | undefined)[]>;
  getTypeOfSymbol(symbol: TsSymbol): Promise<TsType | undefined>;
  getTypeArguments(type: TsType): Promise<readonly TsType[]>;
  resolveName(name: string, meaning: number, location?: { document: string; position: number }): Promise<TsSymbol | undefined>;
}
interface TsProject {
  readonly program: {
    getSourceFile(file: string): Promise<unknown>;
    getSyntacticDiagnostics(file: string): Promise<readonly TsDiagnostic[]>;
    getSemanticDiagnostics(file: string): Promise<readonly TsDiagnostic[]>;
  };
  readonly checker: TsChecker;
}
interface TsApi {
  updateSnapshot(params: unknown): Promise<{ getProject(configFileName: string): TsProject | undefined }>;
  close(): Promise<void>;
}
interface TsAst {
  getTokenAtPosition(sourceFile: unknown, position: number): TsNode;
  isPropertyAccessExpression(node: TsNode): boolean;
  isCallExpression(node: TsNode): boolean;
  isElementAccessExpression(node: TsNode): boolean;
  isParenthesizedExpression(node: TsNode): boolean;
  isNonNullExpression(node: TsNode): boolean;
  isAwaitExpression(node: TsNode): boolean;
  isTypeOfExpression(node: TsNode): boolean;
  isIdentifier(node: TsNode): boolean;
}

/** TypeScript's `DiagnosticCategory.Error`, `SymbolFlags.Class`, and `SymbolFlags.Value`. */
const CATEGORY_ERROR = 1;
const SYMBOL_CLASS = 32;
const SYMBOL_VALUE = 111551;
/** "Property 'x' does not exist on type 'T'" and its "Did you mean" form. */
const MISSING_PROPERTY = new Set([2339, 2551]);

// ─── the checker process ─────────────────────────────────────────────────────

interface Checker {
  api: TsApi;
  ast: TsAst;
  dir: string;
  file: string;
  config: string;
}

/** Starts the checker. Replaced in tests to exercise a checker that cannot start. */
type StartChecker = () => Promise<Checker>;
let startChecker: StartChecker = startTypeScriptChecker;
let checker: Promise<Checker> | null = null;
/** Checks run one at a time: each rewrites the one snippet file. */
let queue: Promise<unknown> = Promise.resolve();

/** The SDK declarations this server replays against, packaged beside it (`src/` and `dist/` both sit next to `sdk/`). */
function sdkNodeDeclarations(): string {
  return fileURLToPath(new URL("../sdk/dist/node/index.d.ts", import.meta.url));
}

/** The sandbox's bindings (`SANDBOX_GLOBALS` in `./sandbox.ts`) beyond what the ECMAScript library declares. */
function globalsSource(sdkDeclarations: string): string {
  const sdk = JSON.stringify(sdkDeclarations.replace(/\\/g, "/").replace(/\.d\.ts$/, ".js"));
  return [
    `declare const r: import(${sdk}).NodeRun402;`,
    "declare const console: { log(...data: unknown[]): void; info(...data: unknown[]): void; warn(...data: unknown[]): void; error(...data: unknown[]): void };",
    "declare const crypto: { randomUUID(): string };",
    "declare function structuredClone<T>(value: T): T;",
    "declare const InternalError: ErrorConstructor;",
    "declare class URL { constructor(input: string, base?: string); static canParse(input: string, base?: string): boolean; readonly href: string; readonly origin: string; readonly protocol: string; readonly username: string; readonly password: string; readonly host: string; readonly hostname: string; readonly port: string; readonly pathname: string; readonly search: string; readonly hash: string; toString(): string; toJSON(): string }",
    "declare class TextEncoder { readonly encoding: string; encode(input?: string): Uint8Array }",
    "declare class TextDecoder { constructor(label?: string); readonly encoding: string; decode(input?: ArrayBuffer | ArrayBufferView): string }",
    "",
  ].join("\n");
}

async function startTypeScriptChecker(): Promise<Checker> {
  const sdk = sdkNodeDeclarations();
  if (!existsSync(sdk)) throw new Error(`the SDK declarations are missing (${sdk})`);
  const { API } = await import("@typescript/native/unstable/async") as unknown as { API: new (options: { cwd: string }) => TsApi };
  const ast = await import("@typescript/native/unstable/ast") as unknown as TsAst;
  const dir = mkdtempSync(join(tmpdir(), "run402-mcp-check-"));
  const file = join(dir, "snippet.ts");
  const config = join(dir, "tsconfig.json");
  writeFileSync(join(dir, "globals.d.ts"), globalsSource(sdk));
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "ESNext", lib: ["ESNext"], module: "ESNext", moduleResolution: "bundler",
      strict: true, noImplicitAny: false, noEmit: true, skipLibCheck: true, types: [],
    },
    files: ["globals.d.ts", "snippet.ts"],
  }));
  writeFileSync(file, `${WRAP_HEAD}${WRAP_TAIL}`);
  const api = new API({ cwd: dir });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error("the checker opened no project");
    await project.program.getSemanticDiagnostics(file);
  } catch (err) {
    await api.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { api, ast, dir, file, config };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Stop the checker process. The next check starts a new one. */
export async function closeSnippetChecker(): Promise<void> {
  const current = checker;
  checker = null;
  if (!current) return;
  try {
    const c = await current;
    await c.api.close().catch(() => undefined);
    rmSync(c.dir, { recursive: true, force: true });
  } catch {
    // It never started; there is nothing to stop.
  }
}

/** Tests: start the checker with `start` instead of TypeScript (null restores TypeScript). */
export async function _setSnippetCheckerStart(start: StartChecker | null): Promise<void> {
  await closeSnippetChecker();
  startChecker = start ?? startTypeScriptChecker;
}

// ─── the check ───────────────────────────────────────────────────────────────

/**
 * Type-check a snippet that already parses. Never throws: a checker that
 * cannot start or answer makes the check `skipped`.
 */
export function checkSnippet(code: string): Promise<SnippetCheck> {
  const run = queue.then(() => checkNow(code));
  queue = run.catch(() => undefined);
  return run;
}

async function checkNow(code: string): Promise<SnippetCheck> {
  let c: Checker;
  try {
    checker ??= withTimeout(startChecker(), SNIPPET_CHECK_START_TIMEOUT_MS, "starting the type checker");
    c = await checker;
  } catch (err) {
    checker = null;
    return { status: "skipped", reason: reasonOf(err) };
  }
  try {
    return await withTimeout(diagnose(c, code), SNIPPET_CHECK_TIMEOUT_MS, "the type check");
  } catch (err) {
    // A checker that failed once is not trusted again: the next check starts a new one.
    await closeSnippetChecker();
    return { status: "skipped", reason: reasonOf(err) };
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function diagnose(c: Checker, code: string): Promise<SnippetCheck> {
  const text = `${WRAP_HEAD}${code}${WRAP_TAIL}`;
  writeFileSync(c.file, text);
  const snapshot = await c.api.updateSnapshot({ fileChanges: { changed: [c.file] } });
  const project = snapshot.getProject(c.config);
  if (!project) throw new Error("the checker lost its project");
  const { program, checker: types } = project;
  const all = [...await program.getSyntacticDiagnostics(c.file), ...await program.getSemanticDiagnostics(c.file)]
    .filter((d) => d.category === CATEGORY_ERROR)
    .sort((a, b) => a.pos - b.pos);
  if (all.length === 0) return { status: "passed" };

  const sourceFile = await program.getSourceFile(c.file);
  const kept: Array<{ diagnostic: TsDiagnostic; member?: UnknownMember }> = [];
  for (const d of all) {
    const node = sourceFile ? c.ast.getTokenAtPosition(sourceFile, d.pos) : undefined;
    if (node && c.ast.isIdentifier(node) && c.ast.isTypeOfExpression(node.parent)) continue;
    if (node && MISSING_PROPERTY.has(d.code) && c.ast.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
      const verdict = await missingMember(c, types, node.parent, node.text ?? "", text);
      if (verdict === "exempt") continue;
      kept.push({ diagnostic: d, ...(verdict ? { member: verdict } : {}) });
      continue;
    }
    kept.push({ diagnostic: d });
  }
  if (kept.length === 0) return { status: "passed" };

  const diagnostics = kept.map(({ diagnostic }) => ({
    ...position(text, diagnostic.pos),
    code: `TS${diagnostic.code}`,
    message: flatten(diagnostic),
  }));
  const first = kept[0]!.member;
  return {
    status: "refused",
    diagnostics,
    ...(first ? { unknownMember: first } : {}),
  };
}

/** A diagnostic's offset in the wrapped text, as a 1-based line and column in the snippet. */
function position(text: string, pos: number): { line: number; column: number } {
  const before = text.slice(0, pos).split("\n");
  const line = before.length;
  return { line, column: shiftColumn(line, before[before.length - 1]!.length + 1) };
}

/** TypeScript's message with its chain, on one line. */
function flatten(d: TsDiagnostic): string {
  const parts = [d.text];
  for (const next of d.messageChain ?? []) parts.push(flatten(next));
  return parts.join(" ");
}

// ─── a missing member ────────────────────────────────────────────────────────

/**
 * For `receiver.key` where TypeScript found no `key`: `exempt` when the
 * replay would resolve it (an un-awaited chain whose awaited value has `key`),
 * an `UnknownMember` when the receiver is an SDK object, and undefined for
 * anything else (data, a string), which stays an ordinary type error.
 */
async function missingMember(c: Checker, types: TsChecker, access: TsNode, key: string, text: string): Promise<"exempt" | UnknownMember | undefined> {
  const receiverNode = access.expression!;
  const receiver = await types.getTypeAtLocation(receiverNode);
  if (!receiver) return undefined;
  const chain = chainOf(c.ast, receiverNode);
  const symbol = await receiver.getSymbol();

  // An un-awaited chain: the replay awaits every intermediate, so `key` on the awaited value works.
  if (symbol?.name === "Promise") {
    const [awaited] = await types.getTypeArguments(receiver);
    if (!awaited) return undefined;
    const awaitedSymbol = await awaited.getSymbol();
    const fromR = chain.root === "r" || isSdkClass(awaitedSymbol);
    if (fromR && (await memberNames(types, awaited)).includes(key)) return "exempt";
    return undefined;
  }

  const isRoot = chain.root === "r" && chain.display === "r";
  if (!isRoot && !isSdkClass(symbol)) return undefined;
  const root = await rootType(types, c.file, text);
  const members = await memberNames(types, receiver);
  const near = closestMembers(key, members).map((m) => `${chain.display}.${m}`);
  const suggestions = near.length > 0 ? near : await findElsewhere(types, key, receiver, chain.display, root);
  return new UnknownMember(`${chain.display}.${key}`, suggestions, members);
}

function isSdkClass(symbol: TsSymbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & SYMBOL_CLASS) !== 0;
}

/** The chain as a snippet writes it, a call shown as `(…)` (`r.project(…)`), and the identifier it starts from. */
function chainOf(ast: TsAst, node: TsNode): { display: string; root: string | null } {
  const segments: string[] = [];
  let e: TsNode = node;
  for (;;) {
    if (ast.isPropertyAccessExpression(e)) {
      segments.unshift(`.${e.name!.text}`);
      e = e.expression!;
    } else if (ast.isCallExpression(e)) {
      segments.unshift("(…)");
      e = e.expression!;
    } else if (ast.isElementAccessExpression(e)) {
      segments.unshift("[…]");
      e = e.expression!;
    } else if (ast.isParenthesizedExpression(e) || ast.isNonNullExpression(e) || ast.isAwaitExpression(e)) {
      e = e.expression!;
    } else {
      break;
    }
  }
  const root = ast.isIdentifier(e) ? e.text ?? null : null;
  return { display: `${root ?? "…"}${segments.join("")}`, root };
}

/** The type of `r`, the client the host replays against. */
async function rootType(types: TsChecker, file: string, text: string): Promise<TsType | undefined> {
  const symbol = await types.resolveName("r", SYMBOL_VALUE, { document: file, position: text.length - 1 });
  return symbol ? types.getTypeOfSymbol(symbol) : undefined;
}

/** A type's public members, as the replay's `publicMembers` counts them: no private, internal, or intrinsic names. */
async function memberNames(types: TsChecker, type: TsType): Promise<string[]> {
  const symbol = await type.getSymbol();
  const hidden = symbol ? sdkPrivateMembers().get(symbol.name) : undefined;
  const names = (await types.getPropertiesOfType(type)).map((p) => p.name);
  return [...new Set(names.filter((n) => !(n.startsWith("_") || n.startsWith("#") || n.startsWith("__@") || n === "constructor" || hidden?.has(n))))].sort();
}

/** The namespaces among a type's members: the ones whose type is an SDK class. */
async function namespacesOf(types: TsChecker, type: TsType): Promise<Array<{ name: string; type: TsType }>> {
  const names = new Set(await memberNames(types, type));
  const props = (await types.getPropertiesOfType(type)).filter((p) => names.has(p.name));
  const propTypes = props.length > 0 ? await types.getTypeOfSymbol(props) : [];
  const out: Array<{ name: string; type: TsType }> = [];
  for (let i = 0; i < props.length; i++) {
    const t = propTypes[i];
    if (t && isSdkClass(await t.getSymbol())) out.push({ name: props[i]!.name, type: t });
  }
  return out;
}

/**
 * Where else `key` lives, as the replay's `findElsewhere` searches objects:
 * the receiver's own namespaces first (`r.project(…).projects.sql`), then the
 * root and the root's namespaces (`r.projects.sql`). At most three.
 */
async function findElsewhere(types: TsChecker, key: string, receiver: TsType, display: string, root: TsType | undefined): Promise<string[]> {
  const found: string[] = [];
  const add = (p: string) => { if (!found.includes(p)) found.push(p); };
  for (const ns of await namespacesOf(types, receiver)) {
    if ((await memberNames(types, ns.type)).includes(key)) add(`${display}.${ns.name}.${key}`);
  }
  if (root && root.id !== receiver.id) {
    if ((await memberNames(types, root)).includes(key)) add(`r.${key}`);
    for (const ns of await namespacesOf(types, root)) {
      if (ns.type.id !== receiver.id && (await memberNames(types, ns.type)).includes(key)) add(`r.${ns.name}.${key}`);
    }
  }
  return found.slice(0, 3);
}
