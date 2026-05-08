# routed-http-function-contract Specification

## Purpose
TBD - created by archiving change add-deploy-v2-web-routes-public-surface. Update Purpose after archive.
## Requirements
### Requirement: Routed HTTP Ingress Is Public Same-Origin Traffic

Deploy-v2 web routes SHALL invoke functions through a routed browser ingress mode named `run402.routed_http.v1`.

Routed ingress SHALL be public same-origin traffic and SHALL NOT require a Run402 API key at the public edge. Direct `/functions/v1/:name` invocation SHALL remain API-key protected and API-shaped. Application authentication, sessions, authorization, CSRF, OAuth callbacks, and CORS behavior SHALL be owned by the routed function code.

Docs SHALL warn function authors not to trust spoofable forwarding headers for authorization decisions. The typed route context, including `host`, `proto`, `requestId`, `clientIp`, and `userAgent`, is the authoritative platform-provided metadata surface when present.

#### Scenario: Browser request uses routed ingress

- **WHEN** a browser requests `GET /admin` on a host whose active release routes `/admin` to function `admin`
- **THEN** Run402 SHALL invoke the function using the `run402.routed_http.v1` contract
- **AND** the browser request SHALL NOT need a Run402 API key

#### Scenario: Direct invoke remains protected

- **WHEN** a client requests `/functions/v1/admin` without a Run402 API key
- **THEN** the existing direct function invocation path SHALL reject the request
- **AND** the public route contract SHALL NOT change that behavior

#### Scenario: Allowance exhaustion is browser-shaped

- **WHEN** public routed traffic hits an owner allowance or quota exhaustion condition
- **THEN** the browser response SHALL be web-shaped, such as `503 Service Unavailable`
- **AND** it SHALL NOT expose a raw owner x402 payment challenge by default

### Requirement: Routed Request Envelope Preserves HTTP Fidelity

The public contract SHALL document a routed request envelope with `version: "run402.routed_http.v1"`, HTTP method, full public URL, path, raw query string, duplicate-safe lower-case headers, raw cookie header, optional base64 body, and route context.

The route context SHALL include source, project id, release id, deployment id, host, proto, route pattern, route kind, route target, request id, and best-effort client metadata when available.

The gateway SHALL NOT strip the matched route prefix from the forwarded path. Request bodies SHALL be buffered, binary-safe, base64 encoded when present, and capped at 6 MiB.

`@run402/functions` SHALL export the exact request envelope type:

```ts
export type RoutedHttpHeaderList = Array<[string, string]>;

export interface RoutedHttpRequestV1 {
  version: "run402.routed_http.v1";
  method: string;
  url: string;
  path: string;
  rawPath: string;
  rawQuery: string;
  headers: Array<[string, string]>;
  cookies: { raw: string | null };
  body: null | {
    encoding: "base64";
    data: string;
    size: number;
  };
  context: {
    source: "route";
    projectId: string;
    releaseId: string | null;
    deploymentId: string | null;
    host: string;
    proto: "https" | "http";
    routePattern: string;
    routeKind: "exact" | "prefix";
    routeTarget: { type: "function"; name: string };
    requestId: string;
    clientIp?: string;
    userAgent?: string;
  };
}
```

#### Scenario: Function receives public URL

- **WHEN** a browser requests `GET https://example.com/api/users?limit=10`
- **AND** route `/api/*` targets function `api`
- **THEN** the function event SHALL expose the public URL
- **AND** `path` SHALL be `/api/users`
- **AND** `rawQuery` SHALL be `limit=10`

#### Scenario: Prefix is not stripped

- **WHEN** a browser requests `POST /admin/session`
- **AND** route `/admin/*` targets function `admin`
- **THEN** the function event path SHALL be `/admin/session`

#### Scenario: Binary request body is base64

- **WHEN** a browser sends binary bytes to a routed function
- **THEN** the routed request body SHALL use base64 encoding
- **AND** the body size SHALL describe the original byte length

#### Scenario: Oversized request body is rejected

- **WHEN** a routed browser request body exceeds 6 MiB
- **THEN** Run402 SHALL return `413 Payload Too Large`
- **AND** the function SHALL NOT be invoked

### Requirement: Routed Response Envelope Preserves Status Headers Cookies And Bytes

The public contract SHALL document a routed response envelope with `status`, optional duplicate-safe headers, optional `cookies: string[]`, and optional base64 body.

Status codes SHALL be 200 through 599. `101 Switching Protocols`, WebSockets, server-sent events, and streaming responses SHALL NOT be supported in Phase 1.

Run402 SHALL preserve multiple `Set-Cookie` values, preserve end-to-end response headers, strip hop-by-hop response headers, and return redirects as ordinary 3xx responses without following or rewriting them. For `HEAD`, Run402 SHALL send headers without a response body. Routed response bodies SHALL be capped at 6 MiB.

`@run402/functions` SHALL export the exact response envelope type and a small non-framework encoder helper:

```ts
export interface RoutedHttpResponseV1 {
  status: number;
  headers?: Array<[string, string]>;
  cookies?: string[];
  body?: null | {
    encoding: "base64";
    data: string;
    size: number;
  };
}

export interface RoutedHttpResponseInit {
  status?: number;
  headers?: Array<[string, string]>;
  cookies?: string[];
}

export const routedHttp: {
  text(body: string, init?: RoutedHttpResponseInit): RoutedHttpResponseV1;
  json(value: unknown, init?: RoutedHttpResponseInit): RoutedHttpResponseV1;
  bytes(bytes: Uint8Array, init?: RoutedHttpResponseInit): RoutedHttpResponseV1;
  isRequest(event: unknown): event is RoutedHttpRequestV1;
};
```

#### Scenario: Function package exports routed HTTP types

- **WHEN** a deployed function imports `RoutedHttpRequestV1`, `RoutedHttpResponseV1`, `RoutedHttpHeaderList`, or `routedHttp` from `@run402/functions`
- **THEN** the imports SHALL compile without using deep package paths
- **AND** documentation snippets that use those imports SHALL compile against the package entrypoint

#### Scenario: Multiple cookies are preserved

- **WHEN** a routed function returns two cookie strings
- **THEN** the browser response SHALL contain two distinct `Set-Cookie` headers
- **AND** they SHALL NOT be collapsed into one comma-joined header

#### Scenario: Redirect is preserved

- **WHEN** a routed function returns status `302` with `Location: /dashboard`
- **THEN** the browser response SHALL be `302`
- **AND** the `Location` header SHALL remain `/dashboard`

#### Scenario: HEAD omits response body

- **WHEN** a browser sends `HEAD /status`
- **AND** the routed function returns headers and a body
- **THEN** Run402 SHALL send the headers
- **AND** it SHALL omit the body bytes

#### Scenario: Response body too large

- **WHEN** a routed function returns more than 6 MiB of response body bytes
- **THEN** Run402 SHALL return a platform `502`
- **AND** logs SHALL identify `ROUTED_RESPONSE_TOO_LARGE`

### Requirement: Routed Responses Avoid Default Shared Cache And Wildcard CORS

Run402 SHALL NOT store routed dynamic responses in a shared cache in Phase 1.

If a routed function sets no `Cache-Control`, Run402 SHALL add `Cache-Control: private, no-store` and `x-run402-cache: dynamic-bypass`. If the function sets `Cache-Control`, Run402 SHALL pass it through to the browser but still SHALL NOT store the response in Run402 shared cache. Responses with `Set-Cookie` SHALL NOT be stored in a shared cache.

Run402 SHALL NOT add `Access-Control-Allow-Origin: *` to routed function responses. Routed functions needing cross-origin access SHALL implement their own CORS behavior, including `OPTIONS` handling.

Docs SHALL include CSRF guidance for cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` routes. Docs SHALL include a multiple `Set-Cookie` example and a function handler example typed with `RoutedHttpRequestV1` and `RoutedHttpResponseV1`.

#### Scenario: Missing cache header gets no-store

- **WHEN** a routed function returns no `Cache-Control` header
- **THEN** Run402 SHALL add `Cache-Control: private, no-store`
- **AND** it SHALL add `x-run402-cache: dynamic-bypass`

#### Scenario: Function owns CORS

- **WHEN** a routed function returns no CORS headers
- **THEN** Run402 SHALL NOT add `Access-Control-Allow-Origin: *`
- **AND** docs SHALL tell users to implement CORS in the function when needed

