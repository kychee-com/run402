## ADDED Requirements

### Requirement: Error topic pages are generated from one registry and are the canonical envelope target

A single error registry SHALL be the source of truth for every error code. The portal SHALL generate the topic pages the runtime envelopes reference (`astro/errors`, `astro/images`, `functions/errors`, `sdk/errors`, `cache/errors`, `cache/concepts`, `deploy/errors`) with anchors that match the codes' published `docs` slugs verbatim. `docs.run402.com` SHALL be the canonical home; the in-code `docs:` URLs SHALL resolve here (the run402-private re-point is a tracked cross-repo dependency).

#### Scenario: Every envelope docs URL resolves

- **WHEN** an error envelope's `docs` URL (e.g. `https://docs.run402.com/astro/errors#build-failed`) is followed
- **THEN** the portal SHALL serve the topic page with a section anchored at that exact slug

#### Scenario: Topic pages are generated, not hand-maintained

- **WHEN** a code is added to the registry
- **THEN** rebuilding the docs SHALL produce its topic-page section without hand-editing the page

### Requirement: The two error families are presented distinctly

The `/errors/` landing SHALL distinguish **control-plane/CLI** errors (envelope `status:"error"` with `retryable` / `safe_to_retry` / `mutation_state`; codes like `PAYMENT_REQUIRED`, `PROJECT_FROZEN`, `MIGRATION_FAILED`) from **application-runtime** errors (envelope `ok:false` with `suggestedFix` / `docs`; `R402_*` codes). The docs SHALL NOT imply a single universal envelope.

#### Scenario: Error families are separated

- **WHEN** a developer opens `/errors/`
- **THEN** the page SHALL show two families with their distinct envelope shapes and not present them as one universal envelope
