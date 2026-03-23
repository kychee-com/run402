## Context

The CLI already has a pattern for `--file` flags: `storage upload --file`, `functions deploy --file`, and `deploy --manifest` all read content from disk. Two commands that take potentially complex inline content don't support this yet: `projects sql "<query>"` and `secrets set <id> <key> <value>`.

Both commands pass their content as positional args. This works for simple cases but breaks down with shell escaping for JSONB, multi-line SQL, PEM keys, etc.

MCP tools don't need this — they receive content inline from the LLM and have no filesystem access.

## Goals / Non-Goals

**Goals:**
- Add `--file <path>` to `projects sql` and `secrets set` as an alternative to inline content
- Maintain backward compatibility — inline args continue to work
- Follow the same pattern used by `functions deploy --file` and `storage upload --file`

**Non-Goals:**
- Changing MCP tool schemas (MCP tools receive inline content, `--file` is a CLI-only concern)
- Adding stdin support (could be done later but not needed now)
- Changing the `functions deploy` MCP schema field from `code` to something else

## Decisions

### 1. `--file` takes priority over positional arg

When both `--file` and an inline arg are provided, `--file` wins. This matches how `migrations_file` overrides `migrations` in deploy manifests. No error is thrown for providing both — the file simply takes precedence.

**Alternative**: Error when both are provided. Rejected because it adds friction without benefit — the user's intent is clear.

### 2. `readFileSync` with `utf-8` encoding

Both SQL and secret values are text. Use `readFileSync(path, "utf-8")` consistent with every other `--file` reader in the CLI (`functions.mjs`, `storage.mjs`, `deploy.mjs`).

### 3. No MCP changes

MCP tools operate in a context where the LLM provides content inline. File paths are meaningless in MCP — the host machine's filesystem is not the MCP client's filesystem. The existing `sql` and `value` params are correct for MCP.

## Risks / Trade-offs

- [File not found errors] → Same error behavior as `functions deploy --file` — Node throws, caught by the process. Could add a friendlier message but not strictly necessary for consistency.
