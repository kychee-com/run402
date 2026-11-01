# Vendored: x402 `offer-receipt` extension, buyer side

- Source: `@x402/extensions` 2.29.0 (https://github.com/x402-foundation/x402,
  `typescript/packages/extensions/src/offer-receipt`)
- License: Apache-2.0 (`LICENSE` and `NOTICE` in this directory)

The Node SDK's x402 buyer (`paid-fetch.ts`) verifies wallet-rooted offers and
receipts, and of the whole `@x402/extensions` package it used only the eight
functions of the offer-receipt extension that read and verify EIP-712 offers
and receipts. Importing the package installed its other extensions' tree
(`@signinwithethereum/siwe`, `tweetnacl`, `ajv`, `jose` and a second `zod`)
for every CLI and MCP user, so the SDK carries those eight functions instead.

Local modifications, and nothing else:

- Only the buyer half: no offer or receipt signing, no JWS verification. A
  JWS offer is still decoded (its payload read) so `decodeSignedOffers`
  keeps its shape; `paid-fetch.ts` skips it, as before.
- `recoverTypedDataAddress` is passed in (`offerReceiptVerifiers`) rather
  than imported, so the module loads without viem, an optional peer.
- Base64 and base64url decoding use `Buffer` in place of `jose.base64url` and
  `@x402/core`'s `safeBase64Decode`, with the same validation regex.

`sdk/src/node/vendor/x402-offer-receipt/offer-receipt.test.ts` checks this
copy against offers and receipts signed with viem's `signTypedData`.
