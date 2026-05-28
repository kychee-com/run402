# Changelog

All notable changes to `@run402/sdk`, `run402` (CLI), and `run402-mcp`. Versions are kept in lockstep across the three packages in this repo. `@run402/functions` lives in the private gateway monorepo and publishes on its own cadence.

## Unreleased — CLI JSON-only output cleanup (breaking)

Follow-up to 2.16.0: tightens the CLI's machine-readable contract by closing four "mixed-shape" violations of the JSON-only-by-default stance. `@run402/sdk` and `run402-mcp` have **no code changes**.

The `openspec/specs/cli-output-shape/spec.md` "Plain-Text Output Commands Remain Plain Text" carve-out (which covers `run402 allowance export`, `run402 dev`) is preserved as-is. This change reclassifies the previously-undocumented binary/text-leak paths as **not** carve-outs:

- **`run402 functions invoke` now JSON-wraps the result by default.** Stdout is `{ http_status, body, duration_ms }`. The HTTP status is exposed as `http_status` (not `status`) so the payload stays clean of the reserved top-level `status` field used in the stderr error envelope. Add `--raw` to opt back into the previous shape — string body → text + trailing newline; JSON body → pretty-printed JSON — useful when piping a CSV / binary-blob function response straight to a file: `run402 functions invoke prj_abc csv --raw > export.csv`.
- **`run402 functions logs --follow` now emits NDJSON** — one JSON log entry per line, no `[ts] message` text formatting. The non-follow batch path still emits a single `{ logs: [...] }` JSON object (unchanged). Shell consumers that grepped the old `[ts] msg` format need to switch to per-line JSON parsing (`| jq -c '.message'`).
- **`run402 email get-raw` now requires `--output <file>`.** Previously, omitting `--output` wrote raw MIME bytes directly to stdout — binary on stdout breaks pipes. Now `--output` is mandatory; stdout is the JSON envelope `{ message_id, bytes, output }`. Scripts that ran `run402 email get-raw msg_x > file.eml` need to switch to `run402 email get-raw msg_x --output file.eml`.
- **`run402 assets put` flag `--json` renamed to `--stream`.** The old name was misleading — both with and without the flag, stdout is JSON; `--stream` only controls whether per-file NDJSON progress events are emitted instead of the final results array. `--json` is preserved as a deprecated alias that prints a one-line warning to stderr; scheduled for removal in a future major.

Drift-protection tests in `cli-argv.test.mjs` (suite "CLI JSON-only output contract (v3.x cleanup)") pin each new shape.

### Compatibility-check checklist

If your automation parses any of these commands' stdout:

- `run402 functions invoke …` — read `body` from the envelope, or add `--raw` to keep the old verbatim-body behavior.
- `run402 functions logs … --follow` — parse each stdout line as a separate JSON object instead of regexing `[ts] msg`.
- `run402 email get-raw …` — add `--output <file>` to every call; read MIME bytes from disk, not stdin.
- `run402 assets put … --json` — rename to `--stream` to silence the stderr deprecation notice (behavior is identical).

## 2.16.0 — unreleased — CLI stdout envelope normalization

Drops the `status: "ok"` wrapper from every `run402` CLI success-path stdout emission, unifying an envelope that was applied to roughly half the subcommands and absent from the other half. See [openspec change `cli-drop-status-envelope`](openspec/changes/cli-drop-status-envelope/proposal.md) for the full design.

`@run402/sdk` and `run402-mcp` have **no code changes** in this release. Only the CLI's machine-readable stdout shape moved. Per the lockstep release policy, all three packages bump to 2.16.0 together.

### Compatibility note (read this if you parse CLI JSON output)

The `run402` CLI was agent-first and JSON-only by design, but its stdout envelope was never documented — about half of subcommands wrapped success payloads as `{ status: "ok", ...payload }`, the other half emitted the raw payload. The wrapper has been dropped across the board, the contract is now explicit in [`cli/llms-cli.txt`](cli/llms-cli.txt), and a drift-protection test (`cli-output-contract.test.mjs`, wired into `npm test`) prevents the inconsistency from coming back.

If you have automation parsing CLI output:

- **Drop any `.status === "ok"` checks.** They were never load-bearing for half the commands, and now load-bear for none. Gate on exit code (`0` = success, non-zero = error) instead.
- **Mutations with no natural payload now echo identifier + state field:**

  ```
  # Before
  $ run402 secrets set prj_abc FOO bar
  {"status":"ok","message":"Secret 'FOO' set for project prj_abc."}

  # After
  $ run402 secrets set prj_abc FOO bar
  {"key":"FOO","project_id":"prj_abc","set":true}
  ```

- **`run402 status` and `run402 allowance status` move special statuses into typed nullable payload fields and exit 0 when absent** (was exit 1 with `status: "no_allowance"` / `status: "no_wallet"`):

  ```
  # Before
  $ run402 allowance status      # exit 1
  {"status":"no_wallet","message":"No agent allowance found. Run: run402 allowance create"}

  # After
  $ run402 allowance status      # exit 0
  {"wallet":null,"hint":"Run: run402 allowance create"}
  ```

- **What did NOT change:** stderr error envelopes (still `{ status: "error", code, message, ... }` with non-zero exit), all SDK return types, all MCP tool output shapes, per-item `status` fields inside payload objects (e.g. `run402 doctor`'s `checks[].status`).

### Added

- `cli/llms-cli.txt` now leads with an explicit "Output Contract" section documenting the stdout / stderr / exit-code shape across every subcommand.
- `cli-output-contract.test.mjs` — drift-protection test that fails CI on any new top-level `JSON.stringify({ status: ... })` emission outside `cli/lib/sdk-errors.mjs`.

### Changed

- 68 success-path emit sites across 19 `cli/lib/*.mjs` files dropped their `status: "ok"` wrapper. Three `console.error(JSON.stringify({ status: "error", ... }))` sites in `cli/lib/init.mjs`, `cli/lib/projects.mjs`, and `cli/lib/sites.mjs` now route through `fail()` in `cli/lib/sdk-errors.mjs` instead of emitting the error envelope inline.
- `~50` test assertions in `cli-e2e.test.mjs` migrated from `parsed.status === "ok"` to assertions on the new payload-specific fields. The two `CLI status exit codes (GH-191)` tests now assert the new exit-0 typed-null behavior for absent local state.

## 2.4.0 — unreleased

Surfaces the v1.56 gateway verification-no-silent-fail bundle ([parent change: `verification-no-silent-fail` in run402-private](https://github.com/kychee-com/run402-private/tree/main/openspec/changes/verification-no-silent-fail)). Closes a class of UX bugs where SES auth-verdict rejections silently failed operator email verification with no signal to the operator. Additive — old clients silently ignore the new fields.

### Added

- **`run402 doctor` surfaces per-attempt verification failure detail** (`cli/lib/doctor.mjs`). When `operator_email` is `pending` and the gateway's `email_verification.last_challenge.hint` is populated, doctor renders it inline: `operator email not verified (1/5 attempts used, 4 remaining): SES reported FAIL on: spf. Fix the corresponding DNS records on <domain> and reply again. 4 more attempts remain.` — instead of the previous generic "email not verified" message that gave the operator no actionable signal.
- **`run402 agent status` includes `email_verification.last_challenge` block** (`cli/lib/agent.mjs`). Best-effort fetch from `/agent/v1/operator/status` is merged into the response so a single command surfaces the full challenge state: `attempts[]` with per-reason `at`, `from_address`, `reason` (one of `trust_rejected | from_mismatch | threading_miss | code_mismatch`), `sender_trust` verdicts, plus `attempt_count`, `remaining_attempts`, and the gateway-computed `hint`. Older gateways silently keep the original response shape.

### Changed

- **Doctor's `operator_health` check is now strictly more informative** when `email_status !== "verified"`. No behavior change for already-verified operators. The threshold for "warning" status is unchanged; only the message detail improves.

### Out of scope (deliberate carve-out)

- No SDK type changes — `email_verification` is consumed dynamically because the v1.55 SDK already returns the rest of the operator-status response as `unknown`-shaped JSON pass-through, and adding strict types here would force a parallel public-repo edit on every gateway-side field addition. Future work: type the operator-status response shape end-to-end.

## 2.3.0 — unreleased

Surfaces the v1.49 gateway image-variant pipeline ([run402#392](https://github.com/kychee-com/run402/issues/392), parent change: [`asset-image-variants` in run402-private](https://github.com/kychee-com/run402-private/tree/main/openspec/changes/asset-image-variants)). Additive, non-breaking — old clients silently ignore the new fields.

### Added

- **`AssetVariant` interface** in `@run402/sdk` (`sdk/src/namespaces/assets.types.ts`). Shape: `{ url, cdn_url, width_px, height_px, format: 'webp' | 'jpeg', sha256 }`. Used by the new `AssetRef.variants` map.
- **Typed image-variant fields on `AssetRef`** — `width_px`, `height_px`, `blurhash`, `variant_spec_version`, `display_url`, `display_immutable_url`, `variants?: { thumb?, medium?, large?, display_jpeg? }`. All optional. Present only for image uploads (jpeg/png/webp/heic/heif ≥320×320) against a v1.49+ gateway. Threaded end-to-end through `ResolvedAssetRef` → `AssetManifestEntry` → `buildAssetRef`, so the same fields appear whether you upload via `r.assets.put(...)` or `r.project(id).apply({ assets: { put: [...] } })`.
- **`AssetRef.thumbUrl`** convenience getter — `variants.thumb.cdn_url ?? displayUrl` for image refs, `undefined` for non-images. Single field for grid thumbnails; TypeScript narrows so a picker that does `<img src={pdfRef.thumbUrl}>` is a compile error.
- **`AssetRef.displayUrl`** convenience getter — `display_url ?? cdn_url` for image refs, `undefined` for non-images. HEIC sources transparently get the JPEG transcode.
- **`AssetRef.imgTagWithSrcSet(opts)`** helper — emits a `<picture>` with a WebP-only `<source>` (three sizes: 320w / 800w / 1920w) and `display_url` as the `<img>` fallback. Throws at call time on (a) missing/empty `opts.sizes` (browsers over-fetch the largest candidate without it), or (b) missing `variants` (non-image / sub-320 / pre-v1.49 ref) — no silent fallback. AVIF deferred from v1 (documented in JSDoc; `<picture>` type-precedence footgun).
- **MCP `assets_put` human output** now surfaces `Dimensions: <w>×<h>`, `Blurhash: <hash>`, `Display URL` (when distinct from `cdn_url` — HEIC only), and a `Variants:` line listing kind + dimensions + format for each present variant.

### Changed

- **`AssetRef.imgTag(alt?)` defaults `<img src>` to `display_url ?? cdn_url`** (was `cdn_url`). Correct rendering for HEIC uploads without HEIC-aware caller code — for non-HEIC images `display_url === cdn_url`, so no behavior change there.
- **`AssetRef.imgTag(alt?)` opportunistically emits `width`/`height` attributes** when both `width_px` and `height_px` are present on the ref. Eliminates Cumulative Layout Shift for image grids. Silently omits both attributes when either dimension is absent — never throws on absence.
- **MCP `assets_put` tool description** updated to mention the new image fields and reference the SDK docs for the full AssetRef shape.

### Out of scope (deliberate carve-out)

- `@run402/functions` type updates — lives in `run402-private/packages/functions/` and co-evolves with the gateway via its own `/publish-functions` skill. The runtime returns the new fields regardless of which `@run402/functions` types are in use.
- AVIF generation or AVIF-aware helpers — deferred at the gateway. When AVIF returns, it must land at all three sizes simultaneously or via a dedicated `imgTagHero()` helper.
- On-demand `?w=N&fmt=webp` resize endpoint and project-configurable variant sizes.

## 2.2.0 — 2026-05-18

Closes the v1.48 unified-apply asset pipeline end-to-end. v2.0.0/v2.0.1 shipped the deploy hero (`r.project(id).apply(spec)`) but left three structural gaps in the asset slice: the normalizer didn't read `spec.assets`, `NodeAssets.uploadDir/syncDir/prepareDir/putMany` never uploaded bytes, and `Assets.put` still called the removed `/storage/v1/uploads*` substrate (404 in production). This release closes all three.

### Added

- **`@run402/functions` `assets` namespace.** `import { assets } from "@run402/functions"` exposes `assets.put(key, source, opts)` for in-function blob uploads. Routes through the new gateway `POST /apply/v1/service-asset-put` (service-key auth) so per-key visibility flips inside the same activation sub-transaction the wallet-auth apply hero uses. Quota enforcement, per-unique-hash storage billing, and immutable URL retention behave identically to deploy-time `r.project(id).apply({ assets: { put: [...] } })`.
- **Wire-shaped `assets` slice in the unified apply spec.** `ReleaseSpec.assets?: AssetSpec` carries `put?: (AssetPutEntry | AssetPutEntryInput)[]`, `delete?: string[]`, and `sync?: { prefix, prune: true, confirm? }`. The SDK input form (`AssetPutEntryInput` with `source: ContentSource`) and the wire form (`AssetPutEntry` with `sha256` + `size_bytes`) can be mixed in the same array.
- **`r.assets.uploadDir(path, opts)` / `syncDir` / `prepareDir` / `putMany`.** Node-only directory ergonomics that walk filesystem, hash, register byte readers, and submit through the single `apply` hero. `entriesFromLocalDir` now returns `AssetPutEntryInput[]` (with `source` retained) instead of pre-hashed wire entries, so the SDK normalizer registers byte readers and bytes flow through `/content/v1/plans`.
- **`DeployResult.assets`** is populated from the plan response's `asset_entries[]`. Carries `list` / `byKey` with the gateway-authoritative `AssetRef` envelope (resolved URLs + SRI + etag + content_digest) plus `totals.bytes_uploaded` / `bytes_reused` (derived from per-entry `status: "upload_pending" | "present" | "satisfied_by_plan"`).
- **`slice_kind` discriminator on observability events.** `content.upload.skipped` / `content.upload.progress` events carry `slice_kind: "release" | "asset" | "mixed"` per SHA; `commit.phase` and `ready` events carry `slice_kinds: ("release" | "asset")[]` summarizing which slice categories the apply's spec carried. Cross-kind CAS dedup (same SHA in `site` + `assets`) escalates the per-SHA value to `"mixed"`.
- **CLI/MCP unified deploy tool now accepts `assets`.** `deploy.apply` (`run402 deploy apply --manifest run402.json`, MCP `deploy` tool) accepts `assets: { put: [{ key, source: { data, encoding? } | { path } }], delete?, sync? }` via the manifest normalizer.
- **Run402 ReleaseSpec JSON schema** (`schemas/release-spec.v1.json`, hosted at `https://run402.com/schemas/release-spec.v1.json`) now describes the `assets` slice with full `$defs/assetPutEntry`, `$defs/assetSync`.

### Changed

- **`r.assets.put` routes through the apply hero.** Single-key upload calls `r.project(id).apply({ assets: { put: [{ key, source: bytes }] } })` and reads the resolved `AssetRef` from `result.assets.byKey[key]`. Behavior matches v2.0.1 from the caller's perspective; the wire path moved to `/apply/v1/plans` + `/content/v1/plans`.
- **CLI `run402 assets put <file>`** delegates to `sdk.assets.put`. The pre-v2.x multipart S3 PUT + resumable session machinery (`~/.run402/uploads/<upload_id>.json`) is gone; resume semantics live at the apply-plan level (24h TTL). The `--concurrency` and `--no-resume` flags are accepted for backward compatibility but ignored.
- **`@run402/functions` runtime helper bundle.** Added `assets` to the export list alongside `db` / `adminDb` / `getUser` / `email` / `ai` / `routedHttp`. No change to the existing exports.

### Removed / deprecated

- **`Assets.initUploadSession` / `getUploadSession` / `completeUploadSession`** throw `LocalError` with an actionable migration message pointing to `r.project(id).apply({ assets: { put: [...] } })` / `r.assets.uploadDir`. Gateway v1.48 dropped the `/storage/v1/uploads*` substrate. The method shapes (and the `BlobUploadInit*` / `BlobUploadStatus*` / `BlobUploadComplete*` types they reference) are kept in the TypeScript surface for source-compat with downstream code that imports them; surface removal is a v3 candidate.

### Gateway changes (shipped to production alongside this release)

- **`POST /apply/v1/service-asset-put`** (service-key auth). In-function blob upload endpoint. Hashes raw body, PutObject to `_cas/<sha[0:2]>/<sha[2:]>`, upserts `internal.content_objects`, calls the shared `applyOneAssetPut` primitive in a short transaction, returns the resolved `AssetRef`. 25 MB inline cap.
- **`applyOneAssetPut`** extracted from `promoteStagedAssetSlice` as the shared per-put primitive. The wallet apply hero and the service-key route both call it; INSERTs into `internal.blobs` / `internal.asset_versions` (skipped when `operationId === null` for service uploads) / `internal.blob_url_refs` are byte-identical between the two paths.
- **`promoteStagedAssetSlice` now inserts `internal.blob_url_refs`** for every immutable put. Without this row the immutable URL form (`pr-<id>.run402.com/_blob/<key-with-sha-suffix>`) returned 404 for assets uploaded via the unified-apply hero; the legacy `/storage/v1/uploads*` cas-promote path always inserted it.

### Migration notes

If you were using v2.0.x and relied on `r.assets.initUploadSession` for low-level resumable uploads, migrate to `r.project(id).apply({ assets: { put: [...] } })` — the apply engine handles retries and large-file streaming through the unified content plan. For single-key uploads, `r.assets.put(projectId, key, source, opts)` is now the recommended surface and routes through the same hero.

If you were running an older gateway (pre-v1.48), this SDK release won't compile against it because the `/storage/v1/uploads*` routes return 404. Upgrade the gateway first.
