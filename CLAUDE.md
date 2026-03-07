# CLAUDE.md

## Lint

Run `npm run lint` before committing. ESLint enforces `no-explicit-any` on all production source code.

## Shell Commands

Never use `$()` command substitution or heredocs with `$(cat <<...)` in Bash calls. Instead:
- Run commands separately and use the literal output values in subsequent calls.
- For git commits, use a simple single-line `-m` flag or multiple `-m` flags for multi-line messages.
This avoids permission prompts from the harness.

## Bugsnag

Error monitoring is integrated in the Express gateway (`packages/gateway/src/server.ts`).

- **Project:** Run402 (project ID: `69ac52c4c1424e001a97f2c5`)
- **API key** (notifier): `0751ea52d07c1449d7cd2f7724de0ede` (also in `BUGSNAG_API_KEY` env var)
- **Auth token** (REST API): stored in AWS Secrets Manager as `eleanor/bugsnag-api-token`

### Querying errors via the API

Fetch the auth token:
```
AWS_PROFILE=kychee aws secretsmanager get-secret-value --secret-id eleanor/bugsnag-api-token --region us-east-1 --query SecretString --output text
```

List errors:
```
curl -s -H "Authorization: token <AUTH_TOKEN>" "https://api.bugsnag.com/projects/69ac52c4c1424e001a97f2c5/errors"
```

List events for a specific error:
```
curl -s -H "Authorization: token <AUTH_TOKEN>" "https://api.bugsnag.com/projects/69ac52c4c1424e001a97f2c5/errors/<ERROR_ID>/events"
```
