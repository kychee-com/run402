## ADDED Requirements

### Requirement: The llms-*.txt agent docs are single-sourced from the portal content

The flat agent-facing references `llms-cli.txt`, `llms-sdk.txt`, and `llms-mcp.txt` SHALL be generated from the portal's canonical documentation content (`docs-site/src/content/docs/{cli,sdk,mcp}/**`) by a build-time generator, rather than hand-authored. Editing the source content SHALL be the only authoring path; the generated flat files SHALL NOT be edited directly. Their canonical serving URLs (`https://docs.run402.com/llms-*.txt`) SHALL be unchanged by this generation. `SKILL.md` remains authored at the repo root in v1 — its agent-skills YAML frontmatter is part of the discovery digest — and single-sourcing it is deferred.

#### Scenario: One edit updates both surfaces (cli/sdk/mcp)

- **WHEN** an author edits a CLI documentation page under `docs-site/src/content/docs/cli/**` and regenerates
- **THEN** the change SHALL appear in the human portal's CLI page
- **AND** the same change SHALL appear in the generated `llms-cli.txt`

#### Scenario: Canonical flat-file URLs survive generation

- **WHEN** an agent fetches `https://docs.run402.com/llms-sdk.txt` after a regeneration
- **THEN** it SHALL receive the comprehensive SDK reference at the same canonical URL as before

### Requirement: Flat-file generation is deterministic and gated; the SKILL.md digest is preserved

The generator SHALL produce byte-identical output for identical source content (stable ordering, normalized line endings, no embedded timestamps or build identifiers). The committed `llms-*.txt` SHALL match a fresh generation, enforced by a CI regen-clean gate that fails when they differ. `SKILL.md` is not touched by this generator, so the agent-skills discovery index `digest` (the `sha256` of `SKILL.md`) is unaffected.

#### Scenario: Generator is reproducible

- **WHEN** the generator runs twice against unchanged source content
- **THEN** both runs SHALL produce byte-identical flat files

#### Scenario: Stale committed output fails CI

- **WHEN** source content is edited but the committed `llms-*.txt` are not regenerated
- **THEN** the CI regen-clean gate SHALL fail

#### Scenario: Discovery digest is preserved

- **WHEN** CI validates the agent-skills discovery index
- **THEN** the index `digest` SHALL still equal the `sha256` of the authored `SKILL.md`
