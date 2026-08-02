# Run402 Identity Lens

A small live demonstration of the identity boundary between a Run402-deployed
tenant app, the Run402 control plane, and Buzz/Nostr.

Live at [identity-lens.run402.com](https://identity-lens.run402.com).

## What it proves

| Identity | Automatically visible to the deployed app? | Explicit path |
| --- | --- | --- |
| Run402 agent principal | No | Authenticated control-plane provenance or an app-specific handoff |
| Run402 human principal / org role | No | Explicit human login/consent; tenant auth is a separate identity population |
| Buzz/Nostr identity | No | Public dual-signature proof by known `identity_link_id` |
| x402 caller | Only on a priced routed function | Gateway-confirmed payment context exposes the payer wallet, not an automatic Buzz profile |

The page's `/api/inspect` function returns a redacted summary of a real public
request. It never echoes headers, cookies, credentials, or fingerprinting data.
The public proof form calls Run402's unauthenticated
`/identity-link-proofs/v1/:identity_link_id` endpoint directly and renders only
public attribution evidence.

## Run locally

Serve `site/index.html` with any static server. The anonymous request probe needs
the deployed `/api/inspect` route, while public proof inspection works locally.

## Deploy

From this directory:

```sh
run402 up --name "Identity Lens" --yes --verify
```
