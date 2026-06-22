## 1. Package Compatibility

- [x] 1.1 Update `astro/package.json` peer dependency from `astro >=6 <7` to an Astro 6+7 support window.
- [x] 1.2 Update `astro/package.json` dev dependency to resolve Astro 7 for the normal workspace install.
- [x] 1.3 Refresh the root `package-lock.json` from a clean install so `@run402/astro` resolves Astro 7 and the matching Astro 7 transitive dependency set.
- [x] 1.4 Verify package metadata does not introduce a hard runtime dependency on optional Astro peers.

## 2. Scaffold Freshness

- [x] 2.1 Update `cli/lib/init-astro.mjs` generated `package.json` dependencies to Astro 7-compatible `astro`, current `@run402/astro`, and current `@run402/functions` major ranges.
- [x] 2.2 Add or update CLI tests that inspect `run402 init astro` output and reject stale `astro: "^5.0.0"`, `@run402/astro: "^1.0.0"`, and `@run402/functions: "^2.5.0"` scaffold dependencies.
- [x] 2.3 Confirm the existing stdout/stderr JSON output contract for `run402 init astro` remains unchanged.

## 3. Documentation

- [x] 3.1 Update `astro/README.md` install/compatibility language from Astro 6-only to Astro 6 and Astro 7 support.
- [x] 3.2 Update `astro/CHANGELOG.md` with the Astro 7 compatibility release note, including that Astro 7-only route caching and `src/fetch.ts` routing are not newly adopted.
- [x] 3.3 Scan `documentation.md` guidance for `@run402/astro` changes and update any additional public repo docs that mention the exclusive Astro 6 support window.

## 4. Verification

- [x] 4.1 Run `npm ci` from a clean workspace and verify `@run402/astro` resolves Astro 7.
- [x] 4.2 Run `npm run build:core && npm run build:sdk && npm run build --workspace=astro`.
- [x] 4.3 Run `npm test --prefix astro`.
- [x] 4.4 Run the relevant CLI scaffold tests, including the `init astro` assertions.
- [x] 4.5 Optionally perform an Astro 6 smoke install/build before publish if the implementation changes adapter APIs beyond package metadata, scaffold, docs, and lockfile. Not needed here; no adapter APIs changed.
