## ADDED Requirements

### Requirement: transfer-accept surfaces the new owner's project keys

`AcceptTransferResult` SHALL include `anon_key: string` and `service_key: string` — the project credentials the gateway returns to the new owner on accept (#428). `r.admin.transfers.accept` SHALL surface them on the returned object.

#### Scenario: accept result carries the project keys
- **WHEN** `r.admin.transfers.accept(transferId)` succeeds and the gateway returns `anon_key`/`service_key`
- **THEN** the returned `AcceptTransferResult` SHALL expose both as strings

### Requirement: accept persists the keys so the recipient can operate immediately

`r.admin.transfers.accept` SHALL persist the returned keys for the accepted project via the credential provider's `saveProject` and SHALL set it active via `setActiveProject` (when the provider supports them), mirroring `provision`, so the new owner can deploy / set secrets / run SQL with no extra provisioning step.

#### Scenario: keys are written to the keystore on accept
- **WHEN** `accept` succeeds with keys and the provider supports `saveProject`/`setActiveProject`
- **THEN** the accepted `project_id` SHALL be stored with its `anon_key`/`service_key` and set active

#### Scenario: providers without persistence are unaffected
- **WHEN** the provider does not implement `saveProject`
- **THEN** `accept` SHALL still return the keys without throwing
