## ADDED Requirements

### Requirement: Add custom domain (MCP)
The `add_custom_domain` tool SHALL accept `domain` (string, required), `subdomain_name` (string, required), and `project_id` (string, optional). It SHALL call `POST /domains/v1` with `service_key` auth. It SHALL return the domain record with DNS instructions formatted prominently for the LLM to relay to the human.

#### Scenario: Successful domain registration
- **WHEN** `add_custom_domain` is called with `domain: "example.com"`, `subdomain_name: "myapp"`, and a valid `project_id`
- **THEN** the tool returns a formatted response with the domain, mapped subdomain URL, status "pending", and DNS instructions including CNAME target and any TXT verification records

#### Scenario: Project not found
- **WHEN** `add_custom_domain` is called with a `project_id` not in the keystore
- **THEN** the tool returns `projectNotFound` error

#### Scenario: Invalid domain
- **WHEN** the backend returns 400 for an invalid domain
- **THEN** the tool returns `formatApiError` with context "registering custom domain"

### Requirement: List custom domains (MCP)
The `list_custom_domains` tool SHALL accept `project_id` (string, required). It SHALL call `GET /domains/v1` with `service_key` auth and return all custom domains for the project in a formatted table.

#### Scenario: Project has domains
- **WHEN** `list_custom_domains` is called for a project with registered domains
- **THEN** the tool returns a markdown table with domain, subdomain URL, status, and created date

#### Scenario: Project has no domains
- **WHEN** `list_custom_domains` is called for a project with no domains
- **THEN** the tool returns a message indicating no custom domains with guidance to use `add_custom_domain`

### Requirement: Check domain status (MCP)
The `check_domain_status` tool SHALL accept `domain` (string, required) and `project_id` (string, required). It SHALL call `GET /domains/v1/:domain` with `service_key` auth. It SHALL return the current domain status and DNS instructions if still pending.

#### Scenario: Domain is pending
- **WHEN** `check_domain_status` is called for a domain with status "pending"
- **THEN** the tool returns the status, DNS instructions, and guidance to wait for DNS propagation

#### Scenario: Domain is active
- **WHEN** `check_domain_status` is called for a domain with status "active"
- **THEN** the tool returns the status and confirms the domain is live with its URL

#### Scenario: Domain not found
- **WHEN** `check_domain_status` is called for a domain not registered in Run402
- **THEN** the tool returns `formatApiError` with the 404 response

### Requirement: Remove custom domain (MCP)
The `remove_custom_domain` tool SHALL accept `domain` (string, required) and `project_id` (string, optional). It SHALL call `DELETE /domains/v1/:domain` with `service_key` auth.

#### Scenario: Successful removal
- **WHEN** `remove_custom_domain` is called for a registered domain
- **THEN** the tool returns confirmation that the domain mapping has been released

#### Scenario: Domain not found
- **WHEN** `remove_custom_domain` is called for a domain that doesn't exist
- **THEN** the tool returns `formatApiError` with the 404 response

### Requirement: CLI domains module
The CLI SHALL expose a `domains` top-level command with subcommands `add`, `list`, `status`, `delete`. All subcommands SHALL use `resolveProject()` for optional project resolution. The `add` subcommand SHALL take `<domain> <subdomain_name>` as positional args. The `status` and `delete` subcommands SHALL take `<domain>` as positional arg. All SHALL accept `--project <id>` flag.

#### Scenario: CLI add domain
- **WHEN** `run402 domains add example.com myapp` is run with an active project
- **THEN** the CLI calls `POST /domains/v1` and prints the JSON response including DNS instructions

#### Scenario: CLI list domains
- **WHEN** `run402 domains list` is run with an active project
- **THEN** the CLI calls `GET /domains/v1` and prints the JSON response

#### Scenario: CLI status check
- **WHEN** `run402 domains status example.com` is run with an active project
- **THEN** the CLI calls `GET /domains/v1/example.com` and prints the JSON response

#### Scenario: CLI delete domain
- **WHEN** `run402 domains delete example.com` is run with an active project
- **THEN** the CLI calls `DELETE /domains/v1/example.com` and prints confirmation

### Requirement: OpenClaw shim
The OpenClaw `openclaw/scripts/domains.mjs` SHALL re-export the `run` function from `cli/lib/domains.mjs`.

#### Scenario: OpenClaw delegates to CLI
- **WHEN** the OpenClaw skill invokes the domains command
- **THEN** it delegates to the CLI module's `run()` function

### Requirement: Sync test registration
All 4 MCP tools and CLI commands SHALL be registered in the SURFACE array in `sync.test.ts`. The sync test SHALL pass with no missing or extra tools.

#### Scenario: Sync test passes
- **WHEN** `npm run test:sync` is run after adding all domain tools and commands
- **THEN** all inventory checks pass and the domains endpoints no longer appear in the llms.txt alignment failure

### Requirement: CLI documentation
The `llms-cli.txt` file SHALL include a `### domains` section documenting all 4 subcommands with usage, examples, and notes about DNS configuration.

#### Scenario: Documentation complete
- **WHEN** an agent reads `llms-cli.txt`
- **THEN** it finds complete documentation for `run402 domains add|list|status|delete` with DNS setup instructions
