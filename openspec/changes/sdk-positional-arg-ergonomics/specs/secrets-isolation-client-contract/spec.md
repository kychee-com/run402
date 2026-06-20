## MODIFIED Requirements

### Requirement: Secret values are written out-of-band

The public client surfaces SHALL teach and support the workflow where secret values are written through the secrets namespace before a deploy spec declares those keys in `secrets.require`. The canonical SDK shape SHALL be `r.project(projectId).secrets.set(key, { value })`; the positional `r.secrets.set(projectId, key, value)` primitive SHALL remain available as a `@deprecated` overload for one major-version window and SHALL behave identically.

#### Scenario: Agent sets a secret before requiring it

- **WHEN** an agent needs `OPENAI_API_KEY` for a function deploy
- **THEN** the docs and tools SHALL direct the agent to call `set_secret`, `run402 secrets set`, or `r.project(id).secrets.set` before deploying with `secrets.require: ["OPENAI_API_KEY"]`

#### Scenario: SDK uses shipped set-secret route

- **WHEN** `r.project(projectId).secrets.set(key, { value })`, or the deprecated `r.secrets.set(projectId, key, value)`, is called
- **THEN** the SDK SHALL send `POST /projects/v1/admin/{projectId}/secrets` with body `{ key, value }`, and the deprecated positional form SHALL additionally emit a single stderr deprecation notice for the method in the process

#### Scenario: CLI manifest contains secret values

- **WHEN** a CLI file or inline manifest contains legacy secret values under deploy secrets
- **THEN** the CLI SHALL fail with migration guidance instead of silently pre-setting values

#### Scenario: Legacy replace-all is rejected

- **WHEN** a compatibility surface receives `secrets.replace_all`
- **THEN** it SHALL fail with guidance that exact secret replacement is no longer representable in deploy specs
