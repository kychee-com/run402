# Astro private notes and public CMS

One complete app demonstrates hosted sign-in, caller-scoped private notes, and a public article with opt-in ISR. Deploy and operate it with the CLI. The application uses native Astro/runtime helpers.

From this directory, on Node 22.12 or later:

```bash
npm ci
npm run check
npm run build
npm test
run402 up --manifest run402.deploy.ts --check
run402 up --manifest run402.deploy.ts --name my-notes-cms -y
run402 up verify
```

Use a unique name only for an intended new disposable project. For an existing project, replace `--name` with `--project <project_id>` and inspect `--plan` before applying. Local builds make no paid asset uploads: the image integration is disabled and the CMS stores runtime AssetRefs. Do not add `dist/` as a static directory; the manifest uses `buildAstroReleaseSlice` to keep the SSR bundle private.

The fixture uses the hosted sign-in/sign-up routes and direct image component entry point. The published 2.5.0 `SignIn.astro` has a compiler error on Astro 7; importing the component barrel also pulls that file into compilation. This example avoids that broken path without patching installed packages.

The dependency lock is part of the fixture. It pins `@run402/astro@2.5.0`, its supported `@run402/functions@3.7.0` authoring types, and a compatible Astro compiler. Cloud supplies the runtime helper at deployment. This example uses the shared `auth` and query-builder APIs, not the changed `adminDb().sql()` result shape. Do not force a 4.x functions package through the adapter's 3.x peer range.

## Verify the boundaries

- Signed out: `/article` is readable; `/notes` requires authentication. Follow the hosted sign-in/sign-up UI on the returned tenant host.
- User A: add a note, reload, and confirm it remains visible.
- In a separate browser session, user B must not see A's note. Add B's note and confirm A does not see it.
- Empty or over-200-character titles receive validation feedback without a write. Fields are escaped by Astro; stored text is not rendered as raw HTML.
- `/notes` sends `private, no-store`; the public article requests `s-maxage=60`. A cache bypass can still be correct for an auth-tainted request. Inspect the returned cache evidence.
- The form includes the platform CSRF field. Do not remove it or replace caller-scoped `db()` with `adminDb()`.

The local tests verify handler auth/validation boundaries using a stub database and check built artifacts. They do not claim to execute Postgres RLS, hosted login, or CDN cache behavior; the two-user browser checks above are live acceptance.

## Edit the CMS through the CLI

Only the operator edits article content in this example; the exposure policy grants public SELECT, not browser writes. Use the actual returned project ID and hostname:

```bash
run402 projects sql prj_example "UPDATE articles SET title = 'Updated article' WHERE slug = 'welcome'"
run402 projects use prj_example
run402 cache inspect https://my-notes-cms.run402.app/article
run402 cache invalidate https://my-notes-cms.run402.app/article
```

Read the cache command's returned status; invalidation is not deployment or an authorization grant. Replace the example hostname with the deployed host. For an image, upload through `run402 assets put ./hero.png --project prj_example`, store the complete returned AssetRef in `articles.hero_asset`, and let `Run402Image` render its variants. The seed deliberately has no external image dependency.

## Adapt or clean up

Keep owner-column RLS on private notes. Model editorial roles before adding browser CMS writes. Existing external apps can start from `../static-config-js` for public runtime config or `../../demos/dreamdrop` for a separate server/frontend integration; they need their own authentication design.

After authorized live acceptance, delete the disposable project with the CLI's documented confirmation flow (`run402 projects delete --help`). Keep production destinations and credentials out of this fixture.
