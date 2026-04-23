## ADDED Requirements

### Requirement: Namespaced API surface

The SDK SHALL expose every run402 API operation as a method on a resource namespace object, accessed as `sdk.<namespace>.<operation>(...)`. Operations SHALL NOT be exposed as flat top-level functions. Namespaces SHALL correspond to resource groupings already used by the CLI (e.g. `projects`, `blobs`, `functions`, `email`, `ai`, `contracts`, `domains`, `subdomains`, `auth`, `allowance`, `billing`, `admin`, `service`).

#### Scenario: Calling a namespaced method

- **WHEN** a consumer instantiates `const sdk = new Run402(opts)` and calls `await sdk.projects.provision({ tier: 'prototype' })`
- **THEN** the SDK issues the corresponding `POST /projects/v1` API call and returns a typed response object

#### Scenario: Flat top-level call is not available

- **WHEN** a consumer attempts `sdk.provisionProject(...)` or `sdk.blobPut(...)` on a TypeScript SDK instance
- **THEN** the TypeScript compiler reports an error because no such flat method exists on `Run402`

#### Scenario: Namespace grouping mirrors CLI grouping

- **WHEN** the CLI exposes `run402 <resource> <subcommand>` (e.g. `run402 blob put`, `run402 functions deploy`)
- **THEN** the SDK SHALL expose an equivalent `sdk.<resource>.<subcommand>(...)` method for the same operation

### Requirement: Typed error hierarchy

The SDK SHALL communicate failures by throwing instances of `Run402Error` or its subclasses (`PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`). The SDK's request path SHALL NOT call `process.exit`, return `{ isError: true, content: [...] }` shapes, or return error tuples. Every thrown error SHALL carry the HTTP status (if any), the response body (if any), and a short `context` string identifying the attempted operation.

#### Scenario: 402 Payment Required response

- **WHEN** an SDK method's underlying API call returns HTTP 402 with a JSON body
- **THEN** the SDK throws a `PaymentRequired` instance whose `status` is 402, `body` is the parsed response, and `context` is the namespace-qualified operation name (e.g. `"projects.provision"`)

#### Scenario: Project missing from local keystore

- **WHEN** a consumer calls `sdk.functions.deploy(id, opts)` with an `id` not present in the configured credential provider
- **THEN** the SDK throws `ProjectNotFound` before issuing any HTTP call

#### Scenario: Generic API error

- **WHEN** the gateway returns HTTP 500 with a JSON body `{ "error": "internal" }`
- **THEN** the SDK throws an `ApiError` whose `status` is 500 and `body` is `{ "error": "internal" }`

#### Scenario: Network failure

- **WHEN** the underlying `fetch` rejects (e.g., DNS failure, connection reset) and no HTTP response is received
- **THEN** the SDK throws `NetworkError` wrapping the underlying error and containing the request URL

#### Scenario: SDK never calls process.exit

- **WHEN** any SDK code path runs in any environment
- **THEN** it MUST NOT call `process.exit`, `Deno.exit`, or any equivalent process-termination function

### Requirement: Pluggable credential provider

The SDK SHALL accept a `CredentialsProvider` implementation at construction via a constructor option. The provider SHALL expose at least two methods: `getAuth(path: string)` returning per-request auth headers, and `getProject(id: string)` returning local project keys or null. The SDK core request path SHALL NOT read the filesystem, read environment variables, or spawn processes; all such access SHALL be encapsulated inside provider implementations.

#### Scenario: Custom credential provider

- **WHEN** a consumer passes a custom `CredentialsProvider` to `new Run402({ credentials: myProvider })` and calls any method requiring auth
- **THEN** the SDK calls `myProvider.getAuth(...)` to obtain the auth headers and uses them verbatim in the HTTP request

#### Scenario: No provider injected

- **WHEN** a consumer constructs `new Run402({})` with no credentials option and calls a method that requires auth
- **THEN** the SDK throws `Unauthorized` (not an uncaught `undefined` reference)

#### Scenario: SDK core imports no Node-only APIs

- **WHEN** a consumer imports `@run402/sdk` (the kernel entry point, not `@run402/sdk/node`) in a V8 isolate that lacks `fs`, `child_process`, and `process`
- **THEN** the import succeeds, `new Run402({ credentials })` succeeds, and method calls execute without ReferenceError or module-resolution failure

### Requirement: Node default provider preserves x402 and keystore behavior

The package entry `@run402/sdk/node` SHALL export a Node-specific `CredentialsProvider` and a pre-wired `Run402` factory that reproduces today's CLI/MCP behavior: keystore at `~/.config/run402/keystore.json` (or `RUN402_CONFIG_DIR` override), allowance at the standard path, and x402 payment retry on 402 when an allowance is configured.

#### Scenario: Zero-config Node usage

- **WHEN** a Node consumer runs `import { run402 } from "@run402/sdk/node"; const r = run402();` with an existing populated keystore and funded allowance
- **THEN** `await r.projects.provision({ tier: 'prototype' })` behaves identically (payment flow included) to today's `run402 projects provision --tier prototype` CLI call

#### Scenario: 402 with funded allowance

- **WHEN** an API call made through the Node default provider receives HTTP 402 and the configured allowance has sufficient USDC balance on a supported network
- **THEN** the underlying fetch wrapper signs and retries the request using `@x402/fetch`, and the SDK method returns the successful response without surfacing the intermediate 402 to the caller

#### Scenario: 402 without a funded allowance

- **WHEN** an API call receives HTTP 402 and no allowance is configured (or balance is insufficient)
- **THEN** the SDK throws `PaymentRequired` with the 402 body intact

### Requirement: MCP handlers delegate to the SDK

Every MCP tool handler in `src/tools/*.ts` SHALL obtain its result from an SDK method call rather than issuing HTTP requests directly. Handlers SHALL contain only: input mapping, a single SDK invocation, output formatting to MCP markdown, and error translation from `Run402Error` to MCP's `{ content, isError }` shape.

#### Scenario: MCP handler performs no direct fetch

- **WHEN** an MCP handler source file in `src/tools/` is inspected
- **THEN** it contains no `fetch(` call, no `paidApiRequest(` call, and no `apiRequest(` call; all network I/O is routed through an SDK method

#### Scenario: MCP tool output parity

- **WHEN** an MCP tool is invoked post-migration with arguments that previously produced a specific text response
- **THEN** the tool produces byte-equivalent text (modulo timestamps, UUIDs, and other non-deterministic values) to the pre-migration response

### Requirement: CLI commands delegate to the SDK

Every CLI subcommand in `cli/lib/*.mjs` SHALL obtain its result from an SDK method call rather than issuing HTTP requests directly. CLI command code SHALL contain only: argv parsing, a single SDK invocation, output formatting (text or `--json`), and translation of `Run402Error` to appropriate exit codes.

#### Scenario: CLI command performs no direct fetch

- **WHEN** a CLI module source file in `cli/lib/` is inspected
- **THEN** it contains no `fetch(` call; all network I/O is routed through an SDK method

#### Scenario: CLI output parity

- **WHEN** a CLI subcommand is invoked post-migration
- **THEN** it produces byte-equivalent stdout / stderr / exit code (modulo non-deterministic values) to the pre-migration command

#### Scenario: process.exit remains at the CLI edge

- **WHEN** an SDK call inside a CLI command throws a `Run402Error`
- **THEN** the CLI command translates the error to a human-readable message, chooses an appropriate non-zero exit code, and calls `process.exit` in the CLI command itself — never inside the SDK

### Requirement: Pre-bundling in deploy_function

The list of packages pre-bundled by `deploy_function` SHALL include `@run402/sdk` so user-deployed functions may `import { run402 } from "@run402/sdk"` (or from `@run402/sdk/node` where appropriate) without declaring it in the `deps` array.

#### Scenario: Deploying a function that imports the SDK

- **WHEN** a user calls `deploy_function` with handler code that imports from `@run402/sdk` and no explicit `deps` entry for it
- **THEN** the deployed function runs successfully and can make run402 API calls via the SDK at runtime

### Requirement: Sync test covers the SDK surface

The `sync.test.ts` `SURFACE` array SHALL be extended with an `sdk` field naming the SDK namespace-qualified method that corresponds to each MCP tool and CLI command. The test SHALL fail if any SURFACE entry lacks an `sdk` field, if the named SDK method does not exist on the SDK package, or if an SDK method has no corresponding SURFACE entry.

#### Scenario: Missing SDK method fails the test

- **WHEN** a SURFACE entry declares `sdk: "projects.provision"` and the SDK does not export that method
- **THEN** `npm run test:sync` fails with a message identifying the missing SDK method

#### Scenario: Orphan SDK method fails the test

- **WHEN** the SDK exports a method `sdk.foo.bar()` that is not referenced by any SURFACE entry's `sdk` field
- **THEN** `npm run test:sync` fails with a message identifying the orphan SDK method

### Requirement: SDK is published as a standalone npm package

The SDK SHALL be published to npm as `@run402/sdk` with a `package.json` whose `main` / `exports` surface include both the root entry (isomorphic kernel) and a `/node` subpath (Node defaults). The package SHALL be independently versioned from `run402-mcp` and `run402`.

#### Scenario: Installing the SDK externally

- **WHEN** a developer outside this repo runs `npm install @run402/sdk` in a Node 22 project
- **THEN** they can `import { Run402 } from "@run402/sdk"` and `import { run402 } from "@run402/sdk/node"` without additional configuration

#### Scenario: Versioning independence

- **WHEN** a patch release is made to `run402-mcp` that does not change the SDK
- **THEN** the `@run402/sdk` version in npm is not required to change
