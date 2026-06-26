# @run402/functions

> **Source moved.** This directory is a stub.
>
> The full source for `@run402/functions` now lives in the public [`kychee-com/run402-core`](https://github.com/kychee-com/run402-core) repo at `packages/functions/`. The npm package on the registry is unchanged — same name, same exports, same types.

## Why

`@run402/functions` is **platform code, not a user-declared dependency.** The gateway bundles Run402's installed copy into every deployed function via esbuild at deploy time. When it lived here, a gateway-side endpoint change and the matching helper change had to span two repos, two CI runs, two version bumps. Drift was a real risk.

Moving it into `run402-core` means:

- External contributors can inspect and patch the helper source directly.
- Run402 Cloud consumes the same published public artifact that self-hosters and editors install.
- Runtime changes follow the ratchet: edit public Core, publish `@run402/functions`, bump the Cloud dependency, and redeploy.

## For users

Nothing changes. Continue installing the package the same way:

```bash
npm install @run402/functions
```

Documentation and the user-facing API surface are unchanged. The npm page is at https://www.npmjs.com/package/@run402/functions.

## For platform maintainers

To change the `@run402/functions` surface, work in `kychee-com/run402-core` at `packages/functions/`. Publish `@run402/functions` from `run402-core`, then bump the Run402 Cloud gateway dependency and redeploy.
