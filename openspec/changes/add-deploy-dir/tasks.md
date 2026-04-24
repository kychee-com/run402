## 1. SDK Node implementation

- [x] 1.1 Create `sdk/src/node/sites-node.ts` with a `NodeSites` class extending the isomorphic `Sites`
- [x] 1.2 Implement an internal `walkDir(dir)` helper: recursive traversal using `node:fs/promises` (`readdir` with `withFileTypes: true`), yields `{ absPath, relPath }` pairs
- [x] 1.3 In `walkDir`, skip entries whose names match the default ignore list (`.git`, `node_modules`, `.DS_Store`) at every depth
- [x] 1.4 In `walkDir`, throw `Run402Error` when an entry's dirent indicates a symlink (`isSymbolicLink()`), naming the offending path
- [x] 1.5 Implement `readFileEntry(absPath)`: reads the buffer, attempts UTF-8 decode via `new TextDecoder("utf-8", { fatal: true }).decode(bytes)`, returns `{ encoding: "utf-8", data: string }` on success, `{ encoding: "base64", data: buf.toString("base64") }` on failure
- [x] 1.6 Implement `normalizePath(relPath)`: replaces backslashes with forward slashes (Windows support)
- [x] 1.7 Implement `NodeSites.deployDir({ project, dir, inherit?, target? })`: calls `walkDir`, collects `SiteFile[]`, throws `Run402Error` if the array is empty, otherwise delegates to `super.deploy(project, files, { inherit, target })`
- [x] 1.8 Throw `Run402Error` wrapping any `ENOENT` / `EACCES` from `walkDir` with a message identifying the `dir` argument
- [x] 1.9 Wire `NodeSites` into the Node `Run402` factory (`sdk/src/node/index.ts`) so that `r402.sites` is a `NodeSites` instance in Node builds while the isomorphic entry remains unchanged

## 2. SDK tests

- [x] 2.1 Create `sdk/src/node/sites-node.test.ts` using `node:test` + `tsx` + `node:fs/promises` with a temp-dir fixture helper
- [x] 2.2 Test: walks a nested directory and produces a manifest with POSIX-style relative paths
- [x] 2.3 Test: a UTF-8 text file (`index.html`) is included with `encoding: "utf-8"` and its raw text
- [x] 2.4 Test: a binary file (a buffer of random non-UTF-8 bytes) is included with `encoding: "base64"` and correct base64 round-trip
- [x] 2.5 Test: files under `.git/`, `node_modules/`, and `.DS_Store` entries are omitted
- [x] 2.6 Test: missing directory path throws `Run402Error` and issues no fetch call
- [x] 2.7 Test: directory containing only ignored entries throws `Run402Error` with a "no deployable files" message
- [x] 2.8 Test: a symlink in the tree (created with `fs.symlink`) causes `Run402Error` with the symlink path in the message
- [x] 2.9 Test: `inherit: true` is forwarded to the underlying `sites.deploy` call (mock fetch, assert the request body includes `inherit: true`)
- [x] 2.10 Test: Windows-style `path.relative` output (mocked or platform-guarded) is normalized to forward slashes in the manifest

## 3. MCP tool

- [x] 3.1 Create `src/tools/deploy-site-dir.ts` exporting `deploySiteDirSchema` (Zod: `{ project: string, dir: string, inherit?: boolean, target?: string }`) and `handleDeploySiteDir`
- [x] 3.2 In the handler, call `getSdk().sites.deployDir(args)` inside try/catch; on error, return `mapSdkError(err)`
- [x] 3.3 On success, return an MCP content array with the deployment URL and id in human-readable text
- [x] 3.4 Register the new tool in `src/index.ts` alongside the existing `deploy_site` registration
- [x] 3.5 Create `src/tools/deploy-site-dir.test.ts` using the standard test scaffold (env + keystore + mocked fetch + `_resetSdk()` in `beforeEach`)
- [x] 3.6 Test: happy-path invocation returns the URL in the MCP content array
- [x] 3.7 Test: `Run402Error` thrown by the SDK produces `isError: true` via `mapSdkError`

## 4. CLI subcommand

- [x] 4.1 Add a `deploy-dir` case to the `run()` dispatcher in `cli/lib/sites.mjs`
- [x] 4.2 Parse argv: positional `<path>`, `--project <id>` (required), `--inherit` (boolean flag), `--target <label>` (optional)
- [x] 4.3 Call `getSdk().sites.deployDir({ project, dir, inherit, target })`
- [x] 4.4 On success, `console.log(JSON.stringify({ status: "ok", deployment_id, url }))` and exit 0
- [x] 4.5 On failure, call `reportSdkError(err)` (existing helper; writes JSON envelope to stderr and exits 1)
- [x] 4.6 Add the `deploy-dir` subcommand to the CLI help text for the `sites` group
- [x] 4.7 Add a CLI e2e test case in `cli-e2e.test.mjs` covering the happy path (mocked server) and the `ENOENT` error path

## 5. Cross-cutting updates

- [x] 5.1 Extend `sync.test.ts`: add the `deploy_site_dir` MCP tool and `sites deploy-dir` CLI subcommand to the `SURFACE` array
- [x] 5.2 Extend `sync.test.ts`: map the new capability to `sdk.sites.deployDir` in `SDK_BY_CAPABILITY`
- [x] 5.3 Verify OpenClaw parity (the CLI re-export in `openclaw/scripts/sites.mjs` should pick up the new subcommand with no additional changes; the sync test confirms this)
- [x] 5.4 Update `SKILL.md`: add the new MCP tool to the tools table and the new CLI subcommand to the commands section
- [x] 5.5 Update `CLAUDE.md` only if a new convention emerged worth documenting (e.g. a shared `walkDir` utility); skip otherwise

## 6. Verification

- [x] 6.1 Run `npm run build:sdk` and confirm `sdk/dist/node/sites-node.js` is emitted
- [x] 6.2 Run `npm run build` and confirm the MCP server builds cleanly
- [x] 6.3 Run `npm test` — all unit tests pass, including the new SDK and MCP test files
- [x] 6.4 Run `npm run test:skill` — SKILL.md validation passes with the new tool documented
- [x] 6.5 Run `npm run test:sync` — MCP, CLI, OpenClaw, and SDK surfaces are in sync
- [x] 6.6 Run `npm run test:e2e` — CLI e2e suite passes including the new `deploy-dir` case
- [x] 6.7 Manual smoke: `node cli/run402.mjs sites deploy-dir <tmp-dir> --project <id>` against a local fixture succeeds end to end
