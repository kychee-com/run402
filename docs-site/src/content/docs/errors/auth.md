---
title: auth errors
description: Owned codes and recovery guidance.
---

[Error contracts and compatibility index](/errors/). Follow the actual response's message, field details and next actions. Never infer retry safety from the code name alone.

<h2 id="R402_AUTH_ACTOR_HEADER_SPOOF">R402_AUTH_ACTOR_HEADER_SPOOF</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/runtime-context.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_AUTHZ_VERSION_PROHIBITED">R402_AUTH_AUTHZ_VERSION_PROHIBITED</h2>

Owner: `public:sdk/src/node/source-scan.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_BEARER_COOKIE_MISMATCH">R402_AUTH_BEARER_COOKIE_MISMATCH</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_COOKIE_ATTRIBUTES_INVALID">R402_AUTH_COOKIE_ATTRIBUTES_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_CSRF_ORIGIN_MISMATCH">R402_AUTH_CSRF_ORIGIN_MISMATCH</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_CSRF_TOKEN_MISMATCH">R402_AUTH_CSRF_TOKEN_MISMATCH</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_DOMAIN_NOT_ALLOWED">R402_AUTH_DOMAIN_NOT_ALLOWED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_EMAIL_CODE_EXHAUSTED">R402_AUTH_EMAIL_CODE_EXHAUSTED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_EMAIL_CODE_INVALID">R402_AUTH_EMAIL_CODE_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_FETCH_ABSOLUTE_URL">R402_AUTH_FETCH_ABSOLUTE_URL</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_FRESHNESS_REQUIRED">R402_AUTH_FRESHNESS_REQUIRED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`, `core:packages/functions/src/auth/index.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_IDENTITY_LINK_CONFLICT">R402_AUTH_IDENTITY_LINK_CONFLICT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_INSUFFICIENT_MEMBERSHIP">R402_AUTH_INSUFFICIENT_MEMBERSHIP</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_INSUFFICIENT_ROLE">R402_AUTH_INSUFFICIENT_ROLE</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_INVALID_BEARER">R402_AUTH_INVALID_BEARER</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_INVALID_CREDENTIALS">R402_AUTH_INVALID_CREDENTIALS</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_MAGIC_LINK_INVALID">R402_AUTH_MAGIC_LINK_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED">R402_AUTH_MEMBERSHIP_GATE_NOT_WIRED</h2>

Owner: `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_OAUTH_HANDOFF_INVALID">R402_AUTH_OAUTH_HANDOFF_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_PASSKEY_CHALLENGE_INVALID">R402_AUTH_PASSKEY_CHALLENGE_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_PREFLIGHT_FAILED">R402_AUTH_PREFLIGHT_FAILED</h2>

Owner: `public:sdk/src/node/actions-node.ts`, `public:cli/lib/deploy-v2.mjs`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_PRERENDERED">R402_AUTH_PRERENDERED</h2>

Owner: `public:astro/src/components/SignedIn.astro`, `public:sdk/src/node/source-scan.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

An auth helper ran during prerendering, where there is no request actor. Render the auth-dependent page through SSR or move the interaction to a supported client flow. Server islands are currently unsupported; `server:defer` is not a remedy.

<h2 id="R402_AUTH_REDUNDANT_USER_FILTER">R402_AUTH_REDUNDANT_USER_FILTER</h2>

Owner: `public:sdk/src/node/source-scan.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_RENAMED_EXPORT">R402_AUTH_RENAMED_EXPORT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_REQUIRED">R402_AUTH_REQUIRED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_RESERVED_EMAIL_DOMAIN">R402_AUTH_RESERVED_EMAIL_DOMAIN</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_RETURN_TO_INVALID">R402_AUTH_RETURN_TO_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_ROLE_GATE_NOT_CONFIGURED">R402_AUTH_ROLE_GATE_NOT_CONFIGURED</h2>

Owner: `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_SESSION_BRIDGE_UNVERIFIED">R402_AUTH_SESSION_BRIDGE_UNVERIFIED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_SESSION_EXPIRED">R402_AUTH_SESSION_EXPIRED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_SESSION_INVALID">R402_AUTH_SESSION_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_SOURCE_SCAN_ERROR">R402_AUTH_SOURCE_SCAN_ERROR</h2>

Owner: `public:sdk/src/node/source-scan.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_STATE_CHANGING_GET">R402_AUTH_STATE_CHANGING_GET</h2>

Owner: `public:sdk/src/node/source-scan.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_TENANT_SUBJECT_INVALID">R402_AUTH_TENANT_SUBJECT_INVALID</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_TENANT_SUFFIX_REQUIRED">R402_AUTH_TENANT_SUFFIX_REQUIRED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_UNKNOWN_EXPORT">R402_AUTH_UNKNOWN_EXPORT</h2>

Owner: `public:sdk/src/node/source-scan.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

An unsupported auth namespace member or sentinel export was accessed. Follow the diagnostic’s canonical replacement, such as `auth.user()` or `auth.requireUser()`. Do not invent `auth.getUser` or `auth.protect`. The legacy top-level `getUser(req)` is a separate compatibility helper, not the same export as a namespace member.

<h2 id="R402_AUTH_UNKNOWN_IDENTITY">R402_AUTH_UNKNOWN_IDENTITY</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.

<h2 id="R402_AUTH_UNTRUSTED_CONTEXT">R402_AUTH_UNTRUSTED_CONTEXT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/auth/errors.ts`.

The application authentication contract rejected or could not establish the requested actor context. Follow the returned message and suggested fix. Use supported auth helpers in request context; do not manufacture actor headers or bypass role/freshness gates.
