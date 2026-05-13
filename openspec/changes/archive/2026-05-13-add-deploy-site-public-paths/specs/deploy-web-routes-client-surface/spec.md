## ADDED Requirements

### Requirement: Static route docs distinguish route-only aliases from direct public paths

Public route documentation SHALL distinguish static route targets from `site.public_paths`.

Docs SHALL state that `site.public_paths` is the preferred surface for ordinary clean static URLs such as `/events -> events.html`. Static route targets SHALL be documented as route-table entries for exact, method-aware static aliases, such as static `GET /login` coexisting with function `POST /login`.

Docs SHALL state that a static route target's `target.file` is a release static asset path, not a public path, URL, CAS hash, rewrite destination, or redirect target. In explicit public path mode, a static route target can serve a private release asset at the route URL without making the asset filename directly reachable.

#### Scenario: Clean static URL docs prefer public paths

- **WHEN** public docs explain how to serve `events.html` at `/events`
- **THEN** they SHALL show `site.public_paths` as the preferred ordinary static URL authoring surface
- **AND** they SHALL NOT require a `routes.replace` static target for that simple case

#### Scenario: Method-aware static alias remains route based

- **WHEN** public docs explain static `GET /login` plus function `POST /login`
- **THEN** they SHALL use route entries for the method-aware behavior
- **AND** they SHALL state that fallback happens only when no method-compatible route entry matches

#### Scenario: Static route target can reference private asset

- **WHEN** docs explain a static route target `/events` with `target.file: "events.html"`
- **THEN** they SHALL state that `events.html` is a release static asset path
- **AND** they SHALL state that `/events.html` is not publicly reachable in explicit mode unless separately declared in `site.public_paths`

### Requirement: Static route warning guidance uses public path vocabulary

Static route warning guidance SHALL refer to direct public static paths, route-only static aliases, and release static asset paths using distinct wording.

Guidance for duplicate canonical URL and shadowing warnings SHALL tell callers to inspect `static_public_paths`, active routes, and resolve diagnostics when available. It SHALL NOT imply that every release static asset path is directly public.

#### Scenario: Duplicate canonical guidance handles explicit mode

- **WHEN** docs describe `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`
- **THEN** they SHALL explain that the warning applies when another direct public path is reachable
- **AND** they SHALL avoid saying that the target asset filename is always public

#### Scenario: Shadowing guidance points to public path inventory

- **WHEN** docs describe route/static shadowing warnings
- **THEN** they SHALL tell callers to inspect active routes and `static_public_paths`
- **AND** they SHALL distinguish the route pattern from the backing `asset_path`
