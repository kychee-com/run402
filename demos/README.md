# demos/

Example apps deployed **on run402**, each auto-deployed to its own run402 project
on push to `main` via **keyless GitHub OIDC** — no run402 credential is stored in
CI. Each push exchanges the GitHub Actions OIDC token for a short-lived,
deploy-scoped run402 CI session (run402's CI-binding / OIDC federation feature),
then deploys via `/content/v1` + `/apply/v1`.

## Layout

```
demos/
  _deploy/            # shared toolkit (no demo of its own)
    registry.mjs      # demos/<name>/app.json schema-as-code + no-secret invariant
    detect.mjs        # push-diff → deploy matrix (CLI: emits the GH matrix)
    apply.mjs         # the /content/v1 + /apply/v1 engine (CI-session or wallet)
    deploy.mjs        # per-demo dispatcher (provisioning-free)
    exchange-oidc.mjs # GitHub OIDC token → run402 CI session
    check-registry.mjs# CI gate: app.json valid + secret-free
  <name>/
    app.json          # checked-in, NON-SECRET deploy target (project_id, binding_id, …)
    public/           # static site (the generic deploy ships this)
    deploy.ts         # OPTIONAL — only for demos with functions/db (custom spec)
```

The deploy workflow is `.github/workflows/deploy-demos.yml`. A change under
`demos/<name>/**` deploys that demo; a change under `demos/_deploy/**` redeploys
all of them. Only **provisioned** demos (a real `project_id` in `app.json`) are
ever in the matrix.

## The registry — `demos/<name>/app.json`

Checked-in, **non-secret** map of `demo → run402 deploy target`. `project_id` is
public, `binding_id` is a revocable handle (useless without the GitHub OIDC
token), `oidc_subject`/`github_repository_id` are public. **No secret ever lives
here** — `check-registry.mjs` fails the build if it does.

## State of the demos

| Demo | URL | Status |
|---|---|---|
| `test-video` | https://test-vid.run402.com | ✅ provisioned + CI-deployed (static) |
| `passkeys` | https://passkeys.run402.com | ✅ provisioned + CI-deployed (static) |
| `cosmicforge` | (cosmic) | source-only — needs onboarding (function + OpenAI secret) |
| `evilme` | (evilme) | source-only — needs onboarding (function + DB + secrets) |
| `social-todo` | (social-todo) | source-only — needs onboarding (DB schema) |
| `mpp-test` | — | not a deployable app (local dual-rail payment server) |

Static demos need only an `app.json` (the generic `readStaticDir` ships
`public/`). Demos with functions / DB need a `deploy.ts` exporting
`async deploy({ baseUrl, auth, config })` that builds their release spec, plus
secrets set once at provisioning.

## Provisioning a demo (one-time, operator)

1. `run402 projects provision --name <demo> --wallet <deploy-wallet>` → `project_id`.
2. Mark it a system project (admin): `POST /projects/v1/admin/:id/system {is_system:true}` (non-billable/transferable/freezeable, deploy-tier-exempt).
3. Initial deploy + set secrets + claim the subdomain (free a stale claim with the admin `DELETE /subdomains/v1/:name` if needed).
4. `run402 ci link github --project <id> --repo kychee-com/run402 --environment demos --repository-id <id> --wallet <deploy-wallet>` → `binding_id`.
5. Record `project_id` / `binding_id` / `owner_wallet` into `demos/<name>/app.json` and commit. The next push deploys it keyless.
