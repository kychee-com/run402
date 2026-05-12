# Full-Stack Integration Coverage Map

| Surface | Coverage | Notes |
| --- | --- | --- |
| Allowance and paid live API access | Existing smoke suites plus full-stack prerequisite | The full-stack suite seeds an isolated allowance-backed config directory before provisioning. |
| Project lifecycle | Full-stack suite | Provisions a temporary project and deletes it in best-effort cleanup. |
| Unified deploy | Full-stack suite | Deploys database migrations, static site files, functions, routes, subdomain, and value-free secret declarations in one release. |
| Database migrations | Full-stack suite | Creates related tables, indexes, trigger-backed timestamps, and seeded rows. |
| Exposed REST tables and RLS context | Full-stack suite | Uses the deploy expose manifest and validates caller-context helper behavior with and without a user bearer token. |
| Static hosting | Full-stack suite | Fetches HTML, CSS, JS, runtime JSON, text, and discovery JSON through public URLs. |
| Routes | Full-stack suite | Verifies a static alias, a method-scoped function route, unsupported method behavior, and deploy diagnostics. Unsupported `GET /api/fullstack` must return method/route failure behavior and must not fall through to unrelated static fixture content. |
| Functions runtime | Full-stack suite | Deploys direct, routed, and scheduled functions; manually invokes the scheduled function. |
| Runtime helpers | Full-stack suite | Exercises `adminDb()`, `db(req)`, `getUser(req)`, `email`, and `ai` from deployed function code. |
| Auth | Full-stack suite | Configures password auth, signs up a temporary user, logs in through password grant, and uses the bearer token. |
| Blob storage and CDN diagnostics | Full-stack suite | Uploads via SDK, fetches the returned URL, diagnoses CDN state, uploads from inside a function, and cleans up keys idempotently. |
| Secrets | Full-stack suite | Checks missing-secret planning, deploys with `secrets.require`, and verifies runtime presence without exposing values. |
| Email | Gated in full-stack suite | Sends only when `RUN402_FULLSTACK_EMAIL_TO` is configured to an approved recipient or sink; otherwise records an explicit skip. |
| Text AI helpers | Full-stack suite with bounded skip for transient upstream failures | Uses moderation and only skips transient 429/5xx/network cases. |
| Release observability | Full-stack suite | Reads active release inventory, release-by-id inventory, no-op reapply behavior, release diff, routes, assets, and scheduled metadata. |
| MCP, CLI, SDK parity | Existing `test:sync`, CLI/MCP integration suites | Full-stack suite focuses platform behavior, not command-surface parity. |
| Custom domains | Gated / documented | Requires sticky DNS resources and is not safe as an ephemeral default. Configure a dedicated gated suite when stable domains are available. |
| Sender domains | Gated / documented | Requires sticky DNS and mailbox reputation resources. Not part of ephemeral default coverage. |
| Mailbox webhooks | Gated / documented | Requires a stable public webhook receiver. Not part of ephemeral default coverage. |
| Browser/UI behavior | Explicitly excluded | Browser functionality belongs in a browser/system test when needed. The integration suite stays headless and API-driven. |
| Downstream application SDK/CLI surfaces | Explicitly excluded | This suite validates Run402 platform behavior only. |
