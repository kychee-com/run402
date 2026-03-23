### Requirement: Gateway SHALL transpile TypeScript to JavaScript before deployment
The gateway SHALL run esbuild `transform()` with `loader: "ts"` on user-submitted function code before embedding it in the Lambda shim or local function module. The transpiled output SHALL be valid ES module JavaScript.

#### Scenario: TypeScript function with type annotations deploys successfully
- **WHEN** a user deploys a function containing `export default async (req: Request): Promise<Response> => { return new Response("ok"); }`
- **THEN** the gateway transpiles the code to valid JavaScript (type annotations removed) and the function executes without `SyntaxError`

#### Scenario: TypeScript function with interface deploys successfully
- **WHEN** a user deploys a function containing an `interface` declaration and typed parameters
- **THEN** the gateway strips the interface and type annotations, and the function executes correctly

#### Scenario: Plain JavaScript function deploys unchanged
- **WHEN** a user deploys a function containing only valid JavaScript (no type annotations)
- **THEN** the gateway transpiles it (no-op for JS) and the function executes identically to before

### Requirement: Transpilation SHALL apply to both Lambda and local execution paths
The same transpilation logic SHALL be applied in `buildShimCode()` (Lambda path) and `writeLocalFunction()` (local dev path) to ensure consistent behavior.

#### Scenario: TypeScript function works in local dev mode
- **WHEN** `LAMBDA_ROLE_ARN` is not set and a user deploys a TypeScript function
- **THEN** the function is transpiled before being written to the local `.mjs` file and executes in-process without errors

#### Scenario: TypeScript function works in Lambda mode
- **WHEN** `LAMBDA_ROLE_ARN` is set and a user deploys a TypeScript function
- **THEN** the function is transpiled before being base64-encoded into the Lambda shim and executes without errors

### Requirement: Original source SHALL be preserved for publish/fork
The gateway SHALL store the original user-submitted code (TypeScript) in the `source` column, not the transpiled output. Transpilation is a deployment concern only.

#### Scenario: Forked function retains TypeScript source
- **WHEN** a user publishes a TypeScript function and another user forks it
- **THEN** the forked function contains the original TypeScript source code

### Requirement: Transpilation errors SHALL return clear 400 responses
If esbuild fails to transpile the user's code (e.g., syntax errors), the gateway SHALL return a 400 status with the esbuild error message so the user can fix their code.

#### Scenario: Invalid syntax returns actionable error
- **WHEN** a user deploys code with a syntax error (e.g., `export default async (req: => {`)
- **THEN** the gateway returns HTTP 400 with a body containing the esbuild error message indicating the line and column of the syntax error
