## Context

Run402 supports two ways to create a project with pre-built content:

1. **Bundle deploy** (`POST /deploy/v1`) — agent provides SQL, functions, site, secrets inline
2. **Fork** (`POST /fork/v1`) — agent references a published app version, platform clones it

Both return credentials (`project_id`, `service_key`, `anon_key`) and a URL. Neither has a mechanism for post-deployment initialization — creating the first admin user, seeding demo data, or configuring app-specific settings.

Today, agents handle this manually with follow-up API calls (`/auth/v1/signup`, `db.sql()` to insert roles, etc.). This requires the agent to understand each app's internal schema, which defeats the purpose of one-click forkable apps.

The `@run402/functions` helper already supports `db` and `getUser`. Functions are deployed as part of both bundle deploy and fork. The platform already invokes functions via Lambda (or locally). The infrastructure for "call a function after deploy" exists — we just need the convention and the wiring.

## Goals / Non-Goals

**Goals:**
- Define a convention: a function named `bootstrap` gets auto-invoked after deploy/fork
- The caller passes variables; the function returns results; the platform includes both in the response
- Published apps declare their expected bootstrap variables for agent discoverability
- Works for admin setup, demo data seeding, and app configuration — all via the same mechanism

**Non-Goals:**
- No new runtime or execution model — bootstrap is a regular function invoked synchronously
- No schema validation of bootstrap variables by the platform — the function validates its own inputs
- No retry/queue — bootstrap runs once, synchronously, as part of the deploy/fork response
- No special permissions — bootstrap function runs with `service_key` like any other function
- No UI for bootstrap — it's an API-level concept for agents

## Decisions

### 1. Convention over configuration: function named `bootstrap`

If a project has a deployed function named `bootstrap`, the platform invokes it. No manifest flag needed to enable it — the function's existence IS the opt-in.

**Why:** Simplest possible convention. No new config surface. App authors just deploy a function. If they don't want bootstrap, they don't include the function. The `run402.yaml` `bootstrap_variables` declaration is optional metadata for discoverability, not a requirement for the feature to work.

**Alternative considered:** A `bootstrap: true` flag in `run402.yaml`. Rejected — adds a config step that provides no value over the function's existence.

### 2. Synchronous invocation, included in deploy/fork response

The bootstrap function is invoked after the project is fully deployed (schema, functions, site, secrets all applied). The function's response is included in the deploy/fork HTTP response as `bootstrap_result`.

**Why:** The agent needs the bootstrap result (e.g., login URL) immediately. Async would require polling. The bootstrap function should be fast (create a user, insert some rows) — well within Lambda's 10-30s timeout.

**Alternative considered:** Async invocation with a callback or polling endpoint. Rejected — adds complexity for a function that should take <5 seconds. If a bootstrap function is slow, that's the app author's problem to optimize.

### 3. Bootstrap receives variables via request body, not env vars

The platform invokes the bootstrap function as a POST with the caller's `bootstrap` object as the JSON body. The function reads `req.json()` like any other function call.

```typescript
// bootstrap function in SkMeld
import { db } from '@run402/functions';

export default async (req) => {
  const { admin_email, app_name, seed_demo_data } = await req.json();

  // Create admin user via auth API
  // Insert profile with owner_admin role
  // Optionally seed demo data
  // Generate invite token

  return new Response(JSON.stringify({
    login_url: `https://${subdomain}.run402.com/claim?token=${token}`,
    admin_email,
  }), { headers: { "Content-Type": "application/json" } });
};
```

**Why:** Consistent with how all functions work. No new API surface. The function is just a regular function that happens to be called automatically.

### 4. Bootstrap variables declared in run402.yaml for discoverability

Published apps can declare their expected variables:

```yaml
bootstrap:
  variables:
    - name: admin_email
      type: string
      required: true
      description: "Email for the first admin user"
    - name: app_name
      type: string
      required: false
      description: "Business or organization name"
    - name: seed_demo_data
      type: boolean
      required: false
      default: false
      description: "Populate with sample data for a quick tour"
```

This is stored on the published `app_versions` row and surfaced in `GET /v1/apps/:versionId`. Agents can read it before forking to know what to pass.

**Why:** Without this, agents would need to read the app's docs to know what bootstrap accepts. With it, the fork flow is fully self-describing: inspect app → read variables → fork with variables → done.

### 5. Bootstrap errors don't fail the fork

If the bootstrap function fails (throws, times out, returns non-200), the fork still succeeds. The response includes `bootstrap_error` instead of `bootstrap_result`. The project is live and usable — the agent can retry bootstrap manually or fix the issue.

**Why:** A fork involves x402 payment and resource provisioning. Failing the entire fork because of a bootstrap error (maybe a typo in the email) would waste money and leave orphaned resources. Better to succeed with a warning.

## Risks / Trade-offs

**[Bootstrap function timeout]** → A slow bootstrap (e.g., seeding 1000 demo rows) could make the fork response slow. Mitigation: Lambda timeout applies (10-30s depending on tier). Document that bootstrap should be fast. If it's too slow, the agent gets a timeout error in `bootstrap_error` but the fork still succeeds.

**[Bootstrap function side effects on failure]** → If bootstrap partially completes before failing (created user but didn't set role), the app is in an inconsistent state. Mitigation: App authors should write idempotent bootstrap functions. The agent can retry by invoking the bootstrap function manually via `/functions/v1/bootstrap`.

**[No variable validation by platform]** → The platform passes whatever the caller sends. A missing required variable is caught by the function, not the platform. Mitigation: The `bootstrap_variables` declaration in `run402.yaml` is informational. Agents should read it. Functions should validate and return clear errors.

**[No backwards compatibility concern]** → There are no existing forks or published apps in production. We can make any changes to the fork/deploy API shape without worrying about breaking existing consumers.
