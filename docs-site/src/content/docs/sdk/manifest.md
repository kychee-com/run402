---
title: "The run402.json manifest"
description: "The run402.json deploy manifest: schema essentials and a complete static-site example with a local directory, a subdomain, noindex and public paths."
order: 5
---

## Manifest (`run402.json`)

`run402.json` is the deploy manifest that `run402 up`, the MCP `up` tool, and `r.up({ manifest: "run402.json" })` read from disk. It is a `ReleaseSpec` written as JSON with `snake_case` wire fields, described by the schema `https://run402.com/schemas/release-spec.v1.json` and checked by the SDK's strict manifest adapter (`normalizeDeployManifest`) before any network call. Relative paths resolve from the manifest's own directory.

A static-only site: the `public/` directory next to the manifest is the whole site, served at `https://family.run402.com`, and kept out of search engines:

```json
{
  "$schema": "https://run402.com/schemas/release-spec.v1.json",
  "site": {
    "replace": { "__source": "local-dir", "path": "public" },
    "noindex": true
  },
  "subdomains": { "set": ["family"] }
}
```

The same site, serving only the browser paths it lists:

```json
{
  "$schema": "https://run402.com/schemas/release-spec.v1.json",
  "site": {
    "replace": { "__source": "local-dir", "path": "public" },
    "public_paths": {
      "mode": "explicit",
      "replace": {
        "/": { "asset": "index.html" },
        "/events": { "asset": "events.html", "cache_class": "html" }
      }
    }
  },
  "subdomains": { "set": ["family"] }
}
```

Deploy from the directory that holds `run402.json`: `run402 up --name family -y` on the command line, or the MCP tool `up` with `{ "dir": "<absolute path of that directory>", "name": "family", "yes": true }`. The MCP `run` sandbox has no filesystem, so neither `local-dir` nor a `{ "path" }` file entry (nor `r.sites.deployDir`) works inside a snippet; the MCP `deploy` tool takes the spec inline and its file maps carry bytes, not directories.

Fields a static site uses:

- `$schema`: editor metadata, stripped before planning. Besides it, only `x-run402-omitted_features` is ignored; any other unknown field fails locally, so a typo such as `site.replcae` or the singular `subdomain` never becomes a partial deploy.
- `project_id`: optional. Leave it out on a first deploy, where `up --name` creates the project; name a project to deploy to an existing one.
- `site.replace`: the whole site; files absent from it are removed. Either `{ "__source": "local-dir", "path": "<dir>" }`, which takes every file under that directory keyed by its path relative to it (`public/index.html` is the asset `index.html`, served at `/`; `.git/`, `node_modules/`, `.DS_Store`, dotenv and npmrc files and private-key-like files are skipped), or a file map whose keys are asset paths and whose values are a UTF-8 string, `{ "path": "public/index.html", "content_type": "text/html" }`, or `{ "data": "...", "encoding": "utf-8" | "base64", "content_type": "..." }`.
- `site.patch`: instead of `replace`, `{ "put": <file map or local-dir>, "delete": ["old.html"] }` changes only the named files.
- `site.noindex`: `true` adds `X-Robots-Tag: noindex, nofollow, nosnippet` to every response of the host; `false` or `null` makes the host indexable again (the default); leaving it out carries the previous release's value forward.
- `site.public_paths`: the browser reachability table, separate from asset paths (asset `events.html`, browser path `/events`). `{ "mode": "explicit", "replace": { "/events": { "asset": "events.html", "cache_class": "html" } } }` makes only the listed paths public (`/events.html` is then not public unless listed); `{ "mode": "implicit" }` returns to filename-derived URLs, which can widen access, so read the plan warnings. Known `cache_class` values: `html`, `immutable_versioned`, `revalidating_asset`.
- `subdomains`: one of `{ "set": [name] }` (the release's managed subdomain; one name), `{ "add": [...] }`, or `{ "remove": [...] }`. A name is 3-63 characters of lowercase letters, digits and hyphens and becomes `<name>.run402.com`; later deploys to the project keep it pointed at the new release.
- `site.embedding`, `site.sign_in_path`: the framing opt-in and the app's own sign-in page; see the `ReleaseSpec` shape.

Empty containers (`site.replace: {}`, `subdomains.set: []`) fail locally with `MANIFEST_EMPTY`. A full-stack manifest adds `database` (migrations and the expose manifest), `functions`, `routes`, `secrets` and `assets`: the first-deploy guide carries a complete example with a table, and the whole `ReleaseSpec` shape is in the unified-apply section (MCP: `docs({ topic: "unified-apply" })`).
