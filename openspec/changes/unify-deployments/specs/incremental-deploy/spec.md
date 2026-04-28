## REMOVED Requirements

### Requirement: Bundle deploy with inherit

**Reason:** The `inherit` flag was a band-aid for partial-update semantics on the legacy inline-bytes bundle deploy path. The `unified-deploy` capability replaces it with first-class replace vs patch semantics per resource — agents who want a partial site update use `site: { patch: { put: {...}, delete: [...] } }`; agents who want to leave a resource untouched simply omit it from the spec. There is no longer a need for a coarse-grained "inherit everything I didn't list" flag.

**Migration:** Callers of `r.apps.bundleDeploy(projectId, { inherit: true, ... })` should switch to `r.deploy.apply({ project, ...spec })` with explicit `patch` semantics on the resources they want to partially update. During the one-minor compatibility window, the `bundleDeploy` shim accepts `inherit: true` and emits a deprecation warning while inferring patch semantics from the file list. After the window, `inherit: true` is rejected with an error.

### Requirement: CLI deploy manifest supports inherit

**Reason:** Same as above — the CLI's pass-through of `inherit` from the manifest JSON is a thin layer over the bundle-deploy `inherit` flag, which is itself removed. The CLI's manifest format gains explicit `patch` blocks per resource (defined under the `unified-deploy` capability's CLI requirements).

**Migration:** Manifest JSON files containing `"inherit": true` continue to work during the compatibility window with a deprecation warning. Migrate manifests to use `site: { patch: { put: {...} } }` (or equivalent per-resource patch shapes) before the window closes.
