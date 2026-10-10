# Vendored: x402 `exact` on Lightning (`lnbtc`), client side

- Source: https://github.com/x402-foundation/x402, pull request #3688
  (`typescript/packages/mechanisms/lnbtc/src`)
- Commit: `896a7bd0ce3093d8ae5a4401b96468e37c4a6204`
- License: Apache-2.0 (`LICENSE` in this directory)

`@x402/lnbtc` is not on npm yet, so the Node SDK carries the part its Lightning
buyer needs: the request binding, the BOLT11 decoder, the validation rules, and
the `exact` client scheme. The server and facilitator halves live in the Run402
gateway. Remove this directory and import `@x402/lnbtc` once it is published.
The change that added it is `x402-lnbtc-image-demo` (run402-private).

Local modifications, and nothing else:

- Relative imports carry `.js` (`./binding` → `./binding.js`).
- `@noble/curves` and `@noble/hashes` imports carry `.js`, the subpath form of
  the v2 packages the SDK depends on.
- `@noble/curves` v2 API names: `Signature.fromBytes(sig, "compact")` for
  `Signature.fromCompact(sig)`, `Point` for `ProjectivePoint`, and
  `prehash: false` on `verify`, because v2 hashes the message by default and
  the BOLT11 digest is already a hash.

`shared-vectors.test.ts` runs the upstream binding and client vectors
(`exact_lnbtc.vectors.json`, fixture version 1) against this copy.
