## 1. Core Implementation

- [x] 1.1 Add `RUN402_ALLOWANCE_PATH` check to `getAllowancePath()` in `core/src/config.ts` — if set, return it directly, skip config dir and migration logic
- [x] 1.2 Add unit tests in `core/src/config.test.ts` covering the three spec scenarios: env var set, env var not set, env var set with legacy wallet.json present

## 2. Documentation

- [x] 2.1 Add `RUN402_ALLOWANCE_PATH` to the env var table in `CLAUDE.md`
- [x] 2.2 Add `RUN402_ALLOWANCE_PATH` to the env var table in `README.md`

## 3. Verification

- [x] 3.1 Run `npm test` — all pass; 1 pre-existing sync.test.ts failure (unrelated trigger endpoint)
- [x] 3.2 Manually verified: `RUN402_ALLOWANCE_PATH=/tmp/test-allowance.json` returns custom path; unset returns default
