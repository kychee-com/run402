/**
 * The tools' schema builder: one definition gives a tool's published JSON
 * Schema, its TypeScript type, and the validation of its arguments and
 * results. In-house, so `run402-mcp` carries no schema library of its own.
 *
 * The API is the subset of zod 3 the tools use, with zod 3's semantics:
 * methods return new schemas; `optional()`, `nullable()` and `catch`-free
 * wrappers copy the description, as zod 3 did; an object strips undeclared
 * keys unless `strict()` (refuse them) or `loose()` (keep them).
 *
 * `toJsonSchema` reproduces what zod-to-json-schema 3 (draft-07, `$ref`
 * strategy `root`, `strictUnions`) emitted for the same definitions, byte for
 * byte: `src/fixtures/tools-list-4.142.0.json` pins it for all eight tools.
 * A schema object used twice in one tool is emitted once and referenced by
 * `$ref` to the path where it first appeared.
 */

type Path = ReadonlyArray<string | number>;

export interface SchemaIssue {
  path: Array<string | number>;
  message: string;
  /** `unrecognized_keys` for a strict object's undeclared keys (with `keys`); `invalid` otherwise. */
  code: "unrecognized_keys" | "invalid";
  keys?: string[];
}

export type SafeParseResult<T> = { success: true; data: T } | { success: false; issues: SchemaIssue[]; error: { issues: SchemaIssue[] } };

type JsonSchema = Record<string, unknown>;

interface ParseCtx {
  issues: SchemaIssue[];
}

export class SchemaError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(issues.map((i) => `${i.path.join(".") || "(value)"}: ${i.message}`).join("; "));
    this.name = "SchemaError";
  }
}

/** Marker returned by a parse that failed; never escapes `safeParse`. */
const INVALID = Symbol("invalid");

function received(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "nan";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export abstract class Schema<O> {
  /** The TypeScript type this schema accepts; type-level only. */
  declare readonly _output: O;
  description: string | undefined;

  protected abstract copy(): this;

  /** True when `undefined` passes, which makes an object member optional (zod 3's `isOptional`). */
  acceptsUndefined(): boolean {
    return false;
  }

  describe(description: string): this {
    const next = this.copy();
    next.description = description;
    return next;
  }

  optional(): OptionalSchema<this> {
    return new OptionalSchema(this, this.description);
  }

  nullable(): NullableSchema<this> {
    return new NullableSchema(this, this.description);
  }

  refine(check: (value: O) => boolean, opts: { message: string; path?: Array<string | number> }): RefinedSchema<O> {
    return new RefinedSchema<O>(this, check, opts);
  }

  safeParse(value: unknown): SafeParseResult<O> {
    const ctx: ParseCtx = { issues: [] };
    const data = this.parseAt(value, [], ctx);
    if (data === INVALID || ctx.issues.length > 0) return { success: false, issues: ctx.issues, error: { issues: ctx.issues } };
    return { success: true, data: data as O };
  }

  /** The parsed value, or a thrown `SchemaError` listing every issue. */
  parse(value: unknown): O {
    const result = this.safeParse(value);
    if (!result.success) throw new SchemaError(result.issues);
    return result.data;
  }

  /** @internal */
  abstract parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown;

  /** @internal The JSON Schema for this node, before its description is added. */
  abstract emitBody(refs: EmitRefs): JsonSchema | undefined;

  protected fail(ctx: ParseCtx, path: Path, message: string): typeof INVALID {
    ctx.issues.push({ path: [...path], message, code: "invalid" });
    return INVALID;
  }
}

export type Infer<S> = S extends Schema<infer O> ? O : never;
/** Any schema, whatever it accepts. `refine`'s callback makes `Schema<O>` invariant, so constraints need `any`, as zod's do. */
export type AnySchema = Schema<any>;
export type RawShape = Record<string, AnySchema>;

// ---------------------------------------------------------------- scalars

type StringCheck = { kind: "min" | "max"; value: number } | { kind: "regex"; value: RegExp } | { kind: "url" };

export class StringSchema extends Schema<string> {
  constructor(readonly checks: readonly StringCheck[] = []) {
    super();
  }
  protected copy(): this {
    const next = new StringSchema(this.checks) as this;
    next.description = this.description;
    return next;
  }
  private with(check: StringCheck): StringSchema {
    const next = new StringSchema([...this.checks, check]);
    next.description = this.description;
    return next;
  }
  min(value: number): StringSchema {
    return this.with({ kind: "min", value });
  }
  max(value: number): StringSchema {
    return this.with({ kind: "max", value });
  }
  regex(value: RegExp): StringSchema {
    return this.with({ kind: "regex", value });
  }
  url(): StringSchema {
    return this.with({ kind: "url" });
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (typeof value !== "string") return this.fail(ctx, path, `Expected string, received ${received(value)}`);
    for (const check of this.checks) {
      const problem = stringProblem(check, value);
      if (problem) return this.fail(ctx, path, problem);
    }
    return value;
  }
  emitBody(): JsonSchema {
    const out: JsonSchema = { type: "string" };
    for (const check of this.checks) {
      if (check.kind === "min") out.minLength = typeof out.minLength === "number" ? Math.max(out.minLength, check.value) : check.value;
      else if (check.kind === "max") out.maxLength = typeof out.maxLength === "number" ? Math.min(out.maxLength, check.value) : check.value;
      else if (check.kind === "url") out.format = "uri";
      else if (check.kind === "regex") out.pattern = check.value.source;
    }
    return out;
  }
}

function stringProblem(check: StringCheck, value: string): string | null {
  switch (check.kind) {
    case "min":
      return value.length < check.value ? `String must contain at least ${check.value} character(s)` : null;
    case "max":
      return value.length > check.value ? `String must contain at most ${check.value} character(s)` : null;
    case "regex":
      return check.value.test(value) ? null : "Invalid";
    case "url":
      return URL.canParse(value) ? null : "Invalid url";
  }
}

type NumberCheck = { kind: "int" } | { kind: "min" | "max"; value: number };

export class NumberSchema extends Schema<number> {
  constructor(readonly checks: readonly NumberCheck[] = []) {
    super();
  }
  protected copy(): this {
    const next = new NumberSchema(this.checks) as this;
    next.description = this.description;
    return next;
  }
  private with(check: NumberCheck): NumberSchema {
    const next = new NumberSchema([...this.checks, check]);
    next.description = this.description;
    return next;
  }
  int(): NumberSchema {
    return this.with({ kind: "int" });
  }
  min(value: number): NumberSchema {
    return this.with({ kind: "min", value });
  }
  max(value: number): NumberSchema {
    return this.with({ kind: "max", value });
  }
  nonnegative(): NumberSchema {
    return this.with({ kind: "min", value: 0 });
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (typeof value !== "number" || Number.isNaN(value)) return this.fail(ctx, path, `Expected number, received ${received(value)}`);
    for (const check of this.checks) {
      if (check.kind === "int" && !Number.isInteger(value)) return this.fail(ctx, path, "Expected integer, received float");
      if (check.kind === "min" && value < check.value) return this.fail(ctx, path, `Number must be greater than or equal to ${check.value}`);
      if (check.kind === "max" && value > check.value) return this.fail(ctx, path, `Number must be less than or equal to ${check.value}`);
    }
    return value;
  }
  emitBody(): JsonSchema {
    const out: JsonSchema = { type: "number" };
    for (const check of this.checks) {
      if (check.kind === "int") out.type = "integer";
      else if (check.kind === "min") out.minimum = check.value;
      else out.maximum = check.value;
    }
    return out;
  }
}

export class BooleanSchema extends Schema<boolean> {
  protected copy(): this {
    const next = new BooleanSchema() as this;
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    return typeof value === "boolean" ? value : this.fail(ctx, path, `Expected boolean, received ${received(value)}`);
  }
  emitBody(): JsonSchema {
    return { type: "boolean" };
  }
}

export class NullSchema extends Schema<null> {
  protected copy(): this {
    const next = new NullSchema() as this;
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    return value === null ? null : this.fail(ctx, path, `Expected null, received ${received(value)}`);
  }
  emitBody(): JsonSchema {
    return { type: "null" };
  }
}

export class UnknownSchema extends Schema<unknown> {
  protected copy(): this {
    const next = new UnknownSchema() as this;
    next.description = this.description;
    return next;
  }
  override acceptsUndefined(): boolean {
    return true;
  }
  parseAt(value: unknown): unknown {
    return value;
  }
  emitBody(): JsonSchema {
    return {};
  }
}

type Literal = string | number | boolean;

export class LiteralSchema<L extends Literal> extends Schema<L> {
  constructor(readonly value: L) {
    super();
  }
  protected copy(): this {
    const next = new LiteralSchema(this.value) as this;
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    return value === this.value ? value : this.fail(ctx, path, `Invalid literal value, expected ${JSON.stringify(this.value)}`);
  }
  emitBody(): JsonSchema {
    return { type: typeof this.value, const: this.value };
  }
}

export class EnumSchema<V extends string> extends Schema<V> {
  constructor(readonly values: readonly V[]) {
    super();
  }
  protected copy(): this {
    const next = new EnumSchema(this.values) as this;
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (typeof value === "string" && (this.values as readonly string[]).includes(value)) return value;
    return this.fail(ctx, path, `Invalid enum value. Expected ${this.values.map((v) => `'${v}'`).join(" | ")}, received ${typeof value === "string" ? `'${value}'` : received(value)}`);
  }
  emitBody(): JsonSchema {
    return { type: "string", enum: [...this.values] };
  }
}

// ------------------------------------------------------------- containers

export class ArraySchema<I extends AnySchema> extends Schema<Array<Infer<I>>> {
  constructor(readonly item: I, readonly minItems?: number, readonly maxItems?: number) {
    super();
  }
  protected copy(): this {
    const next = new ArraySchema(this.item, this.minItems, this.maxItems) as this;
    next.description = this.description;
    return next;
  }
  min(value: number): ArraySchema<I> {
    const next = new ArraySchema(this.item, value, this.maxItems);
    next.description = this.description;
    return next;
  }
  max(value: number): ArraySchema<I> {
    const next = new ArraySchema(this.item, this.minItems, value);
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (!Array.isArray(value)) return this.fail(ctx, path, `Expected array, received ${received(value)}`);
    if (this.minItems !== undefined && value.length < this.minItems) return this.fail(ctx, path, `Array must contain at least ${this.minItems} element(s)`);
    if (this.maxItems !== undefined && value.length > this.maxItems) return this.fail(ctx, path, `Array must contain at most ${this.maxItems} element(s)`);
    const out = value.map((entry, i) => this.item.parseAt(entry, [...path, i], ctx));
    return out.includes(INVALID) ? INVALID : out;
  }
  emitBody(refs: EmitRefs): JsonSchema {
    const out: JsonSchema = { type: "array", items: emit(this.item, { ...refs, currentPath: [...refs.currentPath, "items"] }) };
    if (this.minItems !== undefined) out.minItems = this.minItems;
    if (this.maxItems !== undefined) out.maxItems = this.maxItems;
    return out;
  }
}

export class RecordSchema<V extends AnySchema> extends Schema<Record<string, Infer<V>>> {
  constructor(readonly valueSchema: V) {
    super();
  }
  protected copy(): this {
    const next = new RecordSchema(this.valueSchema) as this;
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (!isPlainObject(value)) return this.fail(ctx, path, `Expected object, received ${received(value)}`);
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const [key, entry] of Object.entries(value)) {
      const parsed = this.valueSchema.parseAt(entry, [...path, key], ctx);
      if (parsed === INVALID) ok = false;
      else defineOwn(out, key, parsed);
    }
    return ok ? out : INVALID;
  }
  emitBody(refs: EmitRefs): JsonSchema {
    return {
      type: "object",
      additionalProperties: emit(this.valueSchema, { ...refs, currentPath: [...refs.currentPath, "additionalProperties"] }) ?? true,
    };
  }
}

type UnknownKeys = "strip" | "strict" | "loose";

type IsOptional<S> = S extends OptionalSchema<AnySchema> ? true : S extends UnknownSchema ? true : false;
type Flatten<T> = { [K in keyof T]: T[K] } & {};
type ObjectOutput<S extends RawShape> = Flatten<
  { [K in keyof S as IsOptional<S[K]> extends true ? never : K]: Infer<S[K]> } &
  { [K in keyof S as IsOptional<S[K]> extends true ? K : never]?: Infer<S[K]> }
>;

export class ObjectSchema<S extends RawShape, M extends UnknownKeys = "strip"> extends Schema<
  M extends "loose" ? ObjectOutput<S> & Record<string, unknown> : ObjectOutput<S>
> {
  constructor(readonly shape: S, readonly unknownKeys: M) {
    super();
  }
  protected copy(): this {
    const next = new ObjectSchema(this.shape, this.unknownKeys) as this;
    next.description = this.description;
    return next;
  }
  strict(): ObjectSchema<S, "strict"> {
    const next = new ObjectSchema(this.shape, "strict" as const);
    next.description = this.description;
    return next;
  }
  loose(): ObjectSchema<S, "loose"> {
    const next = new ObjectSchema(this.shape, "loose" as const);
    next.description = this.description;
    return next;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    if (!isPlainObject(value)) return this.fail(ctx, path, `Expected object, received ${received(value)}`);
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const [key, member] of Object.entries(this.shape)) {
      const present = Object.hasOwn(value, key);
      const parsed = member.parseAt(present ? value[key] : undefined, [...path, key], ctx, );
      if (parsed === INVALID) ok = false;
      else if (present || parsed !== undefined) defineOwn(out, key, parsed);
    }
    const undeclared = Object.keys(value).filter((key) => !Object.hasOwn(this.shape, key));
    if (undeclared.length > 0 && this.unknownKeys === "strict") {
      ctx.issues.push({ path: [...path], message: `Unrecognized key(s) in object: ${undeclared.map((k) => `'${k}'`).join(", ")}`, code: "unrecognized_keys", keys: undeclared });
      ok = false;
    }
    if (this.unknownKeys === "loose") for (const key of undeclared) defineOwn(out, key, value[key]);
    return ok ? out : INVALID;
  }
  emitBody(refs: EmitRefs): JsonSchema {
    const properties: JsonSchema = {};
    const required: string[] = [];
    for (const [key, member] of Object.entries(this.shape)) {
      const memberPath = [...refs.currentPath, "properties", key];
      const emitted = emit(member, { ...refs, currentPath: memberPath, propertyPath: memberPath });
      if (emitted === undefined) continue;
      properties[key] = emitted;
      if (!member.acceptsUndefined()) required.push(key);
    }
    const out: JsonSchema = { type: "object", properties };
    if (required.length > 0) out.required = required;
    out.additionalProperties = this.unknownKeys === "loose";
    return out;
  }
}

/** A JSON object member named `__proto__` stays an own property, as `JSON.parse` keeps it. */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

const PRIMITIVE_TYPE = new Map<Function, string>([
  [StringSchema, "string"],
  [NumberSchema, "number"],
  [BooleanSchema, "boolean"],
  [NullSchema, "null"],
]);

/** The JSON type of an unchecked primitive schema (the shapes zod-to-json-schema collapses), else undefined. */
function plainPrimitiveType(schema: AnySchema): string | undefined {
  const type = PRIMITIVE_TYPE.get(schema.constructor);
  if (type === undefined) return undefined;
  const checks = (schema as unknown as { checks?: readonly unknown[] }).checks;
  return checks && checks.length > 0 ? undefined : type;
}

export class UnionSchema<T extends readonly AnySchema[]> extends Schema<Infer<T[number]>> {
  constructor(readonly options: T) {
    super();
  }
  protected copy(): this {
    const next = new UnionSchema(this.options) as this;
    next.description = this.description;
    return next;
  }
  override acceptsUndefined(): boolean {
    return this.options.some((option) => option.acceptsUndefined());
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    for (const option of this.options) {
      const attempt: ParseCtx = { issues: [] };
      const parsed = option.parseAt(value, path, attempt);
      if (parsed !== INVALID && attempt.issues.length === 0) return parsed;
    }
    return this.fail(ctx, path, "Invalid input");
  }
  emitBody(refs: EmitRefs): JsonSchema | undefined {
    const types = this.options.map(plainPrimitiveType);
    if (types.every((t) => t !== undefined)) {
      const unique = [...new Set(types)];
      return { type: unique.length > 1 ? unique : unique[0] };
    }
    if (this.options.every((o) => o instanceof LiteralSchema && o.description === undefined)) {
      const literals = this.options as unknown as Array<LiteralSchema<Literal>>;
      const unique = [...new Set(literals.map((o) => typeof o.value))];
      return { type: unique.length > 1 ? unique : unique[0], enum: [...new Set(literals.map((o) => o.value))] };
    }
    if (this.options.every((o) => o instanceof EnumSchema)) {
      const values = (this.options as unknown as Array<EnumSchema<string>>).flatMap((o) => o.values);
      return { type: "string", enum: [...new Set(values)] };
    }
    const anyOf = this.options
      .map((option, i) => emit(option, { ...refs, currentPath: [...refs.currentPath, "anyOf", `${i}`] }))
      .filter((x): x is JsonSchema => x !== undefined && Object.keys(x).length > 0);
    return anyOf.length > 0 ? { anyOf } : undefined;
  }
}

// --------------------------------------------------------------- wrappers

export class OptionalSchema<I extends AnySchema> extends Schema<Infer<I> | undefined> {
  constructor(readonly inner: I, description: string | undefined) {
    super();
    this.description = description;
  }
  protected copy(): this {
    return new OptionalSchema(this.inner, this.description) as this;
  }
  override acceptsUndefined(): boolean {
    return true;
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    return value === undefined ? undefined : this.inner.parseAt(value, path, ctx);
  }
  emitBody(refs: EmitRefs): JsonSchema | undefined {
    if (refs.currentPath.join(",") === refs.propertyPath?.join(",")) return emit(this.inner, refs);
    const inner = emit(this.inner, { ...refs, currentPath: [...refs.currentPath, "anyOf", "1"] });
    return inner ? { anyOf: [{ not: {} }, inner] } : {};
  }
}

export class NullableSchema<I extends AnySchema> extends Schema<Infer<I> | null> {
  constructor(readonly inner: I, description: string | undefined) {
    super();
    this.description = description;
  }
  protected copy(): this {
    return new NullableSchema(this.inner, this.description) as this;
  }
  override acceptsUndefined(): boolean {
    return this.inner.acceptsUndefined();
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    return value === null ? null : this.inner.parseAt(value, path, ctx);
  }
  emitBody(refs: EmitRefs): JsonSchema | undefined {
    const type = plainPrimitiveType(this.inner);
    if (type !== undefined) return { type: [type, "null"] };
    const base = emit(this.inner, { ...refs, currentPath: [...refs.currentPath, "anyOf", "0"] });
    return base && { anyOf: [base, { type: "null" }] };
  }
}

export class RefinedSchema<O> extends Schema<O> {
  constructor(readonly inner: Schema<O>, readonly check: (value: O) => boolean, readonly opts: { message: string; path?: Array<string | number> }) {
    super();
  }
  protected copy(): this {
    const next = new RefinedSchema(this.inner, this.check, this.opts) as this;
    next.description = this.description;
    return next;
  }
  override acceptsUndefined(): boolean {
    return this.inner.acceptsUndefined();
  }
  parseAt(value: unknown, path: Path, ctx: ParseCtx): unknown {
    const parsed = this.inner.parseAt(value, path, ctx);
    if (parsed === INVALID) return INVALID;
    if (!this.check(parsed as O)) return this.fail(ctx, [...path, ...(this.opts.path ?? [])], this.opts.message);
    return parsed;
  }
  emitBody(refs: EmitRefs): JsonSchema | undefined {
    return emit(this.inner, refs);
  }
}

// --------------------------------------------------------------- emission

interface EmitRefs {
  currentPath: string[];
  propertyPath: string[] | undefined;
  seen: Map<AnySchema, string[]>;
}

/** zod-to-json-schema's `parseDef`: a schema seen before in this document is a `$ref` to where it first appeared. */
function emit(schema: AnySchema, refs: EmitRefs): JsonSchema | undefined {
  const seenAt = refs.seen.get(schema);
  if (seenAt) return { $ref: seenAt.join("/") };
  refs.seen.set(schema, refs.currentPath);
  const body = schema.emitBody(refs);
  if (body && schema.description !== undefined) body.description = schema.description;
  return body;
}

/** The draft-07 JSON Schema a tool publishes for this schema. */
export function toJsonSchema(schema: AnySchema): JsonSchema {
  const main = emit(schema, { currentPath: ["#"], propertyPath: undefined, seen: new Map() }) ?? {};
  return { ...main, $schema: "http://json-schema.org/draft-07/schema#" };
}

// ------------------------------------------------------------- factories

export const z = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  null: () => new NullSchema(),
  unknown: () => new UnknownSchema(),
  literal: <L extends Literal>(value: L) => new LiteralSchema(value),
  enum: <const V extends string>(values: readonly [V, ...V[]]) => new EnumSchema<V>(values),
  array: <I extends AnySchema>(item: I) => new ArraySchema(item),
  record: <V extends AnySchema>(_key: StringSchema, value: V) => new RecordSchema(value),
  union: <const T extends readonly [AnySchema, ...AnySchema[]]>(options: T) => new UnionSchema(options),
  object: <S extends RawShape>(shape: S) => new ObjectSchema(shape, "strip" as const),
};
