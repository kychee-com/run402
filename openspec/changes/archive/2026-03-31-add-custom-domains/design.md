## Context

The backend already has 4 domain endpoints (`POST/GET/DELETE /domains/v1`). This repo needs MCP tools, CLI commands, and OpenClaw shims to expose them. The pattern is well-established — subdomains, secrets, storage, and functions all follow the same structure.

MajorTal/run402#34 adds `serviceKeyAuth` to `GET /domains/v1/:domain` (status check). We assume this is merged before shipping.

## Goals / Non-Goals

**Goals:**
- Expose all 4 domain endpoints through MCP, CLI, and OpenClaw
- Follow existing tool/command patterns exactly (Zod schemas, `formatApiError`, `findProject`, `resolveProject`)
- Pass the sync test (add to SURFACE array)
- Document in `llms-cli.txt`

**Non-Goals:**
- No bundle-deploy `domain` field (future scope)
- No domain verification polling loop in the MCP tool (the LLM can call `check_domain_status` repeatedly)
- No domain tier limits (not implemented backend-side yet)

## Decisions

### 1. New top-level `domains` module, not nested under `subdomains`

Domains have their own API surface (`/domains/v1`), own lifecycle (pending → active), and own auth patterns. Nesting under subdomains would conflate two different resources. Every other API surface (functions, storage, secrets, email) has its own module.

### 2. MCP tool naming follows existing conventions

| Tool | Endpoint |
|------|----------|
| `add_custom_domain` | `POST /domains/v1` |
| `list_custom_domains` | `GET /domains/v1` |
| `check_domain_status` | `GET /domains/v1/:domain` |
| `remove_custom_domain` | `DELETE /domains/v1/:domain` |

`add_` prefix (not `create_`) because the domain already exists — we're registering it. `remove_` (not `delete_`) because we're releasing the mapping, not destroying the domain.

### 3. CLI argument pattern: `domains <sub> [<id>] <domain> [<subdomain>]`

```
domains add [<id>] <domain> <subdomain_name>   # register
domains list [<id>]                              # list project domains
domains status [<id>] <domain>                   # check status
domains delete [<id>] <domain>                   # release
```

`<id>` is optional everywhere — falls back to active project via `resolveProject()`. This matches subdomains, secrets, storage.

`status` needs `<id>` for auth (post-#34). We could make it the first positional arg when it looks like a project_id (`prj_*`), otherwise treat the first arg as the domain. Same heuristic isn't needed — just use `resolveProject(args[0])` or flags.

Actually, simplest: `domains status <domain> [--project <id>]` — domain is required, project is optional flag or active. Avoids the positional ambiguity of `<id> <domain>` (is `example.com` a project id or domain?).

### 4. `add_custom_domain` MCP tool must surface DNS instructions prominently

The `POST /domains/v1` response includes `dns_instructions` — the critical handoff to the human. The MCP tool's formatted output must make these unmissable:

```
## Custom Domain Registered

Domain: example.com → myapp.run402.com
Status: pending

## DNS Configuration Required

Add the following DNS records at your domain registrar:
- CNAME: example.com → domains.run402.com
- TXT: _cf-custom-hostname.example.com → <token>

After DNS propagates, check status with `check_domain_status`.
```

### 5. CLI uses `--project` flag (not positional `<id>`) for add/status/delete

For `list`, the positional `[<id>]` pattern is fine (matches `subdomains list [<id>]`). For `add`, `status`, and `delete`, the domain is the primary positional arg, and `--project` is the optional override. This avoids the `<id> <domain>` positional ordering issue that caused bug #20.

```
domains add example.com myapp                         # active project
domains add example.com myapp --project prj_123       # explicit
domains status example.com                            # active project
domains delete example.com                            # active project
```

## Risks / Trade-offs

- **MajorTal/run402#34 dependency**: If the status endpoint stays unauthenticated, `check_domain_status` still works — it just won't need a project_id. We code it with auth and it degrades gracefully if #34 isn't merged yet.
- **DNS propagation UX**: The agent can't automate DNS configuration. The MCP tool output must clearly tell the LLM to relay DNS instructions to the human. No risk to mitigate — just good output formatting.
