# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

Email **info@run402.com** with:

- Description of the vulnerability
- Steps to reproduce
- Affected package(s): `run402-mcp`, `run402` CLI, or OpenClaw skill
- Impact assessment (if known)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

Please **do not** open a public GitHub issue for security vulnerabilities.

## Scope

This policy covers:

- The `run402-mcp` MCP server (npm package)
- The `run402` CLI (npm package)
- The OpenClaw skill (`openclaw/`)
- Local credential storage (`~/.config/run402/`)

The Run402 API (`api.run402.com`) is operated by Kychee LLC. Report API-side vulnerabilities to the same email address.

## Security Design

- **Credential storage**: Project keys and allowance private keys are stored locally at `~/.config/run402/` with `0600` permissions (owner read/write only). Atomic writes via temp-file + rename prevent partial-write corruption.
- **No secrets in transit to MCP clients**: The MCP server never sends private keys or service keys in tool responses. Keys are stored locally and used internally for API authentication.
- **Allowance isolation**: Allowance private keys never leave the local machine. They are used only for signing x402 payment transactions.
- **SQL safety**: The API blocks dangerous SQL operations (CREATE EXTENSION, COPY PROGRAM, ALTER SYSTEM, GRANT/REVOKE, etc.) at the gateway level.
- **Schema isolation**: Each project runs in its own Postgres schema with cross-schema access blocked.
