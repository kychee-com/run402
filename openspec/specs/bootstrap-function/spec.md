### Requirement: Fork accepts bootstrap variables
The `POST /fork/v1` endpoint SHALL accept an optional `bootstrap` field in the request body. The field SHALL be a JSON object with arbitrary key-value pairs that are passed to the bootstrap function.

#### Scenario: Fork with bootstrap variables
- **WHEN** an agent sends `POST /fork/v1` with `{ "version_id": "v_abc", "name": "my-app", "bootstrap": { "admin_email": "user@example.com", "seed_demo_data": true } }`
- **THEN** the platform SHALL fork the app and invoke the bootstrap function with the provided variables

#### Scenario: Fork without bootstrap variables
- **WHEN** an agent sends `POST /fork/v1` without a `bootstrap` field
- **THEN** the platform SHALL fork the app normally; if a bootstrap function exists, it SHALL be invoked with an empty object `{}`

#### Scenario: Fork without bootstrap function in bundle
- **WHEN** an agent sends `POST /fork/v1` with a `bootstrap` field, but the forked app has no function named `bootstrap`
- **THEN** the platform SHALL fork the app normally and include `"bootstrap_result": null` in the response (no error)

### Requirement: Deploy accepts bootstrap variables
The `POST /deploy/v1` endpoint SHALL accept an optional `bootstrap` field in the request body, with the same semantics as fork.

#### Scenario: Bundle deploy with bootstrap
- **WHEN** an agent sends `POST /deploy/v1` with a bundle that includes a function named `bootstrap` and a `bootstrap` field with variables
- **THEN** the platform SHALL deploy the bundle and invoke the bootstrap function with the provided variables after all other deployment steps complete

### Requirement: Bootstrap function invocation
After a successful fork or deploy, if the project has a deployed function named `bootstrap`, the platform SHALL invoke it as a POST request with the caller's `bootstrap` object as the JSON body. The function SHALL be invoked with the project's `service_key` for auth.

#### Scenario: Bootstrap function receives variables
- **WHEN** the platform invokes the bootstrap function
- **THEN** the function SHALL receive a standard `Request` object where `await req.json()` returns the caller's bootstrap variables object

#### Scenario: Bootstrap invoked after all deploy steps
- **WHEN** a fork or deploy includes schema, functions, site, secrets, and subdomain
- **THEN** the bootstrap function SHALL be invoked only after all other steps have completed (schema applied, all functions deployed, site live, secrets set)

#### Scenario: Bootstrap function uses getUser and db
- **WHEN** the bootstrap function runs
- **THEN** it SHALL have access to the full `@run402/functions` helper (`db`, `getUser`) and all project secrets via `process.env`

### Requirement: Bootstrap result in response
The fork/deploy response SHALL include the bootstrap function's return value as `bootstrap_result`.

#### Scenario: Successful bootstrap
- **WHEN** the bootstrap function returns a 200 response with a JSON body `{ "login_url": "https://app.run402.com/claim?token=abc" }`
- **THEN** the fork/deploy response SHALL include `"bootstrap_result": { "login_url": "https://app.run402.com/claim?token=abc" }`

#### Scenario: No bootstrap function
- **WHEN** the forked/deployed app has no function named `bootstrap`
- **THEN** the response SHALL include `"bootstrap_result": null`

### Requirement: Bootstrap errors do not fail the fork
If the bootstrap function fails (returns non-200, throws, or times out), the fork/deploy SHALL still succeed. The response SHALL include `bootstrap_error` instead of `bootstrap_result`.

#### Scenario: Bootstrap function throws
- **WHEN** the bootstrap function throws an error during execution
- **THEN** the fork/deploy response SHALL have status 201 (created), include all normal fields (`project_id`, `service_key`, etc.), and include `"bootstrap_error": "Bootstrap function failed: <error message>"` instead of `bootstrap_result`

#### Scenario: Bootstrap function times out
- **WHEN** the bootstrap function exceeds its timeout
- **THEN** the fork/deploy response SHALL succeed with `"bootstrap_error": "Bootstrap function timed out"`

#### Scenario: Bootstrap function returns non-200
- **WHEN** the bootstrap function returns a 400 or 500 status
- **THEN** the fork/deploy response SHALL succeed with `"bootstrap_error": "Bootstrap function returned <status>: <body>"`

### Requirement: Bootstrap variables declared in run402.yaml
Published apps MAY declare expected bootstrap variables in their `run402.yaml` manifest under a `bootstrap.variables` array. Each variable declaration SHALL include `name` (string) and `description` (string), and MAY include `type` (string, default `"string"`), `required` (boolean, default `false`), and `default` (any).

#### Scenario: Manifest with bootstrap variables
- **WHEN** an app is published with a `run402.yaml` containing:
  ```yaml
  bootstrap:
    variables:
      - name: admin_email
        type: string
        required: true
        description: "Email for the first admin user"
      - name: seed_demo_data
        type: boolean
        required: false
        default: false
        description: "Populate with sample data"
  ```
- **THEN** the published `app_versions` row SHALL store the bootstrap variable declarations

#### Scenario: Manifest without bootstrap section
- **WHEN** an app is published without a `bootstrap` section in `run402.yaml`
- **THEN** the published version SHALL have no bootstrap variable metadata (the bootstrap function can still exist and work — declarations are optional metadata)

### Requirement: Bootstrap variables in app metadata
The `GET /v1/apps/:versionId` endpoint SHALL include `bootstrap_variables` in the response if the published version has declared them.

#### Scenario: App inspection with bootstrap variables
- **WHEN** an agent calls `GET /v1/apps/:versionId` for a version that declared bootstrap variables
- **THEN** the response SHALL include `"bootstrap_variables": [{ "name": "admin_email", "type": "string", "required": true, "description": "Email for the first admin user" }, ...]`

#### Scenario: App inspection without bootstrap variables
- **WHEN** an agent calls `GET /v1/apps/:versionId` for a version with no bootstrap declarations
- **THEN** the response SHALL include `"bootstrap_variables": null` or omit the field

### Requirement: Bootstrap function is manually re-invokable
The bootstrap function SHALL be a regular deployed function that can also be invoked manually via `POST /functions/v1/bootstrap` with the project's `apikey`. This allows agents to retry bootstrap or re-run it with different variables.

#### Scenario: Manual bootstrap invocation
- **WHEN** an agent calls `POST /functions/v1/bootstrap` with `apikey` header and a JSON body `{ "admin_email": "new@example.com" }`
- **THEN** the bootstrap function SHALL execute normally, same as if invoked by the platform

#### Scenario: Retry after bootstrap error
- **WHEN** the automatic bootstrap failed during fork (returned in `bootstrap_error`)
- **THEN** the agent SHALL be able to retry by calling `POST /functions/v1/bootstrap` manually with corrected variables
