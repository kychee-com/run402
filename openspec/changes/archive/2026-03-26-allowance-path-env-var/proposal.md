## Why

Users may want to use a different allowance (wallet) file than the default `~/.config/run402/allowance.json`. Two scenarios: (a) per-project wallets — different projects pay from different wallets, and (b) bring-your-own wallet — the user already has a wallet file elsewhere. Today the only override is `RUN402_CONFIG_DIR`, which moves the entire config directory. There's no way to point to a specific allowance file independently.

## What Changes

- Add a new `RUN402_ALLOWANCE_PATH` environment variable that, when set, overrides the default allowance file path
- Resolution order: `RUN402_ALLOWANCE_PATH` > `{RUN402_CONFIG_DIR}/allowance.json` > `~/.config/run402/allowance.json`
- Document the new env var in MCP tool descriptions, `llms.txt`, `llms-cli.txt`, and README
- No CLI flags — env var only for now

## Capabilities

### New Capabilities
- `allowance-path-override`: Support for `RUN402_ALLOWANCE_PATH` env var to specify a custom allowance file location

### Modified Capabilities

## Impact

- `core/src/config.ts` — `getAllowancePath()` gains env var check
- `core/src/allowance.ts` — `saveAllowance()` may need to respect the override path
- MCP tool descriptions that mention allowance location
- Documentation: README, `llms.txt`, `llms-cli.txt` in the run402 site repo
- All three interfaces (MCP, CLI, OpenClaw) benefit automatically since they share the core module
