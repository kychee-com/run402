## 1. Public Type Surface

- [x] 1.1 Inventory every public SDK namespace option, input, result, event, and helper type referenced by exported method signatures or public properties.
- [x] 1.2 Add missing type exports to `sdk/src/index.ts`, grouped by namespace and including currently deep-only public types such as blob, email, billing, auth, contracts, functions, projects, allowance, tier, service, sites, apps, sender-domain, domains, subdomains, and secrets types.
- [x] 1.3 Add or adjust `sdk/src/node/index.ts` type re-exports so `@run402/sdk/node` exposes the complete isomorphic type surface plus Node-only types.
- [x] 1.4 Confirm the generated declaration files expose the same public type names from `@run402/sdk` and `@run402/sdk/node`.

## 2. Type Export Drift Guards

- [x] 2.1 Add a type-level contract test or script that compiles imports of all public SDK types from `@run402/sdk`.
- [x] 2.2 Extend the contract to compile imports of all isomorphic public types and Node-only helper types from `@run402/sdk/node`.
- [x] 2.3 Wire the type export contract into the SDK or root test path so CI fails when a public type is omitted from entrypoint exports.
- [x] 2.4 Update SDK documentation snippets or preambles if newly exported types should replace local inference workarounds.

## 3. Structured Local Error Conversion

- [x] 3.1 Identify all plain `throw new Error(...)` paths under `sdk/src` and classify each as public SDK failure or internal-only helper.
- [x] 3.2 Convert public local validation failures in `allowance`, `blobs`, `billing`, `email`, and `projects` to `LocalError` or another appropriate `Run402Error` subclass.
- [x] 3.3 Preserve existing message text where practical and assign accurate `context` strings for every converted local error.
- [x] 3.4 Add or update unit tests asserting converted local failures satisfy `isRun402Error`, serialize with `toJSON()`, and narrow through `isLocalError` where applicable.

## 4. Plain Error Drift Guard

- [x] 4.1 Add a regression guard that fails on new public SDK `throw new Error(...)` occurrences.
- [x] 4.2 Add a narrow allowlist for internal-only plain errors that cannot escape public SDK operations, with an inline justification for each allowlisted path.
- [x] 4.3 Wire the guard into the SDK or root test path so CI catches future plain-error regressions.

## 5. Verification

- [x] 5.1 Run the SDK type/export contract checks.
- [x] 5.2 Run the structured local error unit tests.
- [x] 5.3 Run `npm run check:docs` in `sdk/` or the equivalent repo test target that includes SDK documentation snippets.
- [x] 5.4 Run the relevant SDK unit tests and `npm test` if the local environment permits.
