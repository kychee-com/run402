## ADDED Requirements

### Requirement: Astro Peer Range Includes The Current Compatible Major

`@run402/astro` SHALL declare an Astro peer dependency range that includes every Astro major version the package intentionally supports. For this change, the range SHALL include Astro 7 and SHALL continue to include Astro 6 unless implementation code starts depending on Astro 7-only public APIs.

#### Scenario: Astro 7 installs without a peer warning

- **WHEN** a consumer installs `@run402/astro` into a project using `astro@7.x`
- **THEN** the package manager SHALL consider the installed Astro version inside `@run402/astro`'s declared peer dependency range

#### Scenario: Astro 6 remains inside the support window

- **WHEN** a consumer installs `@run402/astro` into an existing project using `astro@6.x`
- **THEN** the package manager SHALL consider the installed Astro version inside `@run402/astro`'s declared peer dependency range

### Requirement: Latest Supported Astro Major Is Exercised By Package Validation

The repository validation for `@run402/astro` SHALL run the Astro package's tests and TypeScript package build against the latest declared Astro major in the workspace lockfile.

#### Scenario: Package tests run against Astro 7

- **WHEN** `npm ci` installs the workspace lockfile after this change
- **THEN** the `@run402/astro` workspace SHALL resolve Astro 7 for its normal package test path
- **AND** `npm test --prefix astro` SHALL pass against that resolution

#### Scenario: Package build runs against Astro 7

- **WHEN** `core` and `sdk` build artifacts exist
- **THEN** `npm run build --workspace=astro` SHALL pass while the workspace resolves Astro 7

### Requirement: Init Astro Scaffold Uses Current Supported Dependency Ranges

`run402 init astro` SHALL generate a starter `package.json` whose dependency ranges are inside the current supported platform stack and are not pinned to a previously unsupported Astro major.

#### Scenario: Scaffold package uses Astro 7-compatible dependencies

- **WHEN** a user runs `run402 init astro ./my-app`
- **THEN** `./my-app/package.json` SHALL declare an Astro dependency range that can resolve Astro 7
- **AND** `@run402/astro` SHALL use a current major range compatible with the package version being released
- **AND** `@run402/functions` SHALL use the current auth-aware SSR major range required by `@run402/astro`

#### Scenario: Scaffold does not regress to the stale Astro 5 line

- **WHEN** a user runs `run402 init astro ./my-app`
- **THEN** `./my-app/package.json` SHALL NOT declare `astro: "^5.0.0"`
- **AND** SHALL NOT declare `@run402/astro: "^1.0.0"`
- **AND** SHALL NOT declare `@run402/functions: "^2.5.0"`

### Requirement: Documentation States The Compatibility Boundary

Public `@run402/astro` documentation SHALL describe the supported Astro major-version window and SHALL distinguish compatibility with Astro 7 from adoption of Astro 7-specific cache or routing features.

#### Scenario: Astro docs name the supported window

- **WHEN** a user reads `astro/README.md`
- **THEN** the install or compatibility section SHALL state that `@run402/astro` supports Astro 6 and Astro 7 for this release line

#### Scenario: Astro 7-only features are not implied as Run402 features

- **WHEN** a user reads the Astro compatibility documentation
- **THEN** it SHALL NOT imply that Astro 7 route caching, advanced routing through `src/fetch.ts`, or other Astro 7-only runtime features are newly supported by Run402 unless those features have their own explicit requirement and implementation
