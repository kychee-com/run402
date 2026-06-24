## ADDED Requirements

### Requirement: Broken links, anchors, and envelope docs URLs fail the build

CI SHALL fail the PR when any internal link or anchor does not resolve against the built site, or when any error code's emitted `docs` URL does not resolve to a real route and anchor.

#### Scenario: A dead internal link fails CI

- **WHEN** a page links to a path or anchor that the built site does not contain
- **THEN** the docs CI check SHALL fail

#### Scenario: An unresolved envelope docs URL fails CI

- **WHEN** a source `R402_*` (or control-plane) code emits a `docs` URL with no matching built page+anchor
- **THEN** the docs CI check SHALL fail

### Requirement: Examples type-check against current packages and cannot use retired exports

CI SHALL type-check every TypeScript/Astro fenced example against the currently published package exports, and SHALL fail when an example references a retired export (e.g. bare `getUser`) or a method/field absent from the real exports.

#### Scenario: A retired export in an example fails CI

- **WHEN** an example imports a retired export such as bare `getUser`
- **THEN** the docs CI check SHALL fail with a pointer to the example

### Requirement: Error-registry and source stay in lockstep; status is automated

CI SHALL fail when a source error code is missing from the registry, when a registry code is absent from source, or when two codes claim the same anchor. The docs "up to date" status SHALL be an automated result carrying the audited commit SHA + date, never a manual checklist mark.

#### Scenario: Registry/source drift fails CI

- **WHEN** a code exists in source but not the registry (or vice versa)
- **THEN** the parity check SHALL fail

#### Scenario: Documented peer range matches the package

- **WHEN** docs state a package's supported peer range
- **THEN** CI SHALL assert it equals the package's actual `peerDependencies`, failing on mismatch
