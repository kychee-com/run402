## Why

The gateway change `surface-ci-binding-revocation-on-transfer` (run402-private) now makes `POST /ci/v1/token-exchange` return a distinguishable `binding_revoked` (HTTP 403) when a subject-matching CI/OIDC binding exists but was **revoked** — most often because the project was transferred or handed to a new owner, which suspends the prior org's CI bindings. This is distinct from `access_denied` (no binding ever matched).

But the canonical envelope `code` collapses to the generic `FORBIDDEN` for both, so consumers that branch on `code` cannot tell them apart. Today the `@run402/astro` uploader maps the generic 403 to its `asset_key_scopes` hint and points the operator at `run402 ci set-asset-scopes` — the **wrong** fix, which itself `409`s on a revoked binding. This was the red herring in the kychee-com/run402#470 incident (three Kychon demos broke after their projects were transferred). The actionable fix is to re-create the binding with `run402 ci link github`.

This change tracks the consumer-side cascade (kychee-com/run402#473, Ask 1): make `binding_revoked` discriminable in the SDK and surface the correct re-link remediation in the `@run402/astro` uploader and the CLI deploy flow.

## What Changes

- Add an SDK guard `isCiBindingRevoked(err)` that detects the `binding_revoked` token-exchange denial by reading the OAuth-style `error` field on the 403 body (the only discriminator, since the canonical `code` is the generic `FORBIDDEN`). Export `CI_BINDING_REVOKED_ERROR` (`"binding_revoked"`) and add the code to the `CiTokenExchangeErrorCode` union. The thrown error stays an `Unauthorized` — `isUnauthorized` remains true, so existing generic-403 handling is unaffected (no regression).
- Make the `@run402/astro` uploader map a `binding_revoked` token-exchange failure to a dedicated `CI_BINDING_REVOKED` upload-error code with a re-link remediation hint, instead of the misleading asset-scope hint. A revoked binding is terminal (never retried).
- Make the CLI `run402 deploy apply` GitHub-OIDC error guidance recognize `binding_revoked` (and, more generally, key token-exchange guidance off the OAuth `error` field, since the canonical `code` collapses to `FORBIDDEN`/`INVALID_AUTH`) and print the re-link next-action.
- Update consumer-facing docs (`sdk/llms-sdk.txt`, `cli/llms-cli.txt`, `astro/README.md`).
- Defer `run402 ci list --include-revoked` (kychee-com/run402#473 Ask 2): it needs a new gateway list flag (`GET /ci/v1/bindings?include_revoked=1`) that does not exist yet.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ci-oidc-client-surface`: the SDK now discriminates the `binding_revoked` token-exchange denial via a typed guard, in addition to preserving the gateway code in the error body.
- `ci-github-actions-dx`: the deploy CLI's actionable CI-error guidance now covers `binding_revoked` with a re-link remediation.

## Impact

- **SDK**: new `isCiBindingRevoked` guard + `CI_BINDING_REVOKED_ERROR` constant + union member in `sdk/src/namespaces/ci.ts` / `ci.types.ts`, root re-export in `sdk/src/index.ts`, unit tests in `sdk/src/namespaces/ci.test.ts`. No kernel change; no new error subclass.
- **Astro**: `astro/src/uploader.ts` (`extractErrorCode` maps `binding_revoked` → `CI_BINDING_REVOKED`), `astro/src/errors.ts` (new `CI_BINDING_REVOKED` hint), `astro/README.md`, `astro/src/uploader.test.ts`. Independent `/publish-astro` cadence.
- **CLI**: `cli/lib/deploy-v2.mjs` guidance map + `error`-field keying, `cli-deploy-ci.test.mjs`, `cli/llms-cli.txt`.
- **Docs**: `sdk/llms-sdk.txt`, `cli/llms-cli.txt`, `astro/README.md` per `documentation.md`.
- **No breaking changes**: additive only; `binding_revoked` is a new gateway string, and the thrown error remains an `Unauthorized`.
