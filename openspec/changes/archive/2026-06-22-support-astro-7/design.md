## Context

`@run402/astro@2.4.1` currently declares `astro >=6 <7` and uses `astro@^6.1.3` as its dev dependency. The SSR runtime depends on `astro/app/entrypoint`, which is available in Astro 6 and remains present in Astro 7. A local spike forced `astro@7.0.0` and `@astrojs/markdown-remark@7.2.0`; the `@run402/astro` unit/component suite passed (`285/285`), and the package build passed after building `core` and `sdk`.

The CLI starter is further behind: `run402 init astro` currently writes `astro: ^5.0.0`, `@run402/astro: ^1.0.0`, and `@run402/functions: ^2.5.0`. That contradicts the package's current runtime assumptions and risks creating new apps with known-stale dependency ranges.

## Goals / Non-Goals

**Goals:**

- Let consumers install `@run402/astro` with Astro 7 without peer-dependency warnings.
- Keep Astro 6 supported while the adapter API remains compatible.
- Make the repository's lockfile exercise Astro 7 for `@run402/astro` package tests and builds.
- Bring `run402 init astro` dependency ranges up to the current supported platform stack.
- Update public docs and changelog language so users see the Astro 6/7 support window.

**Non-Goals:**

- Do not require all users to upgrade to Astro 7.
- Do not adopt Astro 7 route caching, `src/fetch.ts`, or advanced routing semantics as Run402 runtime features.
- Do not change SSR adapter behavior, cache behavior, hosted auth components, or image component APIs.
- Do not change the CLI output contract for `run402 init astro`; only the generated file contents change.

## Decisions

1. **Use `astro >=6 <8` as the peer range.**

   Astro 6 remains compatible with the current SSR adapter entrypoint, and local verification shows Astro 7 works without code changes. Widening the range avoids an unnecessary breaking change for existing Astro 6 projects while unblocking Astro 7 adopters.

   Alternative considered: move directly to `>=7 <8`. Rejected because there is no known runtime reason to drop Astro 6, and forcing a major upgrade would be user-visible churn with little technical benefit.

2. **Move the workspace dev dependency and lockfile to Astro 7.**

   The primary CI path should exercise the newest supported Astro major because that is where compiler, Vite, and adapter API drift will appear first. This gives the package early coverage for Astro 7's Rust compiler and Vite 8/Rolldown path.

   Alternative considered: keep Astro 6 in the lockfile and rely on peer widening. Rejected because it would leave the claimed Astro 7 support weakly tested.

3. **Treat Astro 7-only platform features as explicitly out of scope.**

   Astro 7 includes features such as stable route caching and advanced routing through reserved `src/fetch.ts`. Run402 already has its own auth-aware SSR cache semantics and route/deploy model, so this change should only certify compatibility with Astro 7, not map those features onto Run402.

   Alternative considered: opportunistically wire `Astro.cache` or `src/fetch.ts` into Run402. Rejected because that would cross runtime, gateway, cache, and docs boundaries and deserves a separate design.

4. **Update the CLI scaffold dependency template in the same change.**

   A compatibility release that leaves new starter apps on Astro 5 and older Run402 packages is incomplete. The scaffold should generate dependencies that are inside the same support window and match the hosted-auth/runtime package line.

   Alternative considered: only update `@run402/astro` and leave scaffold cleanup for later. Rejected because it would keep creating avoidable first-run incompatibilities.

## Risks / Trade-offs

- **Risk: Astro 7 changes an adapter/build hook behavior that unit tests do not cover.** -> Mitigation: run both the existing `@run402/astro` test suite and a package build after `core`/`sdk`; add or maintain a real Astro fixture build smoke where practical.
- **Risk: Widening to `>=6 <8` without long-term Astro 6 coverage lets regressions slip for Astro 6 users.** -> Mitigation: keep the peer floor unchanged and avoid Astro 7-only code paths; if adapter internals later use Astro 7 APIs, that future change must revisit the peer floor.
- **Risk: Users infer that Astro 7 cache/routing features are Run402-supported.** -> Mitigation: docs should state the compatibility boundary and keep Run402 cache/routing guidance unchanged.
- **Risk: npm resolution may pull updated transitive dependencies that affect package tests.** -> Mitigation: lockfile updates should be reviewed as part of the PR and package tests must pass from a clean `npm ci`.

## Migration Plan

1. Update package metadata and lockfile.
2. Update scaffold dependency ranges and tests that assert generated `package.json`.
3. Update `astro/README.md`, `astro/CHANGELOG.md`, and any repo architecture docs that name Astro 6 as the exclusive supported version.
4. Run `npm ci`, `npm run build:core`, `npm run build:sdk`, `npm run build --workspace=astro`, and `npm test --prefix astro`.
5. Publish as a normal `@run402/astro` compatibility release through the independent Astro publish flow.

Rollback is straightforward: restore the peer range/dev dependency/lockfile and scaffold template to the previous Astro 6 line. No runtime migration or data migration is involved.

## Open Questions

- Should CI add an explicit Astro 6 compatibility smoke after the lockfile moves to Astro 7, or is retaining the peer floor plus avoiding Astro 7-only APIs sufficient for this release?
