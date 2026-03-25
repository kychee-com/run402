## 1. Core Implementation

- [x] 1.1 Update `listSecrets` query in `packages/gateway/src/services/functions.ts` to include `left(encode(sha256(value_encrypted::bytea), 'hex'), 8) AS value_hash`
- [x] 1.2 Update the return type of `listSecrets` to include `value_hash: string`

## 2. Tests

- [x] 2.1 Add test: list secrets returns `value_hash` field for each secret
- [x] 2.2 Add test: `value_hash` matches expected SHA-256 prefix for a known value
- [x] 2.3 Add test: `value_hash` changes after updating a secret's value

## 3. Documentation

- [x] 3.1 Update `site/llms.txt` secrets endpoint docs to mention `value_hash` field
- [x] 3.2 Update `site/llms-cli.txt` secrets section to mention `value_hash` in list output
