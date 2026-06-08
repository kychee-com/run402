## ADDED Requirements

### Requirement: Agent-facing docs have defined canonical serving locations

The agent-facing documentation surface SHALL be split into two roles with distinct canonical hosts:

- **Discovery layer (apex `run402.com`):** the `llms.txt` wayfinder SHALL be canonically served at `https://run402.com/llms.txt`, and the agent-skills discovery index SHALL be canonically served at `https://run402.com/.well-known/agent-skills/index.json`. These SHALL NOT be served from the run402 platform itself, so discovery never depends on the platform it advertises.
- **Deep references (`docs.run402.com`):** the comprehensive references `llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`, and the `SKILL.md` skill body SHALL be canonically served at `https://docs.run402.com/<doc>`, hosted on run402's own static hosting.

`docs.run402.com` SHALL be a run402-hosted static site reached via a custom domain bound to a managed `*.run402.app` subdomain.

#### Scenario: Wayfinder canonical location is the apex

- **WHEN** an agent fetches `https://run402.com/llms.txt`
- **THEN** it SHALL receive the wayfinder document
- **AND** the wayfinder SHALL be served from the apex CloudFront origin, not from the run402 platform

#### Scenario: Deep reference canonical location is the docs subdomain

- **WHEN** an agent fetches `https://docs.run402.com/llms-cli.txt`
- **THEN** it SHALL receive the comprehensive CLI reference
- **AND** the bytes SHALL be served from a run402-hosted static site

#### Scenario: Discovery index canonical location is the apex

- **WHEN** an agent fetches `https://run402.com/.well-known/agent-skills/index.json`
- **THEN** it SHALL receive the agent-skills discovery index served from the apex

### Requirement: The wayfinder points to deep references by their canonical docs.run402.com URLs

The apex `llms.txt` wayfinder SHALL reference each comprehensive surface document (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`) and `SKILL.md` using its `https://docs.run402.com/<doc>` URL. The wayfinder SHALL NOT direct agents to `https://run402.com/<doc>` for any moved document.

#### Scenario: Agent routed to the docs subdomain for a deep reference

- **WHEN** an agent reads the wayfinder and wants the comprehensive CLI reference
- **THEN** the wayfinder SHALL give it `https://docs.run402.com/llms-cli.txt`

#### Scenario: Wayfinder retains apex links only for discovery

- **WHEN** the wayfinder references the discovery index or its own location
- **THEN** those links SHALL remain `https://run402.com/...`

### Requirement: In-repo cross-references resolve to canonical locations

Within the moved documents, links to other deep references or to `SKILL.md` SHALL use `https://docs.run402.com/<doc>`, while links to the wayfinder or the discovery index SHALL remain `https://run402.com/...`. The repository's documentation map (`documentation.md`) SHALL record the canonical host of each agent-facing doc and SHALL match the serving split above.

#### Scenario: Deep reference cross-link uses the docs subdomain

- **WHEN** `llms-cli.txt` references the SDK reference
- **THEN** the link SHALL be `https://docs.run402.com/llms-sdk.txt`

#### Scenario: Deep reference link to the wayfinder stays on the apex

- **WHEN** a moved document references the `llms.txt` wayfinder entry point
- **THEN** the link SHALL be `https://run402.com/llms.txt`

#### Scenario: Documentation map reflects the split

- **WHEN** a contributor reads `documentation.md`
- **THEN** the canonicality notes and per-surface rows SHALL state the moved docs are served at `docs.run402.com` and the wayfinder/index at `run402.com`

### Requirement: Discovery index advertises SKILL.md at its canonical URL with a non-drifting digest

The agent-skills discovery index entry for the run402 skill SHALL set `url` to `https://docs.run402.com/SKILL.md` and `digest` to `sha256:<hex>` computed over the exact `SKILL.md` bytes published to `docs.run402.com`. The public repo SHALL be the authoritative producer of this digest; the apex deploy SHALL consume the public-produced digest rather than recomputing it from a separately fetched copy.

#### Scenario: Index url points at the docs subdomain

- **WHEN** the discovery index is fetched
- **THEN** the skill entry `url` SHALL be `https://docs.run402.com/SKILL.md`

#### Scenario: Index digest matches the served SKILL.md bytes

- **WHEN** a scanner fetches the discovery index, reads the `sha256` digest, then fetches `https://docs.run402.com/SKILL.md`
- **THEN** the sha256 of the fetched `SKILL.md` bytes SHALL equal the index digest

### Requirement: Moved docs are served at a stable latest URL

Each moved document SHALL be served at a stable path that always returns the latest published bytes (e.g. `/llms-cli.txt`). The docs site SHALL NOT mint per-version immutable URLs; immutable version pins remain available via the public repo's git tags (e.g. `https://raw.githubusercontent.com/kychee-com/run402/v<version>/cli/llms-cli.txt`).

#### Scenario: Stable path returns the latest bytes

- **WHEN** a new docs release is published and an agent fetches `https://docs.run402.com/llms-cli.txt`
- **THEN** it SHALL receive the newest published CLI reference

### Requirement: Moved docs are served with the correct content type

The docs site SHALL serve `SKILL.md` with `Content-Type: text/markdown` and serve the `.txt` references with `Content-Type: text/plain`, so agents and skill scanners that branch on content type behave the same as on the prior apex hosting.

#### Scenario: SKILL.md content type

- **WHEN** an agent fetches `https://docs.run402.com/SKILL.md`
- **THEN** the response `Content-Type` SHALL be `text/markdown` (optionally with a charset)

#### Scenario: Text reference content type

- **WHEN** an agent fetches `https://docs.run402.com/llms-cli.txt`
- **THEN** the response `Content-Type` SHALL be `text/plain` (optionally with a charset)

### Requirement: Pre-move apex URLs for moved docs remain resolvable

To preserve externally cached or hard-coded links, requests to the pre-move apex URLs of the four moved documents SHALL resolve to their canonical `docs.run402.com` locations via an HTTP redirect rather than returning a 404.

#### Scenario: Old apex CLI reference URL redirects

- **WHEN** an agent requests `https://run402.com/llms-cli.txt`
- **THEN** it SHALL receive a redirect (301 or 308) to `https://docs.run402.com/llms-cli.txt`

#### Scenario: Old apex SKILL.md URL redirects

- **WHEN** an agent requests `https://run402.com/SKILL.md`
- **THEN** it SHALL receive a redirect (301 or 308) to `https://docs.run402.com/SKILL.md`
