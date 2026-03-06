# CLAUDE.md

## Lint

Run `npm run lint` before committing. ESLint enforces `no-explicit-any` on all production source code.

## Shell Commands

Never use `$()` command substitution or heredocs with `$(cat <<...)` in Bash calls. Instead:
- Run commands separately and use the literal output values in subsequent calls.
- For git commits, use a simple single-line `-m` flag or multiple `-m` flags for multi-line messages.
This avoids permission prompts from the harness.
