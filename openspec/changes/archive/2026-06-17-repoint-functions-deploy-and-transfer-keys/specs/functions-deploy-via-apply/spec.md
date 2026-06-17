## ADDED Requirements

### Requirement: function deploy routes through the unified apply path

`r.functions.deploy(projectId, { name, code, config?, deps?, schedule? })` SHALL deploy by building a one-function `ReleaseSpec` (`functions.patch.set` keyed by `name`, with the code as the `source`) and running it through the SDK apply engine. It SHALL NOT POST the removed `/projects/v1/admin/:project_id/functions` route. The public method signature and the `FunctionDeployResult` return type SHALL be unchanged.

#### Scenario: deploy submits a functions.patch.set plan to apply
- **WHEN** `r.functions.deploy("prj_x", { name: "hello", code: "export default ..." })` runs
- **THEN** the client SHALL `POST /apply/v1/plans` with a spec whose `functions.patch.set` contains a `hello` entry carrying the code as its content source, and SHALL NOT call `/projects/v1/admin/prj_x/functions`

#### Scenario: legacy config maps to the apply FunctionSpec shape
- **WHEN** `config: { timeout, memory }` is supplied
- **THEN** the submitted `FunctionSpec.config` SHALL carry `timeoutSeconds` / `memoryMb` derived from them

#### Scenario: user dependencies ride through the apply spec
- **WHEN** `deps: ["lodash"]` is supplied
- **THEN** the submitted `FunctionSpec.deps` SHALL carry `["lodash"]` (the apply path supports `deps` via capability `apply-v1-function-deps`), so the packages are installed and bundled — deploy SHALL NOT silently drop `deps`

#### Scenario: unknown project still fails fast
- **WHEN** `deploy` is called for a project absent from the local keystore
- **THEN** it SHALL throw `ProjectNotFound` before planning

### Requirement: the deploy result preserves the FunctionDeployResult contract

`deploy` SHALL return a `FunctionDeployResult` built from the input + apply outcome: `name`, `status` (`"deployed"` on success), `schedule`, `runtime`, `timeout`, `memory`, `url`, and `warnings`. `runtime_version` and `deps_resolved` SHALL be `null` (not surfaced via the apply path).

#### Scenario: result carries the deployed function identity + warnings
- **WHEN** an apply completes successfully
- **THEN** the result SHALL carry `name`, `status: "deployed"`, the requested `schedule`, and any apply warnings, with `runtime_version`/`deps_resolved` as `null`

### Requirement: deploy authorizes via the project.deploy gate, not the service key

`deploy` SHALL authorize through the standard apply credential (SIWX wallet, or the operator-approval `project.deploy` gate) and SHALL NOT send the project `service_key` as the deploy credential.

#### Scenario: no service-key bearer on the deploy request
- **WHEN** `deploy` submits the apply plan
- **THEN** the request SHALL NOT carry an `Authorization: Bearer <service_key>` header for the function deploy
