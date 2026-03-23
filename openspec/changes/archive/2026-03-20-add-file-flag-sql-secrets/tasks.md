## 1. CLI: projects sql --file

- [x] 1.1 Add `readFileSync` import to `cli/lib/projects.mjs`
- [x] 1.2 Update `sqlCmd` to parse `--file <path>` from args and read SQL from disk when provided (file takes precedence over positional query)
- [x] 1.3 Update help text to show `--file` option on the `sql` subcommand line and add an example

## 2. CLI: secrets set --file

- [x] 2.1 Add `readFileSync` import to `cli/lib/secrets.mjs`
- [x] 2.2 Update `set` function signature to accept extra args, parse `--file <path>`, and read value from disk when provided (file takes precedence over positional value)
- [x] 2.3 Update help text to show `--file` option on the `set` subcommand line and add an example
- [x] 2.4 Update `run()` switch case to pass remaining args to `set`

## 3. Tests

- [x] 3.1 Add e2e test for `projects sql --file` in `cli-e2e.test.mjs`
- [x] 3.2 Add e2e test for `secrets set --file` in `cli-e2e.test.mjs`

## 4. Docs

- [x] 4.1 Update `llms-cli.txt` to document `--file` on `projects sql` and `secrets set`
