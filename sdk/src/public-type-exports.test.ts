import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(SRC_DIR, "..");
const REPO_DIR = resolve(SDK_DIR, "..");

test("@run402/sdk re-exports every public source type", () => {
  const expected = collectDeclaredTypes(publicRootTypeFiles());
  const actual = collectAvailableTypes(join(SRC_DIR, "index.ts"));

  assert.deepEqual(
    difference(expected, actual),
    [],
    "sdk/src/index.ts is missing public type exports",
  );
});

test("@run402/sdk/node re-exports the isomorphic type surface and Node-only helper types", () => {
  const rootTypes = collectAvailableTypes(join(SRC_DIR, "index.ts"));
  const nodeTypes = collectAvailableTypes(join(SRC_DIR, "node/index.ts"));
  const requiredNodeTypes = new Set([
    "NodeRun402Options",
    "NodeRun402",
    "DeployDirOptions",
    "DeployDirEvent",
    "FileSetFromDirOptions",
    "SignCiDelegationOptions",
    "DeployManifestDatabaseSpec",
    "DeployManifestFileEntry",
    "DeployManifestFileSet",
    "DeployManifestFunctionsSpec",
    "DeployManifestFunctionSpec",
    "DeployManifestInput",
    "DeployManifestMigrationSpec",
    "DeployManifestSiteSpec",
    "LoadDeployManifestOptions",
    "NormalizedDeployManifest",
    "NormalizeDeployManifestOptions",
  ]);

  assert.deepEqual(
    difference(new Set([...rootTypes, ...requiredNodeTypes]), nodeTypes),
    [],
    "sdk/src/node/index.ts is missing public type exports",
  );
});

test("public type imports compile from package entrypoints", () => {
  const rootTypes = [...collectAvailableTypes(join(SRC_DIR, "index.ts"))].sort();
  const nodeTypes = [...collectAvailableTypes(join(SRC_DIR, "node/index.ts"))].sort();
  const dir = mkdtempSync(join(tmpdir(), "run402-sdk-type-contract-"));
  const contractPath = join(dir, "contract.ts");

  try {
    writeFileSync(
      contractPath,
      [
        typeImport("@run402/sdk", "Root", rootTypes),
        typeImport("@run402/sdk/node", "Node", nodeTypes),
        tupleAlias("RootContract", "Root", rootTypes),
        tupleAlias("NodeContract", "Node", nodeTypes),
        "export {};",
      ].join("\n\n"),
    );

    const program = ts.createProgram([contractPath], {
      baseUrl: REPO_DIR,
      paths: {
        "@run402/sdk": ["sdk/src/index.ts"],
        "@run402/sdk/node": ["sdk/src/node/index.ts"],
      },
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.equal(formatDiagnostics(diagnostics), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("route method constants are available from package entrypoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-sdk-route-const-contract-"));
  const contractPath = join(dir, "contract.ts");

  try {
    writeFileSync(
      contractPath,
      [
        'import { ROUTE_HTTP_METHODS as ROOT_METHODS } from "@run402/sdk";',
        'import { ROUTE_HTTP_METHODS as NODE_METHODS } from "@run402/sdk/node";',
        'const rootGet: "GET" = ROOT_METHODS[0];',
        'const nodePost: "POST" = NODE_METHODS[2];',
        "void rootGet;",
        "void nodePost;",
        "export {};",
      ].join("\n"),
    );

    const program = ts.createProgram([contractPath], {
      baseUrl: REPO_DIR,
      paths: {
        "@run402/sdk": ["sdk/src/index.ts"],
        "@run402/sdk/node": ["sdk/src/node/index.ts"],
      },
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.equal(formatDiagnostics(diagnostics), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("stable-host deploy resolve diagnostic types are available from package entrypoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-sdk-resolve-diagnostics-contract-"));
  const contractPath = join(dir, "contract.ts");

  try {
    writeFileSync(
      contractPath,
      [
        'import type { DeployResolveAuthorizationResult as RootAuth, KnownDeployResolveAuthorizationResult as RootKnownAuth, DeployResolveCasObject as RootCas, DeployResolveResponseVariant as RootVariant } from "@run402/sdk";',
        'import type { DeployResolveAuthorizationResult as NodeAuth, DeployResolveCasObject as NodeCas, DeployResolveResponseVariant as NodeVariant } from "@run402/sdk/node";',
        'const rootAuth: RootAuth = "future_authorization_result";',
        'const rootKnownAuth: RootKnownAuth = "missing_cas_object";',
        'const rootCas: RootCas = { sha256: "a".repeat(64), exists: false, expected_size: 100, actual_size: null };',
        'const rootVariant: RootVariant = { kind: "html", varies_by: "hostname", hostname: "example.com", release_id: "rel_123", release_generation: 7, path: "/index.html", raw_static_sha256: "b".repeat(64), variant_inputs_hash: "c".repeat(64) };',
        "const nodeAuth: NodeAuth = rootAuth;",
        "const nodeCas: NodeCas = rootCas;",
        "const nodeVariant: NodeVariant = rootVariant;",
        "void rootKnownAuth;",
        "void nodeAuth;",
        "void nodeCas;",
        "void nodeVariant;",
        "export {};",
      ].join("\n"),
    );

    const program = ts.createProgram([contractPath], {
      baseUrl: REPO_DIR,
      paths: {
        "@run402/sdk": ["sdk/src/index.ts"],
        "@run402/sdk/node": ["sdk/src/node/index.ts"],
      },
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.equal(formatDiagnostics(diagnostics), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("deploy summary helper is available from package entrypoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-sdk-deploy-summary-contract-"));
  const contractPath = join(dir, "contract.ts");

  try {
    writeFileSync(
      contractPath,
      [
        'import { summarizeDeployResult as rootSummary, type DeploySummary as RootSummary } from "@run402/sdk";',
        'import { summarizeDeployResult as nodeSummary, type DeploySummary as NodeSummary } from "@run402/sdk/node";',
        "declare const result: Parameters<typeof rootSummary>[0];",
        "const root: RootSummary = rootSummary(result);",
        "const node: NodeSummary = nodeSummary(result);",
        'const version: "deploy-summary.v1" = root.schema_version;',
        "void node;",
        "void version;",
        "export {};",
      ].join("\n"),
    );

    const program = ts.createProgram([contractPath], {
      baseUrl: REPO_DIR,
      paths: {
        "@run402/sdk": ["sdk/src/index.ts"],
        "@run402/sdk/node": ["sdk/src/node/index.ts"],
      },
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.equal(formatDiagnostics(diagnostics), "");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function publicRootTypeFiles(): string[] {
  const namespaceDir = join(SRC_DIR, "namespaces");
  const namespaceFiles = readdirSync(namespaceDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(namespaceDir, name));

  return [
    join(SRC_DIR, "ci-credentials.ts"),
    join(SRC_DIR, "credentials.ts"),
    join(SRC_DIR, "errors.ts"),
    join(SRC_DIR, "kernel.ts"),
    join(SRC_DIR, "retry.ts"),
    ...namespaceFiles,
  ].sort();
}

function collectDeclaredTypes(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const name of declaredTypeExports(file)) names.add(name);
  }
  return names;
}

function collectAvailableTypes(file: string, seen = new Set<string>()): Set<string> {
  const resolved = resolve(file);
  if (seen.has(resolved)) return new Set();
  seen.add(resolved);

  const names = declaredTypeExports(resolved);
  const sourceFile = parse(resolved);

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    const exportClause = statement.exportClause;

    if (exportClause && ts.isNamedExports(exportClause) && statement.isTypeOnly) {
      for (const element of exportClause.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    if (!exportClause && statement.isTypeOnly && moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      for (const name of collectAvailableTypes(resolveTsModule(resolved, moduleSpecifier.text), seen)) {
        names.add(name);
      }
    }
  }

  return names;
}

function declaredTypeExports(file: string): Set<string> {
  const names = new Set<string>();
  const sourceFile = parse(file);

  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      hasExportModifier(statement)
    ) {
      names.add(statement.name.text);
    }
  }

  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function resolveTsModule(fromFile: string, specifier: string): string {
  assert.ok(
    specifier.startsWith("."),
    `Unexpected non-relative export in ${relative(REPO_DIR, fromFile)}: ${specifier}`,
  );
  const withoutJs = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
  return resolve(dirname(fromFile), `${withoutJs}.ts`);
}

function difference(expected: Set<string>, actual: Set<string>): string[] {
  return [...expected].filter((name) => !actual.has(name)).sort();
}

function typeImport(pkg: string, prefix: string, names: string[]): string {
  const imports = names.map((name) => `${name} as ${prefix}${name}`).join(", ");
  return `import type { ${imports} } from "${pkg}";`;
}

function tupleAlias(name: string, prefix: string, sourceNames: string[]): string {
  const names = sourceNames.map((typeName) => `${prefix}${typeName}`).join(", ");
  return `type ${name} = [${names}];`;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.file && typeof diagnostic.start === "number"
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
      const prefix = diagnostic.file && location
        ? `${relative(REPO_DIR, diagnostic.file.fileName)}:${location.line + 1}:${location.character + 1}: `
        : "";
      return `${prefix}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    })
    .join("\n");
}
