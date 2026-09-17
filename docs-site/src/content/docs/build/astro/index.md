---
title: Astro applications
description: SSR, hosted authentication, data, images and deployment on Run402.
---

The `@run402/astro` preset connects Astro's build and SSR runtime to Run402. Use the CLI for setup/deploy/diagnostics and native Astro code inside the application.

```bash
run402 init astro --help
```

Follow the scaffold's generated instructions and manifest, then deploy from the app directory with explicit destination intent. The package README is the detailed [native integration reference](https://github.com/kychee-com/run402/tree/main/astro).

```ts
// astro.config.ts
import run402 from "@run402/astro";
export default run402();
```

## Rendering and authentication

SSR is the default. Prerendered pages run at build time and cannot read a request's actor. Server islands are currently rejected with `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED`; use SSR or supported client-hydrated components instead. The current package declares Astro `>=6 <8` support; check the installed package's peer range during upgrades.

The native component API includes `SignIn`, `SignUp`, `UserButton`, `AccountSecurity` and signed-in/out presentation gates. For the published component/compiler limitation described below, use the fixture’s hosted-route flow. Presentation gates do not replace server authorization. In request context, `auth.user()` reads the actor and `auth.requireUser()` enforces authentication. Auth-dependent responses are not public cache entries.

## Data and images

Use caller-context `db()` for app data subject to row policies. Reserve `adminDb()` for deliberately privileged backend work. Keep full AssetRef objects in data rows when rendering uploaded variants. `Run402Picture` and `Run402Image` consume those references; dynamic source scanning is not a substitute for stored variant metadata.

## Cache and secrets

ISR caching is opt-in through supported response headers. Authentication, cookies and unsupported vary dimensions affect cacheability; inspect the returned reason rather than assuming every response caches. Invalidation does not grant read access.

Build-time environment variables do not automatically become runtime variables. Configure server secrets through the CLI and refer to required names in the manifest; never inline secret values in a release manifest or browser code.

## Deploy and debug

```bash
run402 up --check
run402 doctor --dir .
run402 up --name my-astro-app -y
run402 up verify
```

Use a new name only for an intended new project; subsequent deploys use the app-local link or explicit project. Inspect local deferred checks, build failures and final verification evidence. Pass an actual request ID to `run402 logs --request-id` when diagnosing a runtime failure. See [diagnostics](/operate/diagnostics/) and [errors](/errors/).

## Complete application and tested versions

The [notes/CMS fixture](https://github.com/kychee-com/run402/tree/main/examples/astro-notes-cms) contains hosted login, caller-scoped private notes, public CMS reads, an AssetRef image, a release manifest and local tests. It pins Astro 7.3.2, adapter 2.5.0 and the adapter-compatible 3.7.0 runtime types. Cloud supplies its deployed runtime helper.

The published adapter 2.5.0 SignIn component fails compilation on Astro 7; importing the component barrel reaches that file too. This fixture uses hosted sign-in/sign-up routes and the direct `@run402/astro/components/Run402Image.astro` entry point until a compatible component release is available. Do not downgrade to an unpatched compiler to conceal that issue.
