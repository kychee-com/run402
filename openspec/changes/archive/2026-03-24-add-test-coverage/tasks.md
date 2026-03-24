## 1. Dependencies & Config

- [x] 1.1 Install `c8` as a devDependency in `packages/gateway`
- [x] 1.2 Add `coverage/` to root `.gitignore`

## 2. Test Scripts

- [x] 2.1 Add `test:unit` script to `packages/gateway/package.json` that globs `src/**/*.test.ts` with `node --test`
- [x] 2.2 Add `test:unit:coverage` script that wraps `test:unit` with `c8` (text + HTML + JSON reporters, excluding test files/node_modules/dist)
- [x] 2.3 Add root-level `test:unit` and `test:unit:coverage` scripts that delegate to gateway

## 3. CI Integration

- [x] 3.1 Add a coverage step to `.github/workflows/deploy-gateway.yml` that runs `test:unit:coverage` before the deploy step
- [x] 3.2 Configure coverage threshold (start at 50% lines) via c8 `--check-coverage` flag
- [x] 3.3 Verify CI workflow passes with current test suite

## 4. Validation

- [x] 4.1 Run `test:unit:coverage` locally and confirm text/HTML/JSON reports are generated
- [x] 4.2 Confirm `coverage/` directory is gitignored
- [x] 4.3 Record baseline coverage numbers in the PR description
