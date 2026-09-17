# Documentation map

Use CLI by default for Run402 operations. Use the typed, opinionated SDK for programmatic TypeScript/JavaScript workflows, MCP for MCP-native hosts, and HTTP for intentional protocol integrations. CLI and MCP adapt the SDK's shared workflows over the API foundation. Shell scripts and CI remain valid CLI uses.

[Machine-readable inventory](docs/quality/documentation-inventory.json) owns the per-file classification, source digest, interface, outputs, URLs and named checks. [Maintainer change map](docs/quality/maintenance-map.md) identifies dependent surfaces. [Capability gaps](docs/quality/gaps.md) records unsupported paths without inventing commands.

## Review and publication evidence

A passing build is not a prose review or proof of deployment. Each entry has independent editorial, local-check and publication evidence. Pending entries remain pending until reviewed and verified. Historical records, normative protocols, legal text, generated mirrors and CI fixtures have explicit exceptions. Product and translated website pages are in scope. [Publication evidence](docs/quality/publication-evidence.json) records hosted checks and CI runs. The remaining live application acceptance requires an explicitly designated disposable project/profile and spending policy.

Run `node scripts/documentation-inventory.mjs` to reject newly discovered unclassified sources and contradictory default guidance. Register sources with `--write`, review their classification, and regenerate this view. Source hashes identify the bytes inspected; cross-repo snapshots require refresh when their owners change.

## Canonical authoring

- First deploy: `docs-site/src/content/docs/start/first-deploy.md` → `llms.txt` (180 lines). Other Start pages never enter this bundle.
- CLI: `docs-site/src/content/docs/cli/**` → index, named slices and full reference; preserve 48 KB/56 KB budgets.
- SDK/MCP: ordered topic sources under `docs-site/src/content/docs/{sdk,mcp}/` → complete stable flat references. Native examples are intentional.
- Generic installed skill: root `SKILL.md`, with matching OpenClaw body. Regenerate discovery digests and retain old immutable artifacts. MCP-only hosts follow the explicit native reference.
- HTTP: private `apps/marketing/llms-full.txt` and `openapi.json`; portal uses a pinned public snapshot.
- Errors: owned public metadata contributions → generated catalog/topics and compatibility destinations.

