## Why

`projects.list(wallet)` currently requires the wallet address, even though the Node entry point (`@run402/sdk/node`) always has a local allowance whose address is the same wallet 95% of the time. Callers writing against `/node` end up with three lines of ceremony (read allowance → check it's configured → pass the address) to ask the most obvious question: "what are my projects?"

A precedent already exists on the same SDK: `allowance.faucet(address?)` accepts the wallet as optional and falls back to `credentials.readAllowance()?.address` when the provider supports it. Applying that convention to `projects.list()` collapses the common case to one line while leaving the explicit-wallet path untouched. Tracked in [kychee-com/run402#113](https://github.com/kychee-com/run402/issues/113).

## What Changes

- Make the `wallet` parameter optional on `Projects.list()` in the SDK. Signature becomes `list(wallet?: string): Promise<ListProjectsResult>` — purely additive; every existing caller that passes a wallet keeps working unchanged.
- When `wallet` is omitted, the SDK resolves it via `client.credentials.readAllowance()?.address` using the same pattern `allowance.faucet(address?)` uses today.
- When `wallet` is omitted AND `credentials.readAllowance` is not implemented (sandbox providers), throw `Run402Error` with `context: "listing projects"` and a message pointing at both escape hatches: pass an explicit wallet, or use `@run402/sdk/node`.
- When `wallet` is omitted AND `readAllowance()` returns `null` (no local allowance configured), throw `Run402Error` with a message suggesting `run402 allowance create` or passing an explicit wallet.
- Update SDK unit tests in `sdk/src/namespaces/projects.test.ts` to cover: explicit wallet still works, omitted wallet with allowance resolves correctly, omitted wallet without `readAllowance` throws descriptive error, omitted wallet with `readAllowance` returning null throws descriptive error.
- **Not in scope**: the MCP `list_projects` tool schema (`src/tools/list-projects.ts`), the CLI `run402 projects list` command (which is a keystore-local operation, not wallet-scoped), any server changes. No other SDK namespace method currently takes a raw wallet address as a required argument, so no other namespaces are touched. Future API additions that take a wallet (e.g. hypothetical `tier.status(wallet?)`) should follow this same convention from day one.

## Capabilities

### New Capabilities

- `projects-list-default-wallet`: Describes the `wallet?` optional-with-provider-fallback convention on `Projects.list()` — the fallback path via `credentials.readAllowance()`, the two failure modes (no `readAllowance` method; `readAllowance` returns null), and the preservation of the explicit-wallet call.

### Modified Capabilities

_None._ The `run402-sdk` capability (proposed in the unarchived `add-run402-sdk` change) defines the broader SDK surface; this change is narrowly scoped to a single method's signature. No requirement in any archived spec changes.

## Impact

- **Modified files**:
  - `sdk/src/namespaces/projects.ts` — change `list` signature, add fallback logic, add error paths.
  - `sdk/src/namespaces/projects.test.ts` — add test cases for each branch.
- **No new files**, no new public types.
- **No server changes** — the call still hits `GET /wallets/v1/:wallet/projects` with a resolved wallet.
- **No breaking changes** — every existing explicit-wallet call (in MCP's `list-projects.ts`, in user code, in tests) continues to compile and behave identically. The signature change is purely additive (`string` → `string | undefined`).
- **No MCP/CLI changes in this change**. The MCP `list_projects` tool keeps requiring `wallet` in its Zod schema — revisiting that is a separate call about agent UX, not SDK ergonomics. The CLI `run402 projects list` already operates on the local keystore and doesn't use `sdk.projects.list` at all.
- **Dependencies**: none added or changed.
- **Consumer-visible surface**: one SDK method argument becomes optional. TypeScript autocomplete advertises the default via the `?` syntax.
