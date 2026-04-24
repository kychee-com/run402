## Context

The SDK (`@run402/sdk`) has two entry points:

- **`@run402/sdk`** — isomorphic kernel. Runs in Node, Deno, Bun, and V8 isolates. Its `CredentialsProvider` interface treats allowance access (`readAllowance`, `saveAllowance`, `getAllowancePath`) as optional — sandbox providers that don't own a wallet need not implement it.
- **`@run402/sdk/node`** — Node-only wrapper. Always constructs a `NodeCredentialsProvider` that implements `readAllowance` against the local keystore (`~/.config/run402/allowance.json` or `RUN402_ALLOWANCE_PATH`).

`Projects.list(wallet)` in `sdk/src/namespaces/projects.ts` currently requires the wallet argument. Meanwhile `Allowance.faucet(address?)` in the same codebase already implements the exact pattern this change extends: accept the argument as optional, resolve via `credentials.readAllowance()` when omitted, throw descriptively when the provider cannot supply one.

The top of `sdk/src/credentials.ts` already blesses this runtime-error pattern:

> Namespace methods that need a missing optional method throw a descriptive error at runtime.

So the design space here is narrow: copy the shape of `allowance.faucet`'s optional-argument path into `projects.list`.

## Goals / Non-Goals

**Goals:**
- One-line ergonomics for the Node case: `await r.projects.list()` resolves the wallet from the local allowance.
- Zero breaking changes: every call site passing an explicit wallet (MCP's `handleListProjects`, user scripts, tests) keeps compiling and behaving identically.
- Clear, actionable error messages for the two failure modes an omitted wallet can hit.
- Structural parity with `allowance.faucet` — a future reader comparing the two methods should immediately recognize the same pattern.

**Non-Goals:**
- Changing the MCP `list_projects` tool schema or handler. The MCP tool is a thin shim that may eventually mirror the SDK's convention, but that's a separate agent-UX decision.
- Touching the CLI `run402 projects list` command. The CLI's `list` is a keystore-local listing — a different operation from the SDK's wallet-scoped list. No code path in the CLI calls `sdk.projects.list`.
- Auditing other namespace methods. The issue's audit already confirms no other SDK method currently takes a raw wallet address as a required argument.
- Changing `CredentialsProvider` interface. `readAllowance` stays optional.
- Adding a helper like `resolveWallet(client)` that multiple namespaces could share. Premature — there is exactly one method today that needs this logic.

## Decisions

### 1. Mirror `allowance.faucet`'s exact resolution shape

**Decision:** The fallback block inside `list()` matches the shape of `faucet()`:

```ts
async list(wallet?: string): Promise<ListProjectsResult> {
  let resolvedWallet = wallet;
  if (!resolvedWallet) {
    const reader = this.client.credentials.readAllowance;
    if (!reader) {
      throw new Run402Error(
        "projects.list() with no wallet requires a credential provider that implements readAllowance(). " +
          "Pass an explicit wallet, or use @run402/sdk/node.",
        null,
        null,
        "listing projects",
      );
    }
    const data = await reader.call(this.client.credentials);
    if (!data) {
      throw new Run402Error(
        "No local allowance configured. Run `run402 allowance create`, or pass an explicit wallet.",
        null,
        null,
        "listing projects",
      );
    }
    resolvedWallet = data.address;
  }
  const w = resolvedWallet.toLowerCase();
  return this.client.request<ListProjectsResult>(`/wallets/v1/${w}/projects`, {
    context: "listing projects",
    withAuth: false,
  });
}
```

**Alternative considered:** A shared `resolveWallet(client, arg, context)` helper exported from `namespaces/_util.ts`. Rejected because (a) only two methods in the entire SDK use this pattern today (`faucet`, `list`), (b) the existing `faucet` logic is inlined and would need to be refactored for parity, and (c) premature abstraction would lock in a shape before a third call site exists to confirm it. If a third method adds this pattern, factoring out a helper at that point becomes a natural two-line refactor.

### 2. Throw `Run402Error` (not `Unauthorized`) for both missing-provider and missing-allowance paths

**Decision:** Both "no `readAllowance` method" and "`readAllowance()` returned null" paths throw `Run402Error` directly with `context: "listing projects"`.

**Rationale:**
- The existing `allowance.faucet` throws plain `Error` for both paths today. `Run402Error` is strictly better because it carries the `context` field used by the MCP `mapSdkError` translator.
- `Unauthorized` is reserved for server-side auth failures (401s, missing session tokens for authenticated endpoints) per the current error hierarchy. `projects.list` is a public, no-auth endpoint — the problem isn't authentication, it's argument resolution.
- `PaymentRequired`, `ProjectNotFound`, `ApiError`, `NetworkError` are all clearly wrong for this use case.

**Alternative considered:** Introduce a new `ConfigurationError` subclass. Rejected — one thrown-error site doesn't justify a new exception type, and `Run402Error` with a descriptive `context` and message is already discoverable via `instanceof Run402Error`.

### 3. Error messages point at both escape hatches

**Decision:** Each error message names both ways out:

- Missing provider method: "Pass an explicit wallet, or use `@run402/sdk/node`." (two escape hatches: explicit arg, or switch entry point).
- Missing allowance data: "Run `run402 allowance create`, or pass an explicit wallet." (two escape hatches: create allowance, or explicit arg).

**Rationale:** A developer hitting these errors typically fits one of two profiles — either they're in a sandbox and forgot to pass the wallet (→ fix: pass wallet), or they're on Node but haven't set up an allowance (→ fix: `run402 allowance create`). Mentioning both fixes in each message handles both profiles without requiring the reader to inspect their environment first.

### 4. Preserve the `.toLowerCase()` step

**Decision:** The existing `const w = wallet.toLowerCase();` stays — `resolvedWallet.toLowerCase()` runs regardless of whether the caller passed the wallet or it came from the allowance.

**Rationale:** The backend endpoint treats wallet addresses case-insensitively, and the existing normalization is cheap insurance against case-mismatch bugs (e.g. checksum-cased addresses from external sources). Dropping it when the address comes from the allowance would be inconsistent.

### 5. No change to `ListProjectsResult` or any public type

**Decision:** The return type and shape are untouched. Only the input type changes (`string` → `string | undefined`).

**Rationale:** Callers who want to know which wallet was actually used can still read the address they passed, or call `allowance.export()` if they let the SDK default. The resolved wallet is not meaningful output — there's exactly one answer in the default case.

## Risks / Trade-offs

- **[Sandbox callers accidentally omit the wallet]** → Mitigation: the runtime error is loud, names both fixes, and carries `context: "listing projects"` for the MCP error translator. TypeScript's `wallet?: string` signature makes the optionality discoverable at the call site but doesn't advertise that a sandbox provider will reject it — a small ergonomic tax on sandbox callers to pay for the Node one-liner.

- **[Confusion with `allowance.faucet`'s resolution logic]** → Mitigation: both methods now use the same pattern. A future reader grepping for `readAllowance` will find both. If a third method is added later, a shared helper becomes the obvious refactor.

- **[Consumers relying on the non-optional signature for type inference]** → Mitigation: none needed. Making a required parameter optional is a TypeScript signature change that accepts the existing strict-mode shape — no existing `sdk.projects.list(wallet)` call loses type coverage.

- **[Allowance address differs from the wallet the caller actually cares about]** → Mitigation: the explicit-wallet path is unchanged. Ops tooling that lists projects for other wallets keeps passing the wallet explicitly, and the SDK documents this via JSDoc: "When `wallet` is omitted, the SDK uses the provider's local allowance address."
