## ADDED Requirements

### Requirement: `projects.list()` accepts optional wallet argument

The SDK's `Projects.list` method SHALL accept its `wallet` parameter as optional. The TypeScript signature SHALL be `list(wallet?: string): Promise<ListProjectsResult>`. Callers that pass an explicit wallet string SHALL receive identical behavior to the prior signature — the resolved wallet is lowercased and passed to `GET /wallets/v1/:wallet/projects` with no authentication header.

#### Scenario: Explicit wallet is passed

- **WHEN** a caller invokes `sdk.projects.list("0xAbC123...")` with an explicit wallet address
- **THEN** the SDK issues `GET /wallets/v1/0xabc123.../projects` with the address lowercased and no authentication header
- **AND** returns the parsed `ListProjectsResult` from the response body

#### Scenario: Explicit wallet works regardless of local allowance state

- **WHEN** a caller invokes `sdk.projects.list("0xOtherWallet...")` with an explicit wallet while the local allowance holds a different address
- **THEN** the SDK issues the request for `0xOtherWallet...` and does not consult `credentials.readAllowance`

### Requirement: Omitted wallet resolves from `credentials.readAllowance`

When `Projects.list` is called with no argument and the configured `CredentialsProvider` implements `readAllowance`, the SDK SHALL call `readAllowance()` and use the returned allowance's `address` field as the wallet. The SDK SHALL lowercase this resolved address before including it in the request path.

#### Scenario: Node provider with configured allowance

- **WHEN** a caller using `@run402/sdk/node` with a configured local allowance (address `0xAbC123...`) invokes `sdk.projects.list()` with no argument
- **THEN** the SDK calls `credentials.readAllowance()`, takes the returned `address`, lowercases it to `0xabc123...`, and issues `GET /wallets/v1/0xabc123.../projects`
- **AND** returns the parsed `ListProjectsResult`

#### Scenario: Caller gets identical result to passing the same address explicitly

- **WHEN** a caller invokes `sdk.projects.list()` and then `sdk.projects.list(allowanceAddress)` with the address returned by `allowance.export()`
- **THEN** both calls produce identical HTTP requests and identical result objects

### Requirement: Omitted wallet throws when provider lacks `readAllowance`

When `Projects.list` is called with no argument and the configured `CredentialsProvider` does not implement `readAllowance` (typically a sandbox provider), the SDK SHALL throw a `Run402Error` whose `context` is `"listing projects"` and whose message names both escape hatches: passing an explicit wallet, or switching to the `@run402/sdk/node` entry point. The SDK SHALL NOT issue any HTTP request in this path.

#### Scenario: Sandbox provider receives empty call

- **WHEN** a caller using a custom `CredentialsProvider` that omits `readAllowance` invokes `sdk.projects.list()` with no argument
- **THEN** the SDK throws `Run402Error` with `context: "listing projects"`
- **AND** the error message mentions both "pass an explicit wallet" and "use `@run402/sdk/node`"
- **AND** no HTTP request is issued

### Requirement: Omitted wallet throws when `readAllowance` returns null

When `Projects.list` is called with no argument and `credentials.readAllowance()` resolves to `null` (no local allowance is configured), the SDK SHALL throw a `Run402Error` whose `context` is `"listing projects"` and whose message suggests running `run402 allowance create` or passing an explicit wallet. The SDK SHALL NOT issue any HTTP request in this path.

#### Scenario: Node provider with no allowance file

- **WHEN** a caller using `@run402/sdk/node` on a machine with no configured allowance (`readAllowance()` returns `null`) invokes `sdk.projects.list()` with no argument
- **THEN** the SDK throws `Run402Error` with `context: "listing projects"`
- **AND** the error message mentions both "run402 allowance create" and "pass an explicit wallet"
- **AND** no HTTP request is issued

### Requirement: No change to authentication model

The `Projects.list` request path SHALL continue to be unauthenticated (`withAuth: false` on the kernel request). The fallback resolution logic SHALL NOT introduce any auth header, session token, or payment flow. The method is a public API endpoint regardless of how the wallet argument is resolved.

#### Scenario: No auth header is sent in either path

- **WHEN** `sdk.projects.list(wallet)` or `sdk.projects.list()` (with allowance fallback) is invoked
- **THEN** the outgoing HTTP request contains no `Authorization`, `SIGN-IN-WITH-X`, or session-token header added by the SDK beyond what the underlying fetch wrapper sends by default
