## MODIFIED Requirements

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
