## 0. Pre-flight

- [x] 0.1 Verify MajorTal/run402#34 is merged (GET /domains/v1/:domain has serviceKeyAuth). If not, flag and proceed with auth in code anyway.

## 1. MCP Tools

- [x] 1.1 Create `src/tools/add-custom-domain.ts` — Zod schema (`domain`, `subdomain_name`, `project_id`), handler calls `POST /domains/v1` with service_key, formats response with DNS instructions
- [x] 1.2 Create `src/tools/list-custom-domains.ts` — schema (`project_id`), handler calls `GET /domains/v1`, formats as markdown table
- [x] 1.3 Create `src/tools/check-domain-status.ts` — schema (`domain`, `project_id`), handler calls `GET /domains/v1/:domain`, formats status + DNS instructions if pending
- [x] 1.4 Create `src/tools/remove-custom-domain.ts` — schema (`domain`, `project_id` optional), handler calls `DELETE /domains/v1/:domain`
- [x] 1.5 Register all 4 tools in `src/index.ts`
- [x] 1.6 Add unit tests for all 4 tools (mock fetch, temp keystore pattern)

## 2. CLI

- [x] 2.1 Create `cli/lib/domains.mjs` with `add`, `list`, `status`, `delete` subcommands and help text. Use `resolveProject()` for optional project, `--project` flag for add/status/delete.
- [x] 2.2 Register `domains` case in `cli/cli.mjs` dispatch switch

## 3. OpenClaw

- [x] 3.1 Create `openclaw/scripts/domains.mjs` — re-export `run` from `cli/lib/domains.mjs`

## 4. Sync Test

- [x] 4.1 Add 4 entries to SURFACE array in `sync.test.ts` (add_custom_domain, list_custom_domains, check_domain_status, remove_custom_domain with cli/openclaw `domains`)
- [x] 4.2 Remove `/domains/v1` endpoints from IGNORED_ENDPOINTS if present, or verify they're now covered by SURFACE
- [x] 4.3 Run `npm test` and confirm sync test passes (including llms.txt alignment for domains endpoints)

## 5. Documentation

- [x] 5.1 Add `### domains` section to `~/dev/run402/site/llms-cli.txt` with all 4 subcommands, examples, and DNS configuration notes
