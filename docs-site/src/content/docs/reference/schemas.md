---
title: Release and application schemas
description: Generated from pinned owning authoring schemas.
---

Use `run402 up --check` for local validation and `run402 up --plan` for gateway planning. Schema checks cannot prove authorization, capacity or activation. These tables describe authoring JSON; SDK types can use different casing.

## Run402 ReleaseSpec v1

[Download schema](/schemas/release-spec.v1.json). Authoring schema for Run402 deploy manifests. Use run402 up for complete application workflows. Project selection may be supplied by an explicit CLI target, app-local link or approved --name creation; the SDK requires a resolved project before gateway planning. SDK-native ReleaseSpec uses project; CLI/MCP manifests may use project_id.

<h3 id="release-root">root</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `$schema` | `string` | no | Editor metadata only. Manifest adapters strip this before deploy planning. |
| `x-run402-omitted_features` | `array` | no | App-kit evidence metadata for humans/agents. Manifest adapters preserve it in the loaded manifest and strip it before deploy planning. |
| `project` | `string` | no | SDK-native project id. |
| `project_id` | `string` | no | CLI/MCP-friendly project id, normalized to ReleaseSpec.project. |
| `idempotency_key` | `string` | no | See the downloadable schema for constraints. |
| `idempotencyKey` | `string` | no | See the downloadable schema for constraints. |
| `base` | `#/$defs/base` | no | See the downloadable schema for constraints. |
| `database` | `#/$defs/database` | no | See the downloadable schema for constraints. |
| `secrets` | `#/$defs/secrets` | no | See the downloadable schema for constraints. |
| `functions` | `#/$defs/functions` | no | See the downloadable schema for constraints. |
| `site` | `#/$defs/site` | no | See the downloadable schema for constraints. |
| `assets` | `#/$defs/assets` | no | See the downloadable schema for constraints. |
| `subdomains` | `#/$defs/subdomains` | no | See the downloadable schema for constraints. |
| `routes` | `oneOf` | no | See the downloadable schema for constraints. |
| `checks` | `array` | no | See the downloadable schema for constraints. |
| `i18n` | `oneOf` | no | See the downloadable schema for constraints. |
| `verify` | `#/$defs/verify` | no | Authoring-only post-apply HTTP verification, run by `run402 up` after a successful apply and rerunnable with `run402 up verify`. Stripped before deploy planning (never part of the wire ReleaseSpec). |

<h3 id="release-base">base</h3>

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "release"
      ],
      "properties": {
        "release": {
          "enum": [
            "current",
            "empty"
          ]
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "release_id"
      ],
      "properties": {
        "release_id": {
          "type": "string"
        }
      }
    }
  ]
}
```

<h3 id="release-database">database</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `migrations` | `array` | no | See the downloadable schema for constraints. |
| `expose` | `object` | no | Authorization/expose manifest. See https://run402.com/schemas/manifest.v1.json for its schema. |
| `zero_downtime` | `boolean` | no | See the downloadable schema for constraints. |

<h3 id="release-migration">migration</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | no | Versioned immutable migration id, e.g. 001_init. Same id plus same checksum noops; same id plus different SQL is MIGRATION_CHECKSUM_MISMATCH. Use name instead for generated/idempotent SQL whose identity should track content changes. |
| `name` | `string` | no | Content-tracked migration name for generated/idempotent SQL. The SDK compiles this to <name>_<sha256(sql)[0:16]>; changed content applies once under a new id and identical re-deploys noop. SQL declared with name MUST be idempotent because it re-runs whenever content changes against a database where prior versions may already exist. |
| `checksum` | `string` | no | See the downloadable schema for constraints. |
| `sql` | `string` | no | See the downloadable schema for constraints. |
| `sql_ref` | `#/$defs/contentRef` | no | See the downloadable schema for constraints. |
| `sql_path` | `string` | no | See the downloadable schema for constraints. |
| `sql_file` | `string` | no | See the downloadable schema for constraints. |
| `transaction` | `schema` | no | See the downloadable schema for constraints. |

<h3 id="release-secrets">secrets</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `require` | `array` | no | See the downloadable schema for constraints. |
| `delete` | `array` | no | See the downloadable schema for constraints. |

<h3 id="release-functions">functions</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `replace` | `object` | no | See the downloadable schema for constraints. |
| `patch` | `object` | no | See the downloadable schema for constraints. |

<h3 id="release-functionSpec">functionSpec</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `runtime` | `schema` | no | See the downloadable schema for constraints. |
| `source` | `#/$defs/fileEntry` | no | See the downloadable schema for constraints. |
| `files` | `#/$defs/fileSet` | no | See the downloadable schema for constraints. |
| `entrypoint` | `string` | no | See the downloadable schema for constraints. |
| `config` | `object` | no | See the downloadable schema for constraints. |
| `schedule` | `oneOf` | no | See the downloadable schema for constraints. |
| `deps` | `array` | no | See the downloadable schema for constraints. |
| `triggers` | `array` | no | See the downloadable schema for constraints. |
| `requireAuth` | `boolean` | no | See the downloadable schema for constraints. |
| `require_auth` | `boolean` | no | See the downloadable schema for constraints. |
| `requireRole` | `oneOf` | no | See the downloadable schema for constraints. |
| `require_role` | `oneOf` | no | See the downloadable schema for constraints. |
| `class` | `schema` | no | See the downloadable schema for constraints. |
| `capabilities` | `array` | no | See the downloadable schema for constraints. |

<h3 id="release-functionTrigger">functionTrigger</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | See the downloadable schema for constraints. |
| `type` | `string` | yes | See the downloadable schema for constraints. |

<h3 id="release-functionRequireRole">functionRequireRole</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `table` | `string` | yes | See the downloadable schema for constraints. |
| `id_column` | `string` | yes | See the downloadable schema for constraints. |
| `role_column` | `string` | yes | See the downloadable schema for constraints. |
| `allowed` | `array` | yes | See the downloadable schema for constraints. |
| `cache_ttl` | `integer` | no | See the downloadable schema for constraints. |
| `on_deny` | `schema` | no | See the downloadable schema for constraints. |
| `sign_in_path` | `string` | no | See the downloadable schema for constraints. |

<h3 id="release-site">site</h3>

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "replace"
      ],
      "properties": {
        "replace": {
          "oneOf": [
            {
              "$ref": "#/$defs/fileSet"
            },
            {
              "$ref": "#/$defs/localDirRef"
            }
          ]
        },
        "public_paths": {
          "$ref": "#/$defs/sitePublicPaths"
        },
        "embedding": {
          "$ref": "#/$defs/siteEmbedding"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "patch"
      ],
      "properties": {
        "patch": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "put": {
              "oneOf": [
                {
                  "$ref": "#/$defs/fileSet"
                },
                {
                  "$ref": "#/$defs/localDirRef"
                }
              ]
            },
            "delete": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "public_paths": {
          "$ref": "#/$defs/sitePublicPaths"
        },
        "embedding": {
          "$ref": "#/$defs/siteEmbedding"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "public_paths": {
          "$ref": "#/$defs/sitePublicPaths"
        },
        "embedding": {
          "$ref": "#/$defs/siteEmbedding"
        }
      },
      "anyOf": [
        {
          "required": [
            "public_paths"
          ]
        },
        {
          "required": [
            "embedding"
          ]
        }
      ]
    }
  ]
}
```

<h3 id="release-sitePublicPaths">sitePublicPaths</h3>

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode"
      ],
      "properties": {
        "mode": {
          "const": "implicit"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "replace"
      ],
      "properties": {
        "mode": {
          "const": "explicit"
        },
        "replace": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/publicStaticPath"
          }
        }
      }
    }
  ]
}
```

<h3 id="release-publicStaticPath">publicStaticPath</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `asset` | `string` | yes | Release static asset path, not a public URL. |
| `cache_class` | `#/$defs/staticCacheClass` | no | See the downloadable schema for constraints. |

<h3 id="release-staticCacheClass">staticCacheClass</h3>

```json
{
  "type": "string",
  "description": "Known values: html, immutable_versioned, revalidating_asset. Unknown future strings may be returned by observability APIs and should be preserved."
}
```

<h3 id="release-subdomains">subdomains</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `set` | `array` | no | See the downloadable schema for constraints. |
| `add` | `array` | no | See the downloadable schema for constraints. |
| `remove` | `array` | no | See the downloadable schema for constraints. |

<h3 id="release-routes">routes</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `replace` | `array` | yes | See the downloadable schema for constraints. |

<h3 id="release-route">route</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `pattern` | `string` | yes | See the downloadable schema for constraints. |
| `methods` | `array` | no | See the downloadable schema for constraints. |
| `target` | `oneOf` | yes | See the downloadable schema for constraints. |
| `pricing` | `#/$defs/routePricing` | no | See the downloadable schema for constraints. |
| `acknowledge_readonly` | `schema` | no | Durable acknowledgement for intentional read-only final-wildcard function routes. Valid only when target.type is function, pattern ends in /*, and methods are limited to GET/HEAD. |

<h3 id="release-routePricing">routePricing</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `mode` | `schema` | yes | See the downloadable schema for constraints. |
| `amount_usd_micros` | `integer` | yes | See the downloadable schema for constraints. |
| `pay_to` | `schema` | yes | See the downloadable schema for constraints. |
| `networks` | `array` | no | Omit to accept production mainnet only. Include testnet explicitly for testnet payments. |

<h3 id="release-functionRouteTarget">functionRouteTarget</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `type` | `schema` | yes | See the downloadable schema for constraints. |
| `name` | `string` | yes | See the downloadable schema for constraints. |

<h3 id="release-staticRouteTarget">staticRouteTarget</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `type` | `schema` | yes | See the downloadable schema for constraints. |
| `file` | `string` | yes | Relative materialized release static asset path, not a public path. |

<h3 id="release-smokeCheck">smokeCheck</h3>

```json
{
  "type": "object",
  "additionalProperties": true
}
```

<h3 id="release-i18n">i18n</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `defaultLocale` | `string` | yes | Default locale tag. MUST be byte-identical to one entry in locales[]. |
| `locales` | `array` | yes | Supported locale tags. Non-empty, max 50 entries. Tags are opaque — only the safety regex is enforced (no BCP-47 semantic validation). |
| `detect` | `array` | no | Walked in order; first match wins. Defaults to ['accept-language'] when omitted, max 10 entries; [] is allowed and means 'always default'. Sources: 'accept-language' and 'cookie:<name>' (RFC 6265 cookie-name grammar). |
| `unknownLocalePolicy` | `string` | no | What to do when a detect-source signal does not match locales[]. 'reject' (default, backwards-compatible) falls through to the next detect source then to defaultLocale. 'pass-through' returns the lowercased, trimmed signal value verbatim — letting the consumer's app DB decide whether translations exist for the tag. Capability i18n-unknown-locale-policy (issue #413). |

<h3 id="release-fileSet">fileSet</h3>

```json
{
  "type": "object",
  "additionalProperties": {
    "$ref": "#/$defs/fileEntry"
  }
}
```

<h3 id="release-localDirRef">localDirRef</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `__source` | `schema` | yes | See the downloadable schema for constraints. |
| `path` | `string` | yes | Local directory path resolved by the SDK/CLI from the manifest directory and stripped before the apply request. |

<h3 id="release-fileEntry">fileEntry</h3>

```json
{
  "oneOf": [
    {
      "type": "string"
    },
    {
      "$ref": "#/$defs/contentRef"
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "content_type": {
          "type": "string"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "data"
      ],
      "properties": {
        "data": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "$ref": "#/$defs/contentRef"
            }
          ]
        },
        "encoding": {
          "enum": [
            "utf-8",
            "base64"
          ]
        },
        "content_type": {
          "type": "string"
        }
      }
    }
  ]
}
```

<h3 id="release-contentRef">contentRef</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `sha256` | `string` | yes | See the downloadable schema for constraints. |
| `size` | `integer` | yes | See the downloadable schema for constraints. |
| `content_type` | `string` | no | See the downloadable schema for constraints. |
| `contentType` | `string` | no | Legacy SDK ContentRef spelling accepted by the normalizer; prefer content_type in manifests. |
| `integrity` | `string` | no | See the downloadable schema for constraints. |

<h3 id="release-assets">assets</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `put` | `array` | no | See the downloadable schema for constraints. |
| `delete` | `array` | no | Asset keys to remove at activation. |
| `sync` | `#/$defs/assetSync` | no | See the downloadable schema for constraints. |

<h3 id="release-assetPutEntry">assetPutEntry</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `key` | `string` | yes | Asset key under the project's asset namespace (no leading slash). |
| `source` | `#/$defs/fileEntry` | no | SDK-input form. Mutually exclusive with sha256/size_bytes; the SDK normalizer hashes + uploads via /content/v1/plans. |
| `sha256` | `string` | no | Pre-uploaded CAS reference (wire form). Mutually exclusive with source. |
| `size_bytes` | `integer` | no | Required when using the wire form (sha256 set). |
| `content_type` | `string` | no | See the downloadable schema for constraints. |
| `visibility` | `schema` | no | See the downloadable schema for constraints. |
| `immutable` | `boolean` | no | See the downloadable schema for constraints. |

<h3 id="release-assetSync">assetSync</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `prefix` | `string` | yes | Prefix under which destructive sync operates. |
| `prune` | `schema` | yes | See the downloadable schema for constraints. |
| `confirm` | `object` | no | Confirmation token echoed back from a prior plan; required to commit a destructive sync. |

<h3 id="release-verify">verify</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `http` | `array` | no | See the downloadable schema for constraints. |

<h3 id="release-verifyHttpCheck">verifyHttpCheck</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | See the downloadable schema for constraints. |
| `path` | `string` | no | Request path resolved against the project public origin. |
| `url` | `string` | no | See the downloadable schema for constraints. |
| `expect` | `object` | no | See the downloadable schema for constraints. |
| `expected_status` | `integer` | no | Snake-case alias for expect.status. |
| `retries` | `integer` | no | See the downloadable schema for constraints. |

<h3 id="release-siteEmbedding">siteEmbedding</h3>

```json
{
  "description": "Framing opt-in using platform catalog keys, never origins. Remote validation checks the current catalog. Null resets to deny; omission carries prior state.",
  "oneOf": [
    {
      "type": "null"
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "frame_ancestors"
      ],
      "properties": {
        "frame_ancestors": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]*$"
          }
        }
      }
    }
  ]
}
```

## Run402AppSpec

[Download schema](/schemas/run402-app.v1.schema.json). Canonical run402.json app installation manifest consumed by run402 up.

<h3 id="application-root">root</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `$schema` | `schema` | yes | See the downloadable schema for constraints. |
| `spec_version` | `schema` | yes | See the downloadable schema for constraints. |
| `app` | `object` | yes | See the downloadable schema for constraints. |
| `project` | `object` | yes | See the downloadable schema for constraints. |
| `resources` | `object` | no | See the downloadable schema for constraints. |
| `secrets` | `object` | no | See the downloadable schema for constraints. |
| `build` | `object` | no | See the downloadable schema for constraints. |
| `release` | `object` | yes | Release node content. Project selection, build, resources, secret source metadata, lifecycle, and verify stay in the app install graph. |
| `lifecycle` | `object` | no | See the downloadable schema for constraints. |
| `verify` | `object` | no | See the downloadable schema for constraints. |

<h3 id="application-logicalName">logicalName</h3>

```json
{
  "type": "string",
  "pattern": "^[a-z][a-z0-9_]*$"
}
```

<h3 id="application-mailbox">mailbox</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `slug` | `string` | no | See the downloadable schema for constraints. |
| `roles` | `array` | no | See the downloadable schema for constraints. |
| `description` | `string` | no | See the downloadable schema for constraints. |

<h3 id="application-webhook">webhook</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `mailbox` | `#/$defs/logicalName` | yes | See the downloadable schema for constraints. |
| `url` | `string` | yes | See the downloadable schema for constraints. |
| `events` | `array` | yes | See the downloadable schema for constraints. |
| `enabled` | `boolean` | no | See the downloadable schema for constraints. |
| `signing` | `object` | no | See the downloadable schema for constraints. |

<h3 id="application-userSecret">userSecret</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `required` | `boolean` | no | See the downloadable schema for constraints. |
| `source_env` | `string` | no | See the downloadable schema for constraints. |
| `description` | `string` | no | See the downloadable schema for constraints. |

<h3 id="application-buildCommand">buildCommand</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | See the downloadable schema for constraints. |
| `argv` | `array` | no | See the downloadable schema for constraints. |
| `shell` | `string` | no | See the downloadable schema for constraints. |
| `cwd` | `string` | no | See the downloadable schema for constraints. |

<h3 id="application-releaseDatabase">releaseDatabase</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `migrations` | `array` | no | See the downloadable schema for constraints. |
| `expose` | `schema` | no | See the downloadable schema for constraints. |
| `zero_downtime` | `boolean` | no | See the downloadable schema for constraints. |

<h3 id="application-migration">migration</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | no | Versioned immutable migration id, e.g. 001_init. Same id plus same checksum noops; same id plus different SQL is MIGRATION_CHECKSUM_MISMATCH. Use name instead for generated/idempotent SQL whose identity should track content changes. |
| `name` | `string` | no | Content-tracked migration name for generated/idempotent SQL. The SDK compiles this to <name>_<sha256(sql)[0:16]>; changed content applies once under a new id and identical re-deploys noop. SQL declared with name MUST be idempotent because it re-runs whenever content changes against a database where prior versions may already exist. |
| `checksum` | `string` | no | See the downloadable schema for constraints. |
| `sql` | `string` | no | See the downloadable schema for constraints. |
| `sql_ref` | `#/$defs/contentRef` | no | See the downloadable schema for constraints. |
| `sql_path` | `string` | no | See the downloadable schema for constraints. |
| `sql_file` | `string` | no | See the downloadable schema for constraints. |
| `transaction` | `schema` | no | See the downloadable schema for constraints. |

<h3 id="application-contentRef">contentRef</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `sha256` | `string` | yes | See the downloadable schema for constraints. |
| `size` | `integer` | yes | See the downloadable schema for constraints. |
| `contentType` | `string` | no | See the downloadable schema for constraints. |
| `integrity` | `string` | no | See the downloadable schema for constraints. |

<h3 id="application-httpVerify">httpVerify</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | See the downloadable schema for constraints. |
| `path` | `string` | no | See the downloadable schema for constraints. |
| `url` | `string` | no | See the downloadable schema for constraints. |
| `expect` | `object` | yes | See the downloadable schema for constraints. |
| `retries` | `integer` | no | See the downloadable schema for constraints. |

## Run402 Manifest v1

[Download schema](/schemas/manifest.v1.json). Declarative authorization contract for a Run402 project. Describes tables, views and RPCs reachable through PostgREST and their RLS policy templates. Author under database.expose in a release manifest and deploy with run402 up; direct HTTP integrations use POST /projects/v1/admin/:id/expose.

<h3 id="exposure-root">root</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `$schema` | `string` | no | Optional schema URL for editor tooling. Ignored at apply time. |
| `version` | `schema` | yes | Manifest schema version. Must be "1" for this schema. |
| `tables` | `array` | no | Tables reachable via /rest/v1/*. Entries with expose:false are documentation-only. |
| `views` | `array` | no | Security-invoker views projecting columns from a base table. |
| `rpcs` | `array` | no | Postgres functions callable via /rest/v1/rpc/*, with explicit EXECUTE grants. |

<h3 id="exposure-identifier">identifier</h3>

```json
{
  "type": "string",
  "pattern": "^[a-z_][a-z0-9_]{0,62}$",
  "description": "Lowercase SQL identifier: [a-z_] followed by up to 62 of [a-z0-9_]."
}
```

<h3 id="exposure-role">role</h3>

```json
{
  "type": "string",
  "pattern": "^[a-z_][a-z0-9_]{0,62}$",
  "description": "Postgres role name. Expected values: anon, authenticated, service_role, project_admin."
}
```

<h3 id="exposure-columnOrStar">columnOrStar</h3>

```json
{
  "oneOf": [
    {
      "$ref": "#/definitions/identifier"
    },
    {
      "type": "string",
      "const": "*"
    }
  ],
  "description": "A column identifier, or \"*\" for all columns."
}
```

<h3 id="exposure-table">table</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `name` | `#/definitions/identifier` | yes | See the downloadable schema for constraints. |
| `expose` | `boolean` | yes | See the downloadable schema for constraints. |
| `policy` | `schema` | no | See the downloadable schema for constraints. |
| `owner_column` | `#/definitions/identifier` | no | See the downloadable schema for constraints. |
| `force_owner_on_insert` | `boolean` | no | See the downloadable schema for constraints. |
| `live` | `boolean` | no | See the downloadable schema for constraints. |
| `i_understand_this_is_unrestricted` | `boolean` | no | See the downloadable schema for constraints. |
| `custom_sql` | `string` | no | See the downloadable schema for constraints. |

<h3 id="exposure-view">view</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `name` | `#/definitions/identifier` | yes | See the downloadable schema for constraints. |
| `base` | `#/definitions/identifier` | yes | See the downloadable schema for constraints. |
| `select` | `array` | yes | See the downloadable schema for constraints. |
| `filter` | `string` | no | See the downloadable schema for constraints. |
| `security_invoker` | `boolean` | no | Always coerced to true on apply. Recorded as-given for GET roundtrip fidelity. |
| `expose` | `boolean` | no | See the downloadable schema for constraints. |

<h3 id="exposure-rpc">rpc</h3>

| Property | Shape | Required | Description |
|---|---|---|---|
| `name` | `#/definitions/identifier` | yes | See the downloadable schema for constraints. |
| `signature` | `string` | yes | Parenthesized argument list, e.g. "(user_id uuid)" or "()". No semicolons. |
| `grant_to` | `array` | yes | See the downloadable schema for constraints. |
