## Context

The allowance file (wallet) location is resolved by `getAllowancePath()` in `core/src/config.ts`. Today it always returns `{configDir}/allowance.json` (with a legacy `wallet.json` migration). The only override is `RUN402_CONFIG_DIR`, which moves the entire config directory — keystore included.

Both `readAllowance()` and `saveAllowance()` already accept an optional `path` parameter, but it's only used by tests. All production callers go through `getAllowancePath()`.

## Goals / Non-Goals

**Goals:**
- Allow users to specify a custom allowance file path via `RUN402_ALLOWANCE_PATH` env var
- All three interfaces (MCP, CLI, OpenClaw) pick it up automatically
- Document the new env var in all relevant places

**Non-Goals:**
- CLI `--allowance-path` flag (can be added later if needed)
- Per-project wallet association in keystore
- Any changes to wallet creation, format, or migration logic

## Decisions

### 1. Single env var override in `getAllowancePath()`

Add `RUN402_ALLOWANCE_PATH` check at the top of `getAllowancePath()`. If set, return it directly — skip the config dir logic and legacy migration entirely.

**Rationale:** This is the narrowest change. All callers already go through `getAllowancePath()`, so one line covers MCP, CLI, and OpenClaw. The legacy migration only applies to the default config dir, so it's correct to skip it when the user explicitly specifies a path.

**Alternative considered:** Adding a second parameter to `readAllowance()` / `saveAllowance()` and threading it through callers. Rejected — more invasive, and the env var approach requires zero caller changes.

### 2. No path validation

`getAllowancePath()` returns the path; callers already handle missing files gracefully (`readAllowance` returns `null`, `saveAllowance` creates parent dirs). No need to add existence checks in the config layer.

### 3. Documentation updates are in-repo only

Update README, CLAUDE.md env var table, and MCP tool descriptions in this repo. The `llms.txt` / `llms-cli.txt` files in the run402 site repo should be updated separately.

## Risks / Trade-offs

- **[Risk] User points to nonexistent file** → Existing behavior handles this: `readAllowance` returns `null`, CLI prints "no allowance found", MCP returns error shape. No new failure mode.
- **[Risk] User sets path but runs `init`/`allowance create`** → `saveAllowance` will write to the custom path (since it calls `getAllowancePath()` internally). This is the correct behavior — the env var means "use this path for everything."
- **[Trade-off] Env var only, no flag** → Less discoverable than a CLI flag, but simpler and consistent with `RUN402_API_BASE` and `RUN402_CONFIG_DIR` patterns. Can add flags later.
