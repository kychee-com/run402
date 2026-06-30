## 1. Implementation

- [x] 1.1 Inventory remaining CLI/public-doc non-canonical `next_actions` shapes.
- [x] 1.2 Normalize CLI-authored `next_actions` in cache, secrets, functions, subdomains, deploy CI, and deploy-warning code paths to typed objects.
- [x] 1.3 Preserve SDK/API/gateway-provided non-empty `next_actions` while keeping CLI fallback guidance typed.
- [x] 1.4 Update public skill examples to use the canonical `type` discriminator.

## 2. Tests

- [x] 2.1 Add or update CLI output contract coverage that fails on bare-string or `{ action }` `next_actions` in `cli/lib`.
- [x] 2.2 Update affected CLI tests to assert typed next-action content.
- [x] 2.3 Run targeted verification for the CLI output contract and skill docs.
