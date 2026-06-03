# cli-wallet-profiles Specification

## Purpose
TBD - created by archiving change named-wallet-profiles. Update Purpose after archive.
## Requirements
### Requirement: Named Wallets Are Stored As Profile Directories

The CLI SHALL store each named wallet as a self-contained profile directory at `{config_dir}/profiles/<name>/`, containing that wallet's own `allowance.json` (signing key + funding state), `projects.json` (project API-key cache and that wallet's own `active_project_id`), and a non-secret `meta.json` (`name`, `address`, `label`, `created`). The pre-existing single wallet SHALL remain at the config-dir root and be addressable as the reserved name `default`. No file SHALL be moved on upgrade for installs that never create a named wallet.

The globally-selected default wallet SHALL be recorded in a base-level `{config_dir}/config.json` as `active_wallet` — distinct from the per-profile `active_project_id`, which continues to live inside each wallet's `projects.json`.

#### Scenario: Creating a named wallet writes under profiles/

- **WHEN** a user runs `run402 wallets new kychon`
- **THEN** a directory `{config_dir}/profiles/kychon/` SHALL be created containing `allowance.json` and `meta.json`
- **AND** the root `{config_dir}/allowance.json` (the `default` wallet) SHALL be left unchanged

#### Scenario: Default wallet stays at root with zero migration

- **WHEN** an existing install that has never created a named wallet runs any command
- **THEN** the wallet at `{config_dir}/allowance.json` SHALL be used as `default`
- **AND** no `profiles/` directory SHALL be required to exist

#### Scenario: Each wallet remembers its own active project

- **WHEN** wallet `client-a` has `active_project_id` X and wallet `client-b` has `active_project_id` Y
- **THEN** selecting `client-a` SHALL resolve the active project to X
- **AND** selecting `client-b` SHALL resolve the active project to Y

### Requirement: Wallet Selection Follows A Deterministic Precedence Chain

The CLI SHALL resolve the active wallet in this order, highest first: (1) the `--wallet <name>` flag; (2) the `RUN402_WALLET` environment variable; (3) the nearest `.run402.json` / `.run402.local.json` directory binding found by walking up from the current working directory; (4) the global default recorded by `wallets use` in base `config.json`; (5) the reserved `default` wallet. `--profile` and `RUN402_PROFILE` SHALL be accepted as hidden aliases for the flag and env var respectively.

Profile resolution SHALL occur before any subcommand module (and therefore before `cli/lib/config.mjs` path snapshotting) is loaded, so that all credential paths resolve under the selected wallet.

#### Scenario: Flag beats everything

- **WHEN** `RUN402_WALLET=personal` is set, the cwd binds to `client-a`, and a command is run with `--wallet kychon`
- **THEN** the CLI SHALL operate on wallet `kychon`

#### Scenario: Global default applies when no flag, env, or binding is present

- **WHEN** a user has run `run402 wallets use kychon` and runs a later command in an unbound directory with no flag or env var
- **THEN** the CLI SHALL operate on wallet `kychon`

#### Scenario: Falls back to default when nothing selects a wallet

- **WHEN** no flag, env var, directory binding, or global default is set
- **THEN** the CLI SHALL operate on the reserved `default` wallet at the config-dir root

### Requirement: Conflicting Env And Directory Binding Produce An Error

When `RUN402_WALLET` and the nearest directory binding resolve to *different* wallet names and no `--wallet` flag is supplied, the CLI SHALL exit non-zero with a structured error that names both conflicting values and lists the available resolutions, and SHALL NOT proceed with either wallet. When they name the same wallet, or when `--wallet` is supplied, the CLI SHALL proceed without error. The flag is therefore the universal escape hatch and conflict resolver.

#### Scenario: Divergent env and binding error out

- **WHEN** `RUN402_WALLET=personal` is set and the nearest `.run402.json` declares `client-a`, with no `--wallet` flag
- **THEN** the CLI SHALL exit non-zero
- **AND** stderr SHALL contain a structured error naming both `personal` and `client-a`
- **AND** the error SHALL list resolutions: pass `--wallet <name>`, unset `RUN402_WALLET`, or `run402 wallets unbind`
- **AND** no wallet-affecting action SHALL be performed

#### Scenario: Matching env and binding proceed silently

- **WHEN** `RUN402_WALLET=client-a` is set and the nearest binding also declares `client-a`
- **THEN** the CLI SHALL operate on `client-a` without error

#### Scenario: Flag resolves the conflict

- **WHEN** env and binding disagree but `--wallet kychon` is supplied
- **THEN** the CLI SHALL operate on `kychon` without error

### Requirement: Per-Directory Binding Uses A Commit-Safe File

A directory MAY bind itself to a wallet through `.run402.json` containing only a wallet name (`{ "wallet": "<name>" }`) and never any key material. Resolution SHALL walk up from the current working directory to the nearest such file. A sibling `.run402.local.json` (intended to be gitignored) SHALL override a `.run402.json` in the same directory. The binding file SHALL be distinct from the deploy manifest (`run402.config.json`) so it never interacts with strict `ReleaseSpec` validation.

#### Scenario: Nearest binding wins when walking up

- **WHEN** `/work/acme/.run402.json` declares `client-a` and a command runs in `/work/acme/api` with no closer binding
- **THEN** the CLI SHALL resolve the binding to `client-a`

#### Scenario: Local override beats the committed binding

- **WHEN** a directory contains both `.run402.json` (`client-a`) and `.run402.local.json` (`client-a-staging`)
- **THEN** the CLI SHALL resolve the binding to `client-a-staging`

#### Scenario: Binding to an unknown wallet fails closed

- **WHEN** the resolved binding names a wallet that does not exist locally
- **THEN** the CLI SHALL exit non-zero with an error stating the named wallet was not found
- **AND** SHALL NOT silently fall back to the default wallet

### Requirement: Wallet Management Command Family

The CLI SHALL provide a `run402 wallets` command group: `list`, `current`, `new <name>`, `use <name>`, `rename <old> <new>`, `bind [<name>]`, `unbind`, `import <name>`, and `rm <name>`. Success-path stdout SHALL follow the established CLI output contract (the natural JSON payload, with no top-level `status` wrapper). `wallets current` SHALL report the resolved wallet name together with its selection source. Machine-readable wallet identity fields SHALL use `local_label` (the local profile/selector name) and `server_label` (the server-side display label, or `null`), consistent with `run402 status`.

#### Scenario: List enumerates wallets without secrets

- **WHEN** a user runs `run402 wallets list`
- **THEN** stdout SHALL contain a JSON array of wallet descriptors with `local_label`, `server_label`, short `address`, `rail`, and an `active` flag
- **AND** the listing SHALL be readable from `meta.json` without loading any private key

#### Scenario: Current reports name and provenance

- **WHEN** a user runs `run402 wallets current` in a directory bound to `client-a`
- **THEN** stdout SHALL contain at least `{ local_label: "client-a", server_label, source: "binding", ... }`
- **AND** the `source` SHALL identify which precedence rung selected the wallet

#### Scenario: bind writes a commit-safe file

- **WHEN** a user runs `run402 wallets bind client-a`
- **THEN** `./.run402.json` SHALL be written declaring `client-a`
- **AND** the command SHALL state that the file is safe to commit because it contains no secrets

#### Scenario: rm is guarded

- **WHEN** a user runs `run402 wallets rm client-a`
- **THEN** the CLI SHALL require explicit confirmation before deleting the profile directory

### Requirement: Renaming A Wallet Migrates Its Directory

`run402 wallets rename <old> <new>` SHALL move `{config_dir}/profiles/<old>/` to `{config_dir}/profiles/<new>/`. Renaming the reserved `default` wallet SHALL migrate the root-level credential files into `{config_dir}/profiles/<new>/` and update the `active_wallet` pointer if it referenced `default`. A named wallet SHALL always be a directory; there SHALL be no folderless-but-named wallet.

#### Scenario: Renaming a named wallet moves its directory

- **WHEN** a user runs `run402 wallets rename client-a acme`
- **THEN** `profiles/acme/` SHALL contain the wallet previously at `profiles/client-a/`
- **AND** `profiles/client-a/` SHALL no longer exist

#### Scenario: Renaming default migrates the root wallet

- **WHEN** a user runs `run402 wallets rename default kychon`
- **THEN** the root `allowance.json` / `projects.json` SHALL be moved into `profiles/kychon/`
- **AND** the wallet SHALL thereafter be selectable as `kychon`

### Requirement: Non-Default Selection Is Reported With Provenance

When a non-default wallet is selected for a command, the CLI SHALL emit to stderr the resolved wallet name, short address, and the selection source (flag, env, the binding file path, or global default). Operations on the reserved `default` wallet SHALL emit no such line, preserving the existing single-wallet experience. A `--quiet` flag SHALL suppress the provenance line.

#### Scenario: Deploy under a bound wallet shows provenance

- **WHEN** a user runs `run402 deploy apply` in a directory bound to `client-a`
- **THEN** stderr SHALL include a line naming `client-a`, its short address, and `./.run402.json` as the source

#### Scenario: Default wallet stays silent

- **WHEN** a user runs a command with the `default` wallet active and no profiles configured
- **THEN** the CLI SHALL NOT emit any new provenance line

### Requirement: Credential File Permissions Are Hardened

Allowance credential files SHALL be stored with mode `0600`. The legacy `wallet.json` → `allowance.json` auto-migration SHALL chmod the result to `0600` after the rename (which otherwise preserves the source mode). On read, the CLI SHALL self-heal an allowance file whose mode is looser than `0600` by tightening it and emitting a stderr warning. Profile directories (`profiles/` and each `profiles/<name>/`) SHALL be created with mode `0700`.

#### Scenario: Migrated legacy world-readable wallet is tightened

- **WHEN** a legacy `wallet.json` with mode `0644` is auto-migrated to `allowance.json`
- **THEN** the resulting `allowance.json` SHALL have mode `0600`

#### Scenario: Profile directories are owner-only

- **WHEN** a named wallet is created
- **THEN** its `profiles/<name>/` directory SHALL be created with mode `0700`

